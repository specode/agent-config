#!/usr/bin/env bash

set -euo pipefail

AGENT_CONFIG_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/install-managed.sh
source "$AGENT_CONFIG_ROOT/lib/install-managed.sh"

INSTALL_OUTPUT_MODE='summary'

usage() {
	cat <<'EOF'
Usage: ./install-harness.sh <harness>
       ./install-harness.sh --list

Available harnesses:
  claude-code
  pi
EOF
}

prepare_pi_session_ui() {
	local source="$AGENT_CONFIG_ROOT/harnesses/pi/builtins/session-ui"
	local config="$AGENT_CONFIG_ROOT/harnesses/pi/plugin-configs/session-ui/config.json"

	if ! command -v rsync >/dev/null 2>&1; then
		error 'rsync is required to install managed directories'
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
		error 'Claude Code status line requires jq; please install jq first'
		exit 1
	fi
	HARNESS_LABEL='Claude Code'
	managed_entries() {
		printf '%s\n' \
			'harnesses/claude-code/settings.json|.claude/settings.json|file|-|config|general settings' \
			'harnesses/claude-code/keybindings.json|.claude/keybindings.json|file|-|config|keybindings' \
			'harnesses/claude-code/statusline-command.sh|.claude/statusline-command.sh|file|-|plugin|status line'
	}
	;;
pi)
	HARNESS_LABEL='Pi'
	prepare_pi_session_ui
	managed_entries() {
		printf '%s\n' \
			'harnesses/pi/config/settings.json|.pi/agent/settings.json|file|-|config|general settings' \
			'harnesses/pi/config/models.json|.pi/agent/models.json|file|-|config|model overrides' \
			'harnesses/pi/config/keybindings.json|.pi/agent/keybindings.json|file|-|config|keybindings' \
			"$PI_SESSION_UI_SOURCE|.pi/agent/extensions/session-ui|directory|-|plugin|session-ui" \
			'harnesses/pi/builtins/fast|.pi/agent/extensions/fast|directory|-|plugin|Fast' \
			'harnesses/pi/plugin-configs/fast/config.json|.pi/agent/extensions/fast.json|file|-|config|Fast' \
			'harnesses/pi/plugin-configs/pi-fff/config.json|.pi/agent/pi-fff.json|file|-|config|FFF' \
			'harnesses/pi/plugin-configs/web-search/config.json|.pi/agent/web-search.json|file|-|config|Web Search' \
			'harnesses/pi/plugin-configs/claude-bridge/config.json|.pi/agent/claude-bridge.json|file|-|config|Claude Bridge'
	}
	;;
-h | --help)
	usage
	exit 0
	;;
*)
	usage >&2
	error "Unknown harness: $HARNESS_ID"
	exit 1
	;;
esac

install_managed_group "$HARNESS_ID" "$HARNESS_LABEL"
if [ "${INSTALL_MANAGED_CHANGED:-0}" -eq 1 ]; then
	success "$HARNESS_LABEL configuration installed"
fi
