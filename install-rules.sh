#!/usr/bin/env bash

set -euo pipefail

AGENT_CONFIG_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/install-managed.sh
source "$AGENT_CONFIG_ROOT/lib/install-managed.sh"

usage() {
	cat <<'EOF'
Usage: ./install-rules.sh

Install the shared global harness rules to each harness rule path.
If conflicts are detected, diffs are shown before prompting to back up and overwrite the group.
EOF
}

case "${1:-}" in
'') ;;
-h | --help)
	usage
	exit 0
	;;
*)
	usage >&2
	error "Unknown argument: $1"
	exit 1
	;;
esac

managed_entries() {
	printf '%s\n' \
		'rules/AGENTS.md|.agents/AGENTS.md|file|-' \
		'rules/AGENTS.md|.claude/CLAUDE.md|file|-' \
		'rules/AGENTS.md|.codex/AGENTS.md|file|-' \
		'rules/AGENTS.md|.pi/agent/AGENTS.md|file|-' \
		'rules/AGENTS.md|.grok/AGENTS.md|file|-'
}

install_managed_group 'rules' 'Harness rules'
success 'Harness rules installed'
