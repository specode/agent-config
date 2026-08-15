#!/usr/bin/env bash

set -euo pipefail

AGENT_CONFIG_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/install-managed.sh
source "$AGENT_CONFIG_ROOT/lib/install-managed.sh"

usage() {
	cat <<'EOF'
用法：./install-rules.sh

将同一份全局 harness rules 安装到各 harness 的规则路径。
若检测到内容冲突，会先显示差异，再按整组询问是否备份并覆盖。
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
	error "未知参数：$1"
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
success 'Harness rules 安装完成'
