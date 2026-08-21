#!/usr/bin/env bash

set -euo pipefail

AGENT_CONFIG_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/install-managed.sh
source "$AGENT_CONFIG_ROOT/lib/install-managed.sh"

usage() {
	cat <<'EOF'
用法：./install-harness.sh <harness>
      ./install-harness.sh --list

可安装的 harness：
  claude-code
  pi
EOF
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
			'harnesses/claude-code/settings.json|.claude/settings.json|file|-' \
			'harnesses/claude-code/keybindings.json|.claude/keybindings.json|file|-' \
			'harnesses/claude-code/statusline-command.sh|.claude/statusline-command.sh|file|-'
	}
	;;
pi)
	HARNESS_LABEL='Pi'
	managed_entries() {
		printf '%s\n' \
			'harnesses/pi/agent/settings.json|.pi/agent/settings.json|file|-' \
			'harnesses/pi/agent/keybindings.json|.pi/agent/keybindings.json|file|-' \
			'harnesses/pi/agent/extensions/session-ui.ts|.pi/agent/extensions/session-ui.ts|file|-' \
			'harnesses/pi/agent/extensions/session-ui|.pi/agent/extensions/session-ui|directory|-' \
			'harnesses/pi/agent/extensions/work-animation.ts|.pi/agent/extensions/work-animation.ts|file|-' \
			'harnesses/pi/agent/extensions/work-animation.json|.pi/agent/extensions/work-animation.json|file|-' \
			'harnesses/pi/agent/extensions/image-gen.ts|.pi/agent/extensions/image-gen.ts|file|-' \
			'harnesses/pi/agent/extensions/openai-fast.json|.pi/agent/extensions/openai-fast.json|file|-' \
			'harnesses/pi/web-search.json|.pi/web-search.json|file|-' \
			'harnesses/pi/pi-lens/config.json|.pi-lens/config.json|file|-'
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
success "$HARNESS_LABEL 配置安装完成"
