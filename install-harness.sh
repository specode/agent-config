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
	info "旧的本地 image-gen 扩展已迁移到备份，功能改由 npm:@specode/pi-subscription-image 提供"
}

legacy_pi_openai_fast_present() {
	local agent_dir="$1"
	local package_name='@diegopetrucci/pi-openai-fast'
	local package_dir="$agent_dir/npm/node_modules/$package_name"
	local npm_manifest="$agent_dir/npm/package.json"
	if [ -e "$package_dir" ] || [ -L "$package_dir" ]; then
		printf '1'
		return 0
	fi
	if [ ! -f "$npm_manifest" ]; then
		printf '0'
		return 0
	fi
	if ! command -v node >/dev/null 2>&1; then
		error '检查旧 OpenAI Fast 安装需要 node；新配置已安装，请补齐后重试'
		return 1
	fi
	node - "$npm_manifest" "$package_name" <<'NODE'
const fs = require("node:fs");
try {
	const manifest = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
	const name = process.argv[3];
	const declared = ["dependencies", "devDependencies", "optionalDependencies"]
		.some((key) => manifest?.[key] && Object.hasOwn(manifest[key], name));
	process.stdout.write(declared ? "1" : "0");
} catch {
	console.error("Cannot read the Pi npm manifest; package cleanup was not attempted");
	process.exitCode = 1;
}
NODE
}

retire_removed_pi_openai_fast() {
	[ "${INSTALL_MANAGED_DECLINED:-0}" -eq 0 ] || return 0

	local agent_dir="$AGENT_CONFIG_INSTALL_HOME/.pi/agent"
	local package_name='@diegopetrucci/pi-openai-fast'
	local package_dir="$agent_dir/npm/node_modules/$package_name"
	local backup_dir="$BACKUP_ROOT/pi-retired/openai-fast-package"
	local present name remove_status=0
	present="$(legacy_pi_openai_fast_present "$agent_dir")"
	[ "$present" = '1' ] || return 0

	if ! command -v pi >/dev/null 2>&1; then
		error '卸载旧 OpenAI Fast 需要 pi；新配置已安装，请补齐后重试'
		return 1
	fi

	mkdir -p "$backup_dir"
	for name in package.json package-lock.json; do
		if [ -f "$agent_dir/npm/$name" ]; then
			cp -p "$agent_dir/npm/$name" "$backup_dir/$name"
		fi
	done
	if [ -e "$package_dir" ] || [ -L "$package_dir" ]; then
		cp -Rp "$package_dir" "$backup_dir/previous-package"
	fi
	# shellcheck disable=SC2034 # Shared installer state used for backup reporting.
	BACKUP_CREATED=1

	info "卸载旧插件 npm:$package_name"
	(
		cd "$AGENT_CONFIG_INSTALL_HOME" || exit 1
		PI_CODING_AGENT_DIR="$agent_dir" PI_OFFLINE=1 \
			npm_config_ignore_scripts=true npm_config_audit=false npm_config_fund=false \
			pi remove "npm:$package_name" --no-approve
	) || remove_status=$?
	present="$(legacy_pi_openai_fast_present "$agent_dir")"
	if [ "$present" = '1' ]; then
		error "旧 OpenAI Fast 卸载失败，仍有残留（命令退出码 ${remove_status}）；新配置保留，备份位于 ${backup_dir}。修复后重跑安装器"
		return 1
	fi
	# Pi may return nonzero after successful uninstall when settings were already migrated.
	if [ "$remove_status" -ne 0 ]; then
		warn "Pi remove 返回 ${remove_status}；已复核旧包目录及 npm 依赖声明均已移除"
	fi
	INSTALL_MANAGED_CHANGED=1
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
			'harnesses/pi/agent/extensions/openai-fast|.pi/agent/extensions/openai-fast|directory|-|插件|OpenAI Fast' \
			'harnesses/pi/agent/extensions/openai-fast.json|.pi/agent/extensions/openai-fast.json|file|-|配置|OpenAI Fast' \
			'harnesses/pi/agent/extensions/subagent/config.json|.pi/agent/extensions/subagent/config.json|file|-|配置|子代理策略' \
			'harnesses/pi/agent/profiles/pi-subagents/multimodel-ggk.json|.pi/agent/profiles/pi-subagents/multimodel-ggk.json|file|-|配置|多模型 Profile' \
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
	retire_removed_pi_openai_fast
fi
if [ "${INSTALL_MANAGED_CHANGED:-0}" -eq 1 ]; then
	success "$HARNESS_LABEL 配置安装完成"
fi
