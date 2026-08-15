#!/usr/bin/env bash

# Shared transactional installer for rules and harness configuration.
# Callers define managed_entries, then call install_managed_group.

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info() {
	printf "${BLUE}==>${NC} %s\n" "$1"
}

success() {
	printf "${GREEN}==>${NC} %s\n" "$1"
}

warn() {
	printf "${YELLOW}==>${NC} %s\n" "$1"
}

error() {
	printf "${RED}==>${NC} %s\n" "$1" >&2
}

RSYNC_EXCLUDES=(
	'--exclude=.git/'
	'--exclude=node_modules/'
	'--exclude=.DS_Store'
	'--exclude=*.log'
	'--exclude=*.swp'
	'--exclude=*.swo'
	'--exclude=*~'
	'--exclude=.#*'
)

DIFF_EXCLUDES=(
	'-x' '.git'
	'-x' 'node_modules'
	'-x' '.DS_Store'
	'-x' '*.log'
	'-x' '*.swp'
	'-x' '*.swo'
	'-x' '*~'
	'-x' '.#*'
)

AGENT_CONFIG_INSTALL_HOME="${AGENT_CONFIG_INSTALL_HOME:-$HOME}"
INSTALL_TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/agent-config-install.XXXXXX")"
BACKUP_ROOT="$AGENT_CONFIG_INSTALL_HOME/.agent-config-backups/$(date +%Y%m%d%H%M%S)-$$"
BACKUP_CREATED=0

cleanup_installer() {
	rm -rf -- "$INSTALL_TEMP_ROOT"
}
trap cleanup_installer EXIT

directory_is_equal() {
	diff -qr "${DIFF_EXCLUDES[@]}" "$1" "$2" >/dev/null 2>&1
}

show_file_diff() {
	local source="$1"
	local target="$2"

	diff -u --label "local: $target" --label "repo:  $source" "$target" "$source" || true
}

show_directory_diff() {
	local source="$1"
	local target="$2"

	diff -ru "${DIFF_EXCLUDES[@]}" "$target" "$source" || true
}

validate_repository_source() {
	local source="$1"
	local expected_type="$2"

	if [ -L "$source" ]; then
		error "仓库源文件不能是软链接：$source"
		return 1
	fi

	case "$expected_type" in
	file)
		[ -f "$source" ] || {
			error "缺少仓库文件：$source"
			return 1
		}
		;;
	directory)
		[ -d "$source" ] || {
			error "缺少仓库目录：$source"
			return 1
		}
		;;
	*)
		error "未知的托管路径类型：$expected_type"
		return 1
		;;
	esac
}

is_expected_repository_link() {
	local target="$1"
	local source="$2"

	[ -L "$target" ] && [ -e "$target" ] && [ "$target" -ef "$source" ]
}

managed_file_mode_matches() {
	local target_path="$1"
	local expected_mode="$2"
	local actual_mode

	[ "$expected_mode" != '-' ] || return 0

	if actual_mode="$(stat -f '%Lp' "$target_path" 2>/dev/null)"; then
		:
	elif actual_mode="$(stat -c '%a' "$target_path" 2>/dev/null)"; then
		:
	else
		return 1
	fi

	[ "$actual_mode" = "$expected_mode" ]
}

copy_managed_path() {
	local source="$1"
	local target="$2"
	local expected_type="$3"
	local parent temporary

	parent="$(dirname "$target")"
	mkdir -p "$parent" || return 1

	case "$expected_type" in
	file)
		temporary="$(mktemp "$parent/.agent-config-install.XXXXXX")" || return 1
		if ! cp -p "$source" "$temporary"; then
			rm -f -- "$temporary"
			return 1
		fi
		if ! mv -f "$temporary" "$target"; then
			rm -f -- "$temporary"
			return 1
		fi
		;;
	directory)
		temporary="$(mktemp -d "$parent/.agent-config-install.XXXXXX")" || return 1
		if ! rsync -a "${RSYNC_EXCLUDES[@]}" "$source/" "$temporary/"; then
			rm -rf -- "$temporary"
			return 1
		fi
		if ! mv "$temporary" "$target"; then
			rm -rf -- "$temporary"
			return 1
		fi
		;;
	esac
}

stage_group_paths() {
	local manifest="$1"
	local staging_root="$2"
	local repository_path local_path expected_type _expected_mode

	mkdir -p "$staging_root" || return 1
	while IFS='|' read -r repository_path local_path expected_type _expected_mode; do
		copy_managed_path \
			"$AGENT_CONFIG_ROOT/$repository_path" \
			"$staging_root/$local_path" \
			"$expected_type" || return 1
	done <"$manifest"
}

