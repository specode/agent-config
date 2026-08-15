#!/usr/bin/env bash
# Claude Code statusline (single line)
# model / thinking level / cwd / git branch / context usage / 5-hour quota + reset / 7-day quota + reset
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
i_ctx=$(printf '\xef\x83\xa4')     # U+F0E4 nf-fa-tachometer
i_5h=$(printf '\xef\x80\x97')      # U+F017 nf-fa-clock-o
i_7d=$(printf '\xef\x81\xb3')      # U+F073 nf-fa-calendar
i_sep=$(printf '\xee\x82\xb1')     # U+E0B1 powerline thin chevron
i_reset=$(printf '\xe2\x86\xbb')   # U+21BB clockwise arrow (plain unicode)

# ---- extract fields ----
model=$(printf '%s' "$input" | jq -r '.model.display_name // "unknown"')
effort=$(printf '%s' "$input" | jq -r '.effort.level // empty')
thinking=$(printf '%s' "$input" | jq -r '.thinking.enabled // false')
cwd=$(printf '%s' "$input" | jq -r '.workspace.current_dir // .cwd // empty')
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
if [ -n "$effort" ] && [ "$effort" != "null" ]; then
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

# ---- context window usage ----
ctx_pct=$(printf '%s' "$input" | jq -r '.context_window.used_percentage // empty')

# ---- rate limits ----
five_pct=$(printf '%s' "$input" | jq -r '.rate_limits.five_hour.used_percentage // empty')
five_reset=$(printf '%s' "$input" | jq -r '.rate_limits.five_hour.resets_at // empty')
week_pct=$(printf '%s' "$input" | jq -r '.rate_limits.seven_day.used_percentage // empty')
week_reset=$(printf '%s' "$input" | jq -r '.rate_limits.seven_day.resets_at // empty')

# ---- layout ----
# Every segment follows one pattern: <colored icon> <value>, quota segments add
# a "↻ remaining". Segments are joined with a blue powerline chevron so
# spacing stays identical everywhere.
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

# quota segment: colored icon, label (default fg), remaining percentage (threshold color, bold), reset (default fg)
# color is still driven by usage (high usage = red) even though the number shown is remaining.
quota_seg() {
  local icon_color="$1" icon="$2" label="$3" pct="$4" resets="$5"
  local color rem_disp seg remaining
  [ -z "$pct" ] || [ "$pct" = "null" ] && return
  color=$(pct_color "$pct")
  rem_disp=$(awk -v p="$pct" 'BEGIN { printf "%.0f", 100 - p }')
  seg="${icon_color}${icon}${c_reset} ${label} ${color}${c_bold}${rem_disp}%${c_reset}"
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
# ---- context usage / 5h quota + reset / 7d quota + reset ----
seg_ctx=""
if [ -n "$ctx_pct" ] && [ "$ctx_pct" != "null" ]; then
  color=$(pct_color "$ctx_pct")
  pct_disp=$(printf '%.0f' "$ctx_pct")
  seg_ctx="${c_green}${i_ctx}${c_reset} ctx ${color}${c_bold}${pct_disp}%${c_reset}"
fi
seg_5h=$(quota_seg "$c_cyan" "$i_5h" "5h" "$five_pct" "$five_reset")
seg_7d=$(quota_seg "$c_magenta" "$i_7d" "7d" "$week_pct" "$week_reset")

# ---- single line: model / effort / dir / branch / ctx / 5h / 7d ----
join_segs "$seg_model" "$seg_effort" "$seg_dir" "$seg_branch" "$seg_ctx" "$seg_5h" "$seg_7d"
