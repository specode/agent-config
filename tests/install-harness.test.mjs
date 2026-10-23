import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
function fixture(t) {
 const root = mkdtempSync(join(tmpdir(), "agent-config-installer-test-"));
 t.after(() => rmSync(root, { recursive: true, force: true }));
 const home = join(root, "home"), agentDir = join(home, ".pi/agent");
 const bin = join(root, "bin"), log = join(root, "pi-calls.jsonl");
 mkdirSync(bin, { recursive: true });
 mkdirSync(agentDir, { recursive: true });
 writeFileSync(join(bin, "pi"), '#!/bin/sh\nprintf "unexpected call\\n" >> "$PI_TEST_CALL_LOG"\nexit 99\n', { mode: 0o755 });
 return { root, home, agentDir, bin, log };
}

function install(f, { input = "y\n", harness = "pi" } = {}) {
 return spawnSync("bash", [join(ROOT, "install-harness.sh"), harness], {
  cwd: ROOT, encoding: "utf8", input, timeout: 30_000,
  env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}`,
   HOME: join(f.root, "unrelated-home"), AGENT_CONFIG_INSTALL_HOME: f.home,
   PI_CODING_AGENT_DIR: join(f.root, "unrelated-agent"), PI_TEST_CALL_LOG: f.log },
 });
}

function assertSuccess(result) {
	assert.equal(result.error, undefined);
	assert.equal(result.status, 0, result.stdout + result.stderr);
}

function calls(f) {
	return existsSync(f.log)
		? readFileSync(f.log, "utf8").trim().split("\n").map(JSON.parse)
		: [];
}

function backupAgent(f) {
	const root = join(f.home, ".agent-config-backups");
	const backups = readdirSync(root);
	assert.equal(backups.length, 1);
	return join(root, backups[0], "pi/.pi/agent");
}

test("installs the remaining model order without Claude Bridge", (t) => {
	const f = fixture(t);
	assertSuccess(install(f));
	const settings = JSON.parse(readFileSync(join(f.agentDir, "settings.json"), "utf8"));
	assert.deepEqual(
		settings.enabledModels,
		[
			"openai-codex/gpt-6-astra",
			"openai-codex/gpt-6.1-sol",
			"xai/grok-4.7",
			"antigravity/gemini-4-argon",
			"antigravity/gemini-3.8-flash",
			"antigravity/claude-opus-5-5",
			"antigravity/claude-sonnet-5-5",
		],
	);
	assert.equal(settings.packages.includes("npm:pi-claude-bridge"), false);
});

test("installs only the two requested Codex context overrides", (t) => {
	const f = fixture(t);
	assertSuccess(install(f));
	const target = join(f.agentDir, "models.json");
	assert.equal(lstatSync(target).isSymbolicLink(), false);
	assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), {
		providers: {
			"openai-codex": {
				modelOverrides: {
					"gpt-6-astra": { contextWindow: 500000 },
					"gpt-6.1-sol": { contextWindow: 500000 },
				},
			},
		},
	});
});

test("model overrides require consent and back up the complete previous file", (t) => {
	const f = fixture(t);
	const target = join(f.agentDir, "models.json");
	const previous = '{"providers":{"custom":{"models":[{"id":"local"}]}}}\n';
	writeFileSync(target, previous);
	assertSuccess(install(f, { input: "n\n" }));
	assert.equal(readFileSync(target, "utf8"), previous);
	assert.equal(existsSync(join(f.home, ".agent-config-backups")), false);
	assertSuccess(install(f));
	assert.equal(readFileSync(join(backupAgent(f), "models.json"), "utf8"), previous);
	assert.equal(readFileSync(target, "utf8"), readFileSync(join(ROOT, "harnesses/pi/config/models.json"), "utf8"));
});

test("maps the three source categories to Pi runtime paths without installing inactive configs", (t) => {
	const f = fixture(t);
	assertSuccess(install(f));
	const files = {
		"config/settings.json": ".pi/agent/settings.json",
		"config/models.json": ".pi/agent/models.json",
		"config/keybindings.json": ".pi/agent/keybindings.json",
		"builtins/session-ui/index.ts": ".pi/agent/extensions/session-ui/index.ts",
		"builtins/session-ui/config.ts": ".pi/agent/extensions/session-ui/config.ts",
		"builtins/fast/index.ts": ".pi/agent/extensions/fast/index.ts",
		"plugin-configs/session-ui/config.json": ".pi/agent/extensions/session-ui/config.json",
		"plugin-configs/fast/config.json": ".pi/agent/extensions/fast.json",
		"plugin-configs/web-search/config.json": ".pi/agent/web-search.json",
		"plugin-configs/pi-fff/config.json": ".pi/agent/pi-fff.json",
	};
	for (const [source, target] of Object.entries(files)) {
		assert.equal(
			readFileSync(join(f.home, target), "utf8"),
			readFileSync(join(ROOT, "harnesses/pi", source), "utf8"),
			target,
		);
	}
	for (const path of ["builtins", "plugin-configs", "config", "automode.json", "extensions/session-ui.ts", "extensions/pi-auto-review", "extensions/pi-permission-system"]) {
		assert.equal(existsSync(join(f.agentDir, path)), false, path);
	}
	assert.deepEqual(
		readdirSync(join(f.agentDir, "extensions/session-ui")).sort(),
		[...readdirSync(join(ROOT, "harnesses/pi/builtins/session-ui")), "config.json"].sort(),
	);
	const settings = JSON.parse(readFileSync(join(f.agentDir, "settings.json"), "utf8"));
	assert.equal(settings.theme, "system");
	assert.deepEqual(settings.defaultTools, ["+codemode"]);
	assert.equal(settings.packages.includes("npm:pi-subagents"), false);
	assert.equal(settings.packages.includes("npm:pi-lens"), false);
	assert.equal(existsSync(join(f.home, ".pi-lens")), false);
	assert.equal(existsSync(join(ROOT, "harnesses/pi/plugin-configs/pi-lens")), false);
	assert.equal(Object.hasOwn(settings, "subagents"), false);
	for (const path of ["extensions/subagent", "profiles/pi-subagents", "pi-subagents"]) {
		assert.equal(existsSync(join(f.agentDir, path)), false, path);
	}
	assert.equal(existsSync(join(ROOT, "harnesses/pi/plugin-configs/pi-subagents")), false);
	assert.equal(existsSync(join(f.root, "unrelated-agent")), false);
	assertSuccess(install(f));
	assert.equal(existsSync(join(f.home, ".agent-config-backups")), false);
	assert.deepEqual(calls(f), []);
});

test("each builtin owns its index and all relative entry imports stay inside its directory", () => {
	const root = join(ROOT, "harnesses/pi/builtins");
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		assert.ok(entry.isDirectory(), entry.name);
		const source = readFileSync(join(root, entry.name, "index.ts"), "utf8");
		for (const [, relativePath] of source.matchAll(/from "(\.[^"]+)"/g)) {
			assert.ok(relativePath.startsWith("./"), relativePath);
			assert.ok(existsSync(join(root, entry.name, relativePath)), relativePath);
		}
	}
});

test("replaces managed plugin directories only after consent and backs up obsolete files", (t) => {
	const f = fixture(t);
	assertSuccess(install(f));
	const oldFiles = {
		"extensions/session-ui/obsolete.ts": "old session-ui module\n",
		"extensions/session-ui/AGENTS.md": "old local rules\n",
		"extensions/fast/obsolete.ts": "old fast module\n",
	};
	const configPath = join(f.agentDir, "extensions/session-ui/config.json");
	const oldConfig = '{"workAnimation":{"enabled":false}}\n';
	for (const [path, text] of Object.entries(oldFiles)) writeFileSync(join(f.agentDir, path), text);
	writeFileSync(configPath, oldConfig);
	writeFileSync(join(f.agentDir, "extensions/unrelated.ts"), "unrelated plugin\n");
	writeFileSync(join(f.agentDir, "auth.json"), "test credential sentinel\n");
	mkdirSync(join(f.agentDir, "sessions"));
	writeFileSync(join(f.agentDir, "sessions/keep.jsonl"), "session sentinel\n");

	assertSuccess(install(f, { input: "n\n" }));
	for (const [path, text] of Object.entries(oldFiles)) assert.equal(readFileSync(join(f.agentDir, path), "utf8"), text);
	assert.equal(readFileSync(configPath, "utf8"), oldConfig);
	assert.equal(existsSync(join(f.home, ".agent-config-backups")), false);

	assertSuccess(install(f));
	const backupRoot = join(f.home, ".agent-config-backups");
	const backups = readdirSync(backupRoot);
	assert.equal(backups.length, 1);
	const backupAgent = join(backupRoot, backups[0], "pi/.pi/agent");
	for (const [path, text] of Object.entries(oldFiles)) {
		assert.equal(existsSync(join(f.agentDir, path)), false);
		assert.equal(readFileSync(join(backupAgent, path), "utf8"), text);
	}
	assert.equal(readFileSync(join(backupAgent, "extensions/session-ui/config.json"), "utf8"), oldConfig);
	assert.equal(readFileSync(configPath, "utf8"), readFileSync(join(ROOT, "harnesses/pi/plugin-configs/session-ui/config.json"), "utf8"));
	assert.equal(readFileSync(join(f.agentDir, "extensions/unrelated.ts"), "utf8"), "unrelated plugin\n");
	assert.equal(readFileSync(join(f.agentDir, "auth.json"), "utf8"), "test credential sentinel\n");
	assert.equal(readFileSync(join(f.agentDir, "sessions/keep.jsonl"), "utf8"), "session sentinel\n");
	assertSuccess(install(f));
	assert.deepEqual(readdirSync(backupRoot), backups);
});

test("rolls back models, code and composed config if deployment fails", (t) => {
	const f = fixture(t);
	assertSuccess(install(f));
	const oldModels = '{"providers":{}}\n';
	writeFileSync(join(f.agentDir, "models.json"), oldModels);
	const target = join(f.agentDir, "extensions/session-ui");
	const oldConfig = '{"workAnimation":{"enabled":false}}\n';
	writeFileSync(join(target, "config.json"), oldConfig);
	writeFileSync(join(target, "obsolete.ts"), "old module\n");
	rmSync(join(target, "index.ts"));
	const marker = join(f.root, "failed-once");
	writeFileSync(join(f.bin, "mv"), `#!/usr/bin/env node
const fs = require("node:fs"), { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
if (args.at(-1) === ${JSON.stringify(target)} && !fs.existsSync(${JSON.stringify(marker)})) {
 fs.writeFileSync(${JSON.stringify(marker)}, "1");
 process.exit(1);
}
const result = spawnSync("mv", args, { stdio: "inherit", env: { ...process.env, PATH: ${JSON.stringify(process.env.PATH)} } });
process.exit(result.status ?? 1);
`, { mode: 0o755 });
	const result = install(f);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /安装失败/);
	assert.equal(readFileSync(join(f.agentDir, "models.json"), "utf8"), oldModels);
	assert.equal(existsSync(join(target, "index.ts")), false);
	assert.equal(readFileSync(join(target, "config.json"), "utf8"), oldConfig);
	assert.equal(readFileSync(join(target, "obsolete.ts"), "utf8"), "old module\n");
	assert.equal(readFileSync(join(target, "config.ts"), "utf8"), readFileSync(join(ROOT, "harnesses/pi/builtins/session-ui/config.ts"), "utf8"));
	assert.deepEqual(calls(f), []);
	assertSuccess(install(f));
	assert.equal(existsSync(join(target, "obsolete.ts")), false);
	assert.equal(existsSync(join(target, "index.ts")), true);
});

test("fresh and repeat installs deploy FFF config into the target agent directory", (t) => {
	const f = fixture(t);
	const source = readFileSync(
		join(ROOT, "harnesses/pi/plugin-configs/pi-fff/config.json"),
		"utf8",
	);
	assert.deepEqual(JSON.parse(source), {
		mode: "override",
		enableHomeDirScanning: false,
	});
	const target = join(f.agentDir, "pi-fff.json");
	assertSuccess(install(f));
	assert.equal(readFileSync(target, "utf8"), source);
	const settings = JSON.parse(readFileSync(join(f.agentDir, "settings.json")));
	assert.ok(settings.packages.includes("npm:@ff-labs/pi-fff"));
	assert.equal(existsSync(join(f.home, ".pi/pi-fff.json")), false);
	assert.equal(existsSync(join(f.root, "unrelated-agent")), false);
	assertSuccess(install(f));
	assert.equal(readFileSync(target, "utf8"), source);
	assert.equal(existsSync(join(f.home, ".agent-config-backups")), false);
	assert.deepEqual(calls(f), []);
});

test("FFF config conflicts require consent and preserve the previous config in backup", (t) => {
	const f = fixture(t);
	const target = join(f.agentDir, "pi-fff.json");
	const previous = JSON.stringify({
		mode: "tools-only",
		enableHomeDirScanning: true,
	});
	writeFileSync(target, previous);

	assertSuccess(install(f, { input: "n\n" }));
	assert.equal(readFileSync(target, "utf8"), previous);
	assert.equal(existsSync(join(f.home, ".agent-config-backups")), false);

	assertSuccess(install(f));
	assert.equal(
		readFileSync(target, "utf8"),
		readFileSync(join(ROOT, "harnesses/pi/plugin-configs/pi-fff/config.json"), "utf8"),
	);
	const backupRoot = join(f.home, ".agent-config-backups");
	const backups = readdirSync(backupRoot);
	assert.equal(backups.length, 1);
	assert.equal(
		readFileSync(
			join(backupRoot, backups[0], "pi/.pi/agent/pi-fff.json"),
			"utf8",
		),
		previous,
	);
	assert.deepEqual(calls(f), []);
});

test("installs web-search.json into the Pi agent directory", (t) => {
	const f = fixture(t);
	assertSuccess(install(f));
	assert.ok(existsSync(join(f.agentDir, "web-search.json")));
	assert.equal(existsSync(join(f.home, ".pi/web-search.json")), false);
	assert.match(
		readFileSync(join(f.agentDir, "web-search.json"), "utf8"),
		/auto-summary/,
	);
});


test("leaves unmanaged files, packages, caches and old configs untouched", (t) => {
 const f = fixture(t);
 const paths = [
  ".pi/agent/claude-bridge.json", ".pi/agent/extensions/session-ui.ts",
  ".pi/agent/extensions/openai-fast/index.ts", ".pi/agent/extensions/openai-fast.json",
  ".pi/agent/extensions/work-animation.ts", ".pi/agent/extensions/work-animation.json",
  ".pi/agent/extensions/image-gen.ts", ".pi/web-search.json",
  ".pi/agent/extensions/subagent/config.json", ".pi/agent/profiles/pi-subagents/profile.json",
  ".pi/agent/pi-subagents/last-seen-version.json", ".pi/agent/sol-pi.json",
  ".pi/agent/git/github.com/NVlabs/SoL-Pi/index.ts",
  ".pi/agent/sessions/project/sol-pi/cache", ".pi/agent/auth.json",
  ".pi/agent/npm/package.json", ".pi/agent/npm/package-lock.json",
  ...["@diegopetrucci/pi-openai-fast", "pi-mcp-adapter", "pi-subagents", "pi-claude-bridge"]
   .map(name => `.pi/agent/npm/node_modules/${name}/index.ts`),
 ];
 for (const path of paths) {
  mkdirSync(dirname(join(f.home, path)), { recursive: true });
  writeFileSync(join(f.home, path), "untouched sentinel\n");
 }
 for (let i = 0; i < 2; i++) {
  assertSuccess(install(f));
  for (const path of paths) assert.equal(readFileSync(join(f.home, path), "utf8"), "untouched sentinel\n", path);
 }
 assert.equal(existsSync(join(f.home, ".agent-config-backups")), false);
 assert.deepEqual(calls(f), []);
 assert.equal(readFileSync(join(f.agentDir, "extensions/session-ui/config.json"), "utf8"),
  readFileSync(join(ROOT, "harnesses/pi/plugin-configs/session-ui/config.json"), "utf8"));
});

test("repository symlinks require consent like other conflicts", (t) => {
 const f = fixture(t);
 const target = join(f.agentDir, "settings.json");
 symlinkSync(join(ROOT, "harnesses/pi/config/settings.json"), target);
 assertSuccess(install(f, { input: "n\n" }));
 assert.ok(lstatSync(target).isSymbolicLink());
 assert.equal(existsSync(join(f.agentDir, "models.json")), false);
 assertSuccess(install(f));
 assert.equal(lstatSync(target).isSymbolicLink(), false);
 assert.ok(lstatSync(join(backupAgent(f), "settings.json")).isSymbolicLink());
});

test("rules remain a five-target transactional group", (t) => {
 const f = fixture(t);
 const targets = [".agents/AGENTS.md", ".claude/CLAUDE.md", ".codex/AGENTS.md", ".pi/agent/AGENTS.md", ".grok/AGENTS.md"];
 const run = input => spawnSync("bash", [join(ROOT, "install-rules.sh")], {
  encoding: "utf8", input, env: { ...process.env, AGENT_CONFIG_INSTALL_HOME: f.home },
 });
 const conflict = join(f.home, targets[0]);
 mkdirSync(dirname(conflict), { recursive: true });
 writeFileSync(conflict, "personal rules\n");
 assertSuccess(run("n\n"));
 assert.equal(existsSync(join(f.home, targets[1])), false);
 assertSuccess(run("y\n"));
 for (const target of targets) assert.equal(readFileSync(join(f.home, target), "utf8"), readFileSync(join(ROOT, "rules/AGENTS.md"), "utf8"));
});