snapshot_existing_paths() {
	local manifest="$1"
	local originals_log="$2"
	local _repository_path local_path _expected_type _expected_mode target_path

	: >"$originals_log" || return 1
	while IFS='|' read -r _repository_path local_path _expected_type _expected_mode; do
		target_path="$AGENT_CONFIG_INSTALL_HOME/$local_path"
		if [ -e "$target_path" ] || [ -L "$target_path" ]; then
			printf '%s\n' "$local_path" >>"$originals_log" || return 1
		fi
	done <"$manifest"
}

backup_group_paths() {
	local manifest="$1"
	local group_id="$2"
	local _repository_path local_path _expected_type _expected_mode
	local target_path backup_path

	while IFS='|' read -r _repository_path local_path _expected_type _expected_mode; do
		target_path="$AGENT_CONFIG_INSTALL_HOME/$local_path"
		if [ -e "$target_path" ] || [ -L "$target_path" ]; then
			backup_path="$BACKUP_ROOT/$group_id/$local_path"
			mkdir -p "$(dirname "$backup_path")" || return 1
			mv "$target_path" "$backup_path" || return 1
			BACKUP_CREATED=1
			printf '  已备份 %s -> %s\n' "$target_path" "$backup_path"
		fi
	done <"$manifest"
}

install_staged_paths() {
	local manifest="$1"
	local staging_root="$2"
	local _repository_path local_path expected_type expected_mode

	while IFS='|' read -r _repository_path local_path expected_type expected_mode; do
		copy_managed_path \
			"$staging_root/$local_path" \
			"$AGENT_CONFIG_INSTALL_HOME/$local_path" \
			"$expected_type" || return 1

		if [ "$expected_mode" != '-' ]; then
			chmod "$expected_mode" "$AGENT_CONFIG_INSTALL_HOME/$local_path" || return 1
		fi
	done <"$manifest"
}

rollback_group_paths() {
	local manifest="$1"
	local group_id="$2"
	local originals_log="$3"
	local rollback_mode="$4"
	local discard_root="$INSTALL_TEMP_ROOT/rollback-discard/$group_id"
	local _repository_path local_path _expected_type _expected_mode
	local target_path backup_path discard_path
	local had_original backup_exists target_exists
	local rollback_failed=0

	while IFS='|' read -r _repository_path local_path _expected_type _expected_mode; do
		target_path="$AGENT_CONFIG_INSTALL_HOME/$local_path"
		backup_path="$BACKUP_ROOT/$group_id/$local_path"
		had_original=0
		backup_exists=0
		target_exists=0

		if grep -Fqx "$local_path" "$originals_log"; then had_original=1; fi
		if [ -e "$backup_path" ] || [ -L "$backup_path" ]; then backup_exists=1; fi
		if [ -e "$target_path" ] || [ -L "$target_path" ]; then target_exists=1; fi

		if [ "$rollback_mode" = 'install' ] && [ "$target_exists" -eq 1 ]; then
			discard_path="$discard_root/$local_path"
			if ! mkdir -p "$(dirname "$discard_path")" || ! mv "$target_path" "$discard_path"; then
				error "回滚时无法清理新安装的路径：$target_path"
				rollback_failed=1
				continue
			fi
			target_exists=0
		fi

		if [ "$backup_exists" -eq 1 ]; then
			if [ "$target_exists" -eq 1 ]; then
				error "回滚目标被意外占用：$target_path"
				rollback_failed=1
				continue
			fi
			if ! mkdir -p "$(dirname "$target_path")" || ! mv "$backup_path" "$target_path"; then
				error "无法恢复原配置：$target_path"
				rollback_failed=1
			fi
		elif [ "$had_original" -eq 1 ] && [ "$target_exists" -eq 0 ]; then
			error "未找到原配置或其备份：$target_path"
			rollback_failed=1
		fi
	done <"$manifest"

	[ "$rollback_failed" -eq 0 ]
}

deploy_group_transaction() {
	local manifest="$1"
	local group_id="$2"
	local label="$3"
	local staging_root="$INSTALL_TEMP_ROOT/staged/$group_id"
	local originals_log="$INSTALL_TEMP_ROOT/originals.$group_id"
	local _repository_path local_path _expected_type _expected_mode

	info "准备 $label 的完整配置集"
	if ! stage_group_paths "$manifest" "$staging_root"; then
		error "$label 准备失败，本机配置未改变"
		return 1
	fi

	if ! snapshot_existing_paths "$manifest" "$originals_log"; then
		error "$label 本机状态记录失败，本机配置未改变"
		return 1
	fi

	if ! backup_group_paths "$manifest" "$group_id"; then
		error "$label 备份失败，正在恢复已移动的路径"
		rollback_group_paths "$manifest" "$group_id" "$originals_log" backup ||
			error "$label 回滚不完整，请检查 $BACKUP_ROOT/$group_id"
		return 1
	fi

	if ! install_staged_paths "$manifest" "$staging_root"; then
		error "$label 安装失败，正在恢复原配置"
		rollback_group_paths "$manifest" "$group_id" "$originals_log" install ||
			error "$label 回滚不完整，请检查 $BACKUP_ROOT/$group_id"
		return 1
	fi

	while IFS='|' read -r _repository_path local_path _expected_type _expected_mode; do
		success "已复制 $AGENT_CONFIG_INSTALL_HOME/$local_path"
	done <"$manifest"
}

