#!/usr/bin/env bash
# Claude Code statusline (single line), laid out like Pi's session-ui footer
# model effort / cwd branch / context usage / 5h + 7d quota with reset / cache hit rate
# Uses Nerd Font glyphs and only the standard ANSI 8-color palette + default
# foreground, so both light and dark terminal themes stay readable (bright-black
# and dim render nearly invisible on light backgrounds — do not use them).

input=$(cat)

# ---- colors (printf, ANSI 16-color so terminal theme adapts them for light/dark) ----
c_reset=$(printf '\033[0m')
c_bold=$(printf '\033[1m')
c_blue=$(printf '\033[34m')
c_cyan=$(printf '\033[36m')
c_magenta=$(printf '\033[35m')
c_yellow=$(printf '\033[33m')
c_green=$(printf '\033[32m')
c_red=$(printf '\033[31m')

# ---- Nerd Font icons ----
# Defined via explicit UTF-8 bytes: these are private-use-area codepoints that
# some editors/tools silently strip when pasted as literal characters.
i_model=$(printf '\xef\x8b\x9b')   # U+F2DB nf-fa-microchip
i_effort=$(printf '\xef\x83\xa7')  # U+F0E7 nf-fa-bolt
i_dir=$(printf '\xef\x81\xbb')     # U+F07B nf-fa-folder
i_branch=$(printf '\xee\x82\xa0')  # U+E0A0 powerline git branch
i_ctx=$(printf '\xef\x87\x80')     # U+F1C0 nf-fa-database
i_5h=$(printf '\xef\x80\x97')      # U+F017 nf-fa-clock-o
i_7d=$(printf '\xef\x81\xb3')      # U+F073 nf-fa-calendar
i_sep=$(printf '\xee\x82\xb1')     # U+E0B1 powerline thin chevron
i_cache=$(printf '\xef\x92\x9b')   # U+F49B nf-oct-zap
i_reset=$(printf '\xe2\x86\xbb')   # U+21BB clockwise arrow (plain unicode)

