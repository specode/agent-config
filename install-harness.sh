#!/usr/bin/env bash

set -euo pipefail

AGENT_CONFIG_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/install-managed.sh
source "$AGENT_CONFIG_ROOT/lib/install-managed.sh"

INSTALL_OUTPUT_MODE='summary'

usage() {
	cat <<'EOF'
用法：./install-harness.sh <harness>
      ./install-harness.sh --list

可安装的 harness：
  claude-code
  pi
EOF
}

prepare_pi_session_ui() {
	local source="$AGENT_CONFIG_ROOT/harnesses/pi/builtins/session-ui"
	local config="$AGENT_CONFIG_ROOT/harnesses/pi/plugin-configs/session-ui/config.json"

	if ! command -v rsync >/dev/null 2>&1; then
		error '安装托管目录需要 rsync'
		return 1
	fi
	validate_repository_source "$source" directory
	validate_repository_source "$config" file
	PI_SESSION_UI_SOURCE="$INSTALL_TEMP_ROOT/pi/session-ui"
	# Compose code and config before comparison; deploy one non-overlapping directory.
	copy_managed_path "$source" "$PI_SESSION_UI_SOURCE" directory
	copy_managed_path "$config" "$PI_SESSION_UI_SOURCE/config.json" file
}

if [ "${1:-}" = '--list' ]; then
	printf '%s\n' 'claude-code' 'pi'
	exit 0
fi

if [ "$#" -ne 1 ]; then
	usage >&2
	exit 1
fi

HARNESS_ID="$1"

case "$HARNESS_ID" in
claude-code)
	if ! command -v jq >/dev/null 2>&1; then
		error 'Claude Code 状态栏依赖 jq；请先安装 jq'
		exit 1
	fi
	HARNESS_LABEL='Claude Code'
	managed_entries() {
		printf '%s\n' \
			'harnesses/claude-code/settings.json|.claude/settings.json|file|-|配置|通用设置' \
			'harnesses/claude-code/keybindings.json|.claude/keybindings.json|file|-|配置|快捷键' \
			'harnesses/claude-code/statusline-command.sh|.claude/statusline-command.sh|file|-|插件|状态栏'
	}
	;;
pi)
	HARNESS_LABEL='Pi'
	prepare_pi_session_ui
	managed_entries() {
		printf '%s\n' \
			'harnesses/pi/config/settings.json|.pi/agent/settings.json|file|-|配置|通用设置' \
			'harnesses/pi/config/models.json|.pi/agent/models.json|file|-|配置|模型覆盖' \
			'harnesses/pi/config/keybindings.json|.pi/agent/keybindings.json|file|-|配置|快捷键' \
			"$PI_SESSION_UI_SOURCE|.pi/agent/extensions/session-ui|directory|-|插件|session-ui" \
			'harnesses/pi/builtins/fast|.pi/agent/extensions/fast|directory|-|插件|Fast' \
			'harnesses/pi/plugin-configs/fast/config.json|.pi/agent/extensions/fast.json|file|-|配置|Fast' \
			'harnesses/pi/plugin-configs/pi-fff/config.json|.pi/agent/pi-fff.json|file|-|配置|FFF' \
			'harnesses/pi/plugin-configs/interactive-shell/config.json|.pi/agent/interactive-shell.json|file|-|配置|Interactive Shell' \
			'harnesses/pi/plugin-configs/web-search/config.json|.pi/agent/web-search.json|file|-|配置|Web Search'
	}
	;;
-h | --help)
	usage
	exit 0
	;;
*)
	usage >&2
	error "未知 harness：$HARNESS_ID"
	exit 1
	;;
esac

install_managed_group "$HARNESS_ID" "$HARNESS_LABEL"
if [ "${INSTALL_MANAGED_CHANGED:-0}" -eq 1 ]; then
	success "$HARNESS_LABEL 配置安装完成"
fi