install_managed_group() {
	local group_id="$1"
	local label="$2"
	local manifest="$INSTALL_TEMP_ROOT/manifest.$group_id"
	local repository_path local_path expected_type expected_mode
	local source_path target_path actual_mode answer
	local group_missing=0
	local group_legacy_links=0
	local group_conflict=0

	managed_entries >"$manifest"
	if [ ! -s "$manifest" ]; then
		error "$label 没有定义任何托管配置"
		return 1
	fi

	if grep -q '|directory|' "$manifest" && ! command -v rsync >/dev/null 2>&1; then
		error "安装托管目录需要 rsync"
		return 1
	fi

	info "比较仓库配置与本机配置"
	printf '\n%s：\n' "$label"
	while IFS='|' read -r repository_path local_path expected_type expected_mode; do
		source_path="$AGENT_CONFIG_ROOT/$repository_path"
		target_path="$AGENT_CONFIG_INSTALL_HOME/$local_path"
		validate_repository_source "$source_path" "$expected_type"

		if [ ! -e "$target_path" ] && [ ! -L "$target_path" ]; then
			printf '  [缺失] %s\n' "$target_path"
			group_missing=1
			continue
		fi

		if [ -L "$target_path" ]; then
			if is_expected_repository_link "$target_path" "$source_path"; then
				printf '  [旧版仓库软链接] %s\n' "$target_path"
				group_legacy_links=1
			else
				printf '  [软链接冲突] %s -> %s\n' "$target_path" "$(readlink "$target_path" 2>/dev/null || printf '?')"
				group_conflict=1
			fi
			continue
		fi

		case "$expected_type" in
		file)
			if [ ! -f "$target_path" ]; then
				printf '  [类型冲突] 预期为文件：%s\n' "$target_path"
				group_conflict=1
			elif cmp -s "$source_path" "$target_path"; then
				if managed_file_mode_matches "$target_path" "$expected_mode"; then
					printf '  [一致] %s\n' "$target_path"
				else
					actual_mode="$(stat -f '%Lp' "$target_path" 2>/dev/null || stat -c '%a' "$target_path" 2>/dev/null || printf '?')"
					printf '  [权限漂移] %s（当前 %s，预期 %s）\n' "$target_path" "$actual_mode" "$expected_mode"
					group_missing=1
				fi
			else
				printf '  [内容不同] %s\n' "$target_path"
				show_file_diff "$source_path" "$target_path"
				group_conflict=1
			fi
			;;
		directory)
			if [ ! -d "$target_path" ]; then
				printf '  [类型冲突] 预期为目录：%s\n' "$target_path"
				group_conflict=1
			elif directory_is_equal "$source_path" "$target_path"; then
				printf '  [一致] %s\n' "$target_path"
			else
				printf '  [内容不同] %s\n' "$target_path"
				show_directory_diff "$source_path" "$target_path"
				group_conflict=1
			fi
			;;
		esac
	done <"$manifest"

	printf '\n'
	if [ "$group_conflict" -eq 1 ]; then
		printf '是否用仓库配置替换 %s 的全部托管路径？\n' "$label"
		printf '  y = 先备份，再整组覆盖\n'
		printf '  N = 整组保持不变（包括当前缺失的路径）[y/N] '
		if ! IFS= read -r answer; then
			printf '\n' >&2
			error "无法读取确认，本机文件未改变"
			return 1
		fi
		case "$answer" in
		y | Y | yes | YES | Yes) ;;
		*)
			info "$label 已整组保持不变"
			return 0
			;;
		esac
	elif [ "$group_missing" -eq 0 ] && [ "$group_legacy_links" -eq 0 ]; then
		success "$label 已与仓库一致"
		return 0
	else
		info "$label 没有本机冲突，将自动安装完整配置集"
	fi

	deploy_group_transaction "$manifest" "$group_id" "$label"
	if [ "$BACKUP_CREATED" -eq 1 ]; then
		info "原本机文件保存在 $BACKUP_ROOT"
	fi
}