# ---- extract fields (one jq call; \x1f keeps empty fields, unlike tab) ----
IFS=$'\x1f' read -r model effort thinking cwd ctx_pct ctx_size \
  five_pct five_reset week_pct week_reset cache_now cache_session < <(
  printf '%s' "$input" | jq -r '
    def num: if type == "number" then tostring else "" end;
    (.context_window.current_usage // {}) as $u
    | (($u.input_tokens // 0) + ($u.cache_read_input_tokens // 0)
        + ($u.cache_creation_input_tokens // 0)) as $prompt
    | [
        (.model.display_name // "unknown"),
        (.effort.level // ""),
        (.thinking.enabled == true | tostring),
        (.workspace.current_dir // .cwd // ""),
        (.context_window.used_percentage | num),
        (.context_window.context_window_size | num),
        (.rate_limits.five_hour.used_percentage | num),
        (.rate_limits.five_hour.resets_at // "" | tostring),
        (.rate_limits.seven_day.used_percentage | num),
        (.rate_limits.seven_day.resets_at // "" | tostring),
        (if $prompt > 0 then ($u.cache_read_input_tokens // 0) * 100 / $prompt | tostring else "" end),
        (if .prompt_cache.hit_ratio | type == "number" then .prompt_cache.hit_ratio * 100 | tostring else "" end)
      ] | join("\u001f")'
)
# abbreviate $HOME to ~ but keep the full path
dirdisp=${cwd/#$HOME/\~}

# ---- git branch (skip optional locks; silent if not a repo) ----
branch=""
if [ -n "$cwd" ] && git -C "$cwd" --no-optional-locks rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  branch=$(git -C "$cwd" --no-optional-locks branch --show-current 2>/dev/null)
  if [ -z "$branch" ]; then
    branch=$(git -C "$cwd" --no-optional-locks rev-parse --short HEAD 2>/dev/null)
  fi
fi

# ---- thinking / effort label ----
effort_label=""
if [ -n "$effort" ]; then
  effort_label="$effort"
elif [ "$thinking" = "true" ]; then
  effort_label="thinking"
fi

# ---- helper: resets_at (epoch seconds or ISO 8601) -> epoch seconds ----
to_epoch() {
  local ts="$1" iso
  case "$ts" in ''|null) return 1 ;; esac
  if [[ "$ts" =~ ^[0-9]+(\.[0-9]+)?$ ]]; then
    printf '%s' "${ts%.*}"
    return 0
  fi
  # normalize ISO 8601: drop fractional seconds, Z -> +0000, +HH:MM -> +HHMM
  iso=$(printf '%s' "$ts" | sed -E 's/\.[0-9]+//; s/Z$/+0000/; s/([+-][0-9]{2}):([0-9]{2})$/\1\2/')
  if date -j >/dev/null 2>&1; then
    date -j -f '%Y-%m-%dT%H:%M:%S%z' "$iso" +%s 2>/dev/null
  else
    date -d "$ts" +%s 2>/dev/null
  fi
}

# ---- helper: resets_at -> "XdYh" / "XhYm" / "Ym" remaining (empty if unparsable) ----
fmt_remaining() {
  local target now diff days hours mins
  target=$(to_epoch "$1") || return 0
  [ -z "$target" ] && return 0
  now=$(date +%s)
  diff=$(( target - now ))
  if [ "$diff" -le 0 ]; then
    printf 'now'
    return
  fi
  days=$(( diff / 86400 ))
  hours=$(( (diff % 86400) / 3600 ))
  mins=$(( (diff % 3600) / 60 ))
  if [ "$days" -gt 0 ]; then
    printf '%dd%dh' "$days" "$hours"
  elif [ "$hours" -gt 0 ]; then
    printf '%dh%dm' "$hours" "$mins"
  else
    printf '%dm' "$mins"
  fi
}

# ---- helper: token count -> Pi's formatTokens (999 / 1.5k / 1.00M) ----
fmt_tokens() {
  awk -v n="$1" 'BEGIN {
    if (n < 1000) printf "%d", n
    else if (n < 1000000) printf "%.1fk", n / 1000
    else printf "%.2fM", n / 1000000
  }'
}

# ---- helper: remaining percentage -> color (Pi: >=50 green, >=25 yellow) ----
remaining_color() {
  local rem_int=${1%%.*}
  if [ "$rem_int" -ge 50 ]; then
    printf '%s' "$c_green"
  elif [ "$rem_int" -ge 25 ]; then
    printf '%s' "$c_yellow"
  else
    printf '%s' "$c_red"
  fi
}

# ---- helper: usage percentage -> color ----
pct_color() {
  local pct_int=${1%%.*}
  if [ -z "$pct_int" ]; then
    printf ''
  elif [ "$pct_int" -ge 80 ]; then
    printf '%s' "$c_red"
  elif [ "$pct_int" -ge 50 ]; then
    printf '%s' "$c_yellow"
  else
    printf '%s' "$c_green"
  fi
}

# ---- layout ----
# Every segment follows one pattern: <colored icon> <value>, quota windows add
# a "↻ remaining". Segments are joined with a blue powerline chevron; like Pi,
# model+effort and dir+branch are paired with a single space instead.
sep="  ${c_blue}${i_sep}${c_reset}  "

join_segs() {
  local out="" s
  for s in "$@"; do
    [ -z "$s" ] && continue
    if [ -n "$out" ]; then out="${out}${sep}"; fi
    out="${out}${s}"
  done
  printf '%s' "$out"
}

join_pair() {
  if [ -n "$1" ] && [ -n "$2" ]; then
    printf '%s %s' "$1" "$2"
  else
    printf '%s' "$1$2"
  fi
}

# quota window: blue icon, label (default fg), remaining percentage (remaining-based color, bold), reset (default fg)
quota_seg() {
  local icon="$1" label="$2" pct="$3" resets="$4"
  local rem_disp seg remaining
  [ -z "$pct" ] && return
  rem_disp=$(awk -v p="$pct" 'BEGIN { printf "%.0f", 100 - p }')
  seg="${c_blue}${icon}${c_reset} ${label} $(remaining_color "$rem_disp")${c_bold}${rem_disp}%${c_reset}"
  remaining=$(fmt_remaining "$resets")
  if [ -n "$remaining" ]; then
    seg="${seg} ${i_reset} ${remaining}"
  fi
  printf '%s' "$seg"
}

# ---- line 1: model / thinking level / cwd / git branch ----
seg_model="${c_blue}${i_model}${c_reset} ${c_bold}${model}${c_reset}"
seg_effort=""
[ -n "$effort_label" ] && seg_effort="${c_magenta}${i_effort}${c_reset} ${effort_label}"
seg_dir=""
[ -n "$dirdisp" ] && seg_dir="${c_cyan}${i_dir}${c_reset} ${dirdisp}"
seg_branch=""
[ -n "$branch" ] && seg_branch="${c_yellow}${i_branch}${c_reset} ${branch}"
# ---- context usage: <pct>/<window>, "?%" before the first response ----
seg_ctx=""
if [ -n "$ctx_pct" ]; then
  pct_disp=$(printf '%.0f' "$ctx_pct")
  seg_ctx="${c_green}${i_ctx}${c_reset} $(pct_color "$pct_disp")${c_bold}${pct_disp}%${c_reset}"
elif [ -n "$ctx_size" ]; then
  seg_ctx="${c_green}${i_ctx}${c_reset} ?%"
fi
if [ -n "$seg_ctx" ] && [ -n "$ctx_size" ]; then
  seg_ctx="${seg_ctx}/$(fmt_tokens "$ctx_size")"
fi

# ---- quota: 5h and 7d windows share one segment, two spaces apart ----
seg_5h=$(quota_seg "$i_5h" "5h" "$five_pct" "$five_reset")
seg_7d=$(quota_seg "$i_7d" "7d" "$week_pct" "$week_reset")
seg_quota="$seg_5h"
if [ -n "$seg_5h" ] && [ -n "$seg_7d" ]; then
  seg_quota="${seg_5h}  ${seg_7d}"
elif [ -n "$seg_7d" ]; then
  seg_quota="$seg_7d"
fi

# ---- cache hit rate: last request / whole session, "-" when unknown ----
seg_cache=""
if [ -n "$cache_now" ] || [ -n "$cache_session" ]; then
  fmt_rate() { [ -n "$1" ] && printf '%.0f%%' "$1" || printf -- '-'; }
  seg_cache="${c_green}${i_cache}${c_reset} $(fmt_rate "$cache_now")/$(fmt_rate "$cache_session")"
fi

# ---- single line: model effort / dir branch / ctx / quota / cache ----
join_segs "$(join_pair "$seg_model" "$seg_effort")" "$(join_pair "$seg_dir" "$seg_branch")" \
  "$seg_ctx" "$seg_quota" "$seg_cache"
