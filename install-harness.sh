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

migrate_legacy_pi_work_animation_config() {
	local legacy_config="$AGENT_CONFIG_INSTALL_HOME/.pi/agent/extensions/work-animation.json"
	local session_ui_config="$AGENT_CONFIG_INSTALL_HOME/.pi/agent/extensions/session-ui/config.json"

	if [ ! -f "$legacy_config" ]; then
		printf '0'
		return 0
	fi
	if [ ! -f "$session_ui_config" ]; then
		error "无法迁移旧 work-animation 配置：缺少 $session_ui_config"
		return 1
	fi
	if ! command -v node >/dev/null 2>&1; then
		error '无法迁移旧 work-animation 配置：缺少 node'
		return 1
	fi

	node - "$legacy_config" "$session_ui_config" <<'NODE'
const fs = require("node:fs");
const legacyPath = process.argv[2];
const configPath = fs.realpathSync(process.argv[3]);
let legacy;
try {
	legacy = JSON.parse(fs.readFileSync(legacyPath, "utf8"));
} catch {
	process.stdout.write("0");
	process.exit(0);
}
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
if (!config || typeof config !== "object" || Array.isArray(config)) {
	throw new Error("session-ui config root must be an object");
}
const previous =
	config.workAnimation &&
	typeof config.workAnimation === "object" &&
	!Array.isArray(config.workAnimation)
		? config.workAnimation
		: {};
const migrated = { ...previous };
let changed = false;
if (typeof legacy?.enabled === "boolean") {
	migrated.enabled = legacy.enabled;
	changed = true;
}
if (
	typeof legacy?.intervalMs === "number" &&
	Number.isFinite(legacy.intervalMs) &&
	legacy.intervalMs >= 100 &&
	legacy.intervalMs <= 500
) {
	migrated.intervalMs = Math.round(legacy.intervalMs);
	changed = true;
}
if (
	legacy?.widgetPlacement === "aboveEditor" ||
	legacy?.widgetPlacement === "belowEditor"
) {
	migrated.placement = legacy.widgetPlacement;
	changed = true;
}
if (changed) {
	config.workAnimation = migrated;
	const temporaryPath = `${configPath}.tmp-${process.pid}-${Date.now()}`;
	fs.writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
		encoding: "utf8",
		flag: "wx",
	});
	fs.chmodSync(temporaryPath, fs.statSync(configPath).mode);
	fs.renameSync(temporaryPath, configPath);
}
process.stdout.write(changed ? "1" : "0");
NODE
}

retire_legacy_pi_work_animation() {
	[ "${INSTALL_MANAGED_DECLINED:-0}" -eq 0 ] || return 0

	local relative_path target_path backup_path migrated_config
	local retired=0
	migrated_config="$(migrate_legacy_pi_work_animation_config)"
	for relative_path in \
		'.pi/agent/extensions/work-animation.ts' \
		'.pi/agent/extensions/work-animation.json'; do
		target_path="$AGENT_CONFIG_INSTALL_HOME/$relative_path"
		if [ ! -e "$target_path" ] && [ ! -L "$target_path" ]; then
			continue
		fi
		backup_path="$BACKUP_ROOT/pi-retired/$relative_path"
		mkdir -p "$(dirname "$backup_path")"
		mv "$target_path" "$backup_path"
		retired=1
	done

	if [ "$retired" -eq 1 ]; then
		INSTALL_MANAGED_CHANGED=1
		# shellcheck disable=SC2034 # Shared installer state used for backup reporting.
		BACKUP_CREATED=1
		if [ "$migrated_config" -eq 1 ]; then
			info "旧 work-animation 配置已继承，独立扩展已迁移到备份"
		else
			info "旧 work-animation 已迁移到备份，功能改由 session-ui 提供"
		fi
	fi
}

retire_removed_pi_image_gen() {
	[ "${INSTALL_MANAGED_DECLINED:-0}" -eq 0 ] || return 0

	local relative_path='.pi/agent/extensions/image-gen.ts'
	local target_path="$AGENT_CONFIG_INSTALL_HOME/$relative_path"
	local backup_path="$BACKUP_ROOT/pi-retired/$relative_path"

	if [ ! -e "$target_path" ] && [ ! -L "$target_path" ]; then
		return 0
	fi

	mkdir -p "$(dirname "$backup_path")"
	mv "$target_path" "$backup_path"
	INSTALL_MANAGED_CHANGED=1
	# shellcheck disable=SC2034 # Shared installer state used for backup reporting.
	BACKUP_CREATED=1
	info "已停用的 image-gen 插件已从本机移除，原文件已迁移到备份"
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
	managed_entries() {
		printf '%s\n' \
			'harnesses/pi/agent/settings.json|.pi/agent/settings.json|file|-|配置|通用设置' \
			'harnesses/pi/agent/keybindings.json|.pi/agent/keybindings.json|file|-|配置|快捷键' \
			'harnesses/pi/agent/extensions/session-ui.ts|.pi/agent/extensions/session-ui.ts|file|-|插件|session-ui' \
			'harnesses/pi/agent/extensions/session-ui|.pi/agent/extensions/session-ui|directory|-|插件|session-ui' \
			'harnesses/pi/agent/extensions/openai-fast.json|.pi/agent/extensions/openai-fast.json|file|-|配置|OpenAI Fast' \
			'harnesses/pi/web-search.json|.pi/web-search.json|file|-|配置|Web Search' \
			'harnesses/pi/pi-lens/config.json|.pi-lens/config.json|file|-|配置|Pi Lens'
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
if [ "$HARNESS_ID" = 'pi' ]; then
	retire_legacy_pi_work_animation
	retire_removed_pi_image_gen
fi
if [ "${INSTALL_MANAGED_CHANGED:-0}" -eq 1 ]; then
	success "$HARNESS_LABEL 配置安装完成"
fi
