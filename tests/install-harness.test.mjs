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
const OLD_PACKAGE = "@diegopetrucci/pi-openai-fast";
const SOURCE = `npm:${OLD_PACKAGE}`;

function fixture(t, packageName = OLD_PACKAGE) {
	const source = `npm:${packageName}`;
	const root = mkdtempSync(join(tmpdir(), "agent-config-installer-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const home = join(root, "home");
	const agentDir = join(home, ".pi", "agent");
	const bin = join(root, "bin");
	const log = join(root, "pi-calls.jsonl");
	mkdirSync(bin, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(bin, "pi"),
		`#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const agent = process.env.PI_CODING_AGENT_DIR;
assert.equal(agent, process.env.EXPECTED_AGENT_DIR);
assert.equal(process.env.PI_OFFLINE, "1");
assert.equal(process.env.npm_config_ignore_scripts, "true");
assert.deepEqual(process.argv.slice(2), ["remove", ${JSON.stringify(source)}, "--no-approve"]);
assert.equal(fs.realpathSync(process.cwd()), fs.realpathSync(path.dirname(path.dirname(agent))));
assert.ok(fs.existsSync(path.join(agent, "extensions/fast/index.ts")), "new plugin must be installed first");
const settings = JSON.parse(fs.readFileSync(path.join(agent, "settings.json")));
assert.equal(settings.packages.includes(${JSON.stringify(source)}), false);
fs.appendFileSync(process.env.PI_TEST_CALL_LOG, JSON.stringify({ agent, args: process.argv.slice(2) }) + "\\n");
if (process.env.PI_TEST_REMOVE_FAIL === "1") process.exit(9);
if (process.env.PI_TEST_REMOVE_NOOP === "1") process.exit(0);
fs.rmSync(path.join(agent, "npm/node_modules", ${JSON.stringify(packageName)}), { recursive: true, force: true });
const manifestPath = path.join(agent, "npm/package.json");
if (fs.existsSync(manifestPath)) {
 const manifest = JSON.parse(fs.readFileSync(manifestPath));
 for (const key of ["dependencies", "devDependencies", "optionalDependencies"]) if (manifest[key]) delete manifest[key][${JSON.stringify(packageName)}];
 fs.writeFileSync(manifestPath, JSON.stringify(manifest));
}
if (process.env.PI_TEST_REMOVE_NONZERO_AFTER === "1") process.exit(1);
`,
		{ mode: 0o755 },
	);
	return {
		root,
		home,
		agentDir,
		bin,
		log,
		packageName,
		source,
		packageDir: join(agentDir, "npm/node_modules", packageName),
	};
}

function seedOld(f, { directory = true, declaration = true } = {}) {
	mkdirSync(join(f.agentDir, "npm"), { recursive: true });
	const settings = JSON.parse(
		readFileSync(join(ROOT, "harnesses/pi/config/settings.json")),
	);
	settings.packages.push(f.source);
	writeFileSync(join(f.agentDir, "settings.json"), JSON.stringify(settings));
	writeFileSync(
		join(f.agentDir, "npm/package.json"),
		JSON.stringify({
			dependencies: {
				"unrelated-package": "1.0.0",
				...(declaration ? { [f.packageName]: "0.1.17" } : {}),
			},
		}),
	);
	writeFileSync(
		join(f.agentDir, "npm/package-lock.json"),
		'{"lockfileVersion":3}\n',
	);
	if (directory) {
		mkdirSync(f.packageDir, { recursive: true });
		writeFileSync(join(f.packageDir, "index.ts"), "old plugin fixture\n");
	}
}

function install(
	f,
	{ input = "y\n", fail = false, failAfter = false, noop = false } = {},
) {
	return spawnSync("bash", [join(ROOT, "install-harness.sh"), "pi"], {
		cwd: ROOT,
		encoding: "utf8",
		input,
		timeout: 30_000,
		env: {
			...process.env,
			PATH: `${f.bin}:${process.env.PATH}`,
			HOME: join(f.root, "unrelated-home"),
			AGENT_CONFIG_INSTALL_HOME: f.home,
			// The installer must override an unrelated active session's agent dir.
			PI_CODING_AGENT_DIR: join(f.root, "unrelated-agent"),
			EXPECTED_AGENT_DIR: f.agentDir,
			PI_TEST_CALL_LOG: f.log,
			PI_TEST_REMOVE_FAIL: fail ? "1" : "0",
			PI_TEST_REMOVE_NONZERO_AFTER: failAfter ? "1" : "0",
			PI_TEST_REMOVE_NOOP: noop ? "1" : "0",
		},
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

function cleanupBackup(f) {
	const root = join(f.home, ".agent-config-backups");
	return readdirSync(root)
		.map((name) => join(root, name, "pi-retired/openai-fast-package"))
		.find((path) => existsSync(path));
}

test("maps the three source categories to Pi runtime paths without installing inactive configs", (t) => {
	const f = fixture(t);
	assertSuccess(install(f));
	const files = {
		"config/settings.json": ".pi/agent/settings.json",
		"config/keybindings.json": ".pi/agent/keybindings.json",
		"builtins/session-ui/index.ts": ".pi/agent/extensions/session-ui/index.ts",
		"builtins/session-ui/config.ts": ".pi/agent/extensions/session-ui/config.ts",
		"builtins/fast/index.ts": ".pi/agent/extensions/fast/index.ts",
		"plugin-configs/session-ui/config.json": ".pi/agent/extensions/session-ui/config.json",
		"plugin-configs/fast/config.json": ".pi/agent/extensions/fast.json",
		"plugin-configs/pi-subagents/config.json": ".pi/agent/extensions/subagent/config.json",
		"plugin-configs/pi-subagents/profiles/multimodel.json": ".pi/agent/profiles/pi-subagents/multimodel.json",
		"plugin-configs/pi-lens/config.json": ".pi-lens/config.json",
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
	const settings = JSON.parse(readFileSync(join(f.agentDir, "settings.json"), "utf8"));
	assert.equal(settings.theme, "system");
	assert.deepEqual(settings.defaultTools, ["+codemode"]);
	assert.equal(existsSync(join(f.root, "unrelated-agent")), false);
	assertSuccess(install(f));
	assert.equal(existsSync(join(f.home, ".agent-config-backups")), false);
	assert.deepEqual(calls(f), []);
});

test("retires MCP adapter with backups while preserving native config and credentials", (t) => {
	const f = fixture(t, "pi-mcp-adapter");
	seedOld(f);
	const preserved = ["mcp.json", "mcp-auth.json", "mcp-adapter.json", "mcp-cache.json"];
	for (const file of preserved) writeFileSync(join(f.agentDir, file), "preserve sentinel\n");
	assertSuccess(install(f, { input: "n\n" }));
	assert.ok(existsSync(f.packageDir));
	assert.deepEqual(calls(f), []);
	assertSuccess(install(f));
	assert.equal(existsSync(f.packageDir), false);
	assert.equal(calls(f).length, 1);
	const root = join(f.home, ".agent-config-backups");
	const backup = readdirSync(root).map((name) => join(root, name, "pi-retired/mcp-adapter-package")).find(existsSync);
	assert.ok(backup);
	assert.equal(readFileSync(join(backup, "previous-package/index.ts"), "utf8"), "old plugin fixture\n");
	assert.ok(JSON.parse(readFileSync(join(backup, "package.json"))).dependencies["pi-mcp-adapter"]);
	assert.ok(existsSync(join(backup, "package-lock.json")));
	for (const file of preserved) assert.equal(readFileSync(join(f.agentDir, file), "utf8"), "preserve sentinel\n");
	assertSuccess(install(f));
	assert.equal(calls(f).length, 1);
});

for (const mode of ["fail", "noop", "failAfter"]) {
	test(`MCP adapter cleanup verifies actual residue after ${mode}`, (t) => {
		const f = fixture(t, "pi-mcp-adapter");
		seedOld(f);
		const result = install(f, { [mode]: true });
		if (mode === "failAfter") assertSuccess(result);
		else {
			assert.notEqual(result.status, 0);
			assert.match(result.stderr, /MCP adapter.*仍有残留/);
			assert.ok(existsSync(f.packageDir));
			assert.equal(JSON.parse(readFileSync(join(f.agentDir, "settings.json"))).packages.includes(f.source), false);
			assertSuccess(install(f));
		}
		assert.equal(existsSync(f.packageDir), false);
	});
}

test("MCP cleanup refuses linked npm directories outside the target", (t) => {
	const f = fixture(t, "pi-mcp-adapter");
	seedOld(f);
	const external = join(f.root, "external-npm");
	mkdirSync(external);
	writeFileSync(join(external, "sentinel"), "preserve\n");
	rmSync(join(f.agentDir, "npm"), { recursive: true });
	symlinkSync(external, join(f.agentDir, "npm"));
	const result = install(f);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /Refusing package cleanup through symlink/);
	assert.deepEqual(calls(f), []);
	assert.equal(readFileSync(join(external, "sentinel"), "utf8"), "preserve\n");
});

const SOL_SOURCE = "git:github.com/NVlabs/SoL-Pi";
const SOL_PACKAGE = "git/github.com/NVlabs/SoL-Pi";

function seedSolPi(f, { parts = ["config", "package", "cache"], declaration = true } = {}) {
	const files = new Map();
	if (parts.includes("config")) files.set("sol-pi.json", '{"observationPack":true}\n');
	if (parts.includes("package")) {
		files.set(`${SOL_PACKAGE}/index.ts`, "old extension\n");
		files.set(`${SOL_PACKAGE}/.git/config`, "git metadata\n");
		files.set(`${SOL_PACKAGE}/package.json`, '{"scripts":{"preuninstall":"exit 88"}}\n');
		files.set(`${SOL_PACKAGE}/package-lock.json`, '{"lockfileVersion":3}\n');
		files.set(`${SOL_PACKAGE}/node_modules/fixture/index.js`, "dependency\n");
	}
	if (parts.includes("cache")) {
		files.set("sessions/project/sol-pi/session-id/observation-pack/objects/obs.txt", "cached output\n");
		files.set("sessions/project/parent/run-0/sol-pi/child/ledger.jsonl", "cached ledger\n");
	}
	if (declaration) {
		const path = join(f.agentDir, "settings.json");
		const settings = JSON.parse(readFileSync(path));
		settings.packages.push(SOL_SOURCE);
		files.set("settings.json", JSON.stringify(settings));
	}
	for (const [relative, content] of files) {
		const path = join(f.agentDir, relative);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content);
	}
	return files;
}

function solBackup(f) {
	const root = join(f.home, ".agent-config-backups");
	const backups = readdirSync(root);
	assert.equal(backups.length, 1);
	return join(root, backups[0], "pi/.pi/agent");
}

function assertSolRetired(f, files) {
	const backup = solBackup(f);
	for (const [relative, content] of files) {
		assert.equal(readFileSync(join(backup, relative), "utf8"), content, relative);
		if (relative !== "settings.json") assert.equal(existsSync(join(f.agentDir, relative)), false, relative);
	}
	const settings = JSON.parse(readFileSync(join(f.agentDir, "settings.json")));
	assert.equal(settings.packages.includes(SOL_SOURCE), false);
	assert.ok(settings.enabledModels.includes("openai-codex/gpt-6.1-sol"));
	assert.deepEqual(calls(f), []);
}

function interceptMove(f, condition, action = "process.exit(1);") {
	const marker = join(f.root, "intercepted-move");
	writeFileSync(join(f.bin, "mv"), `#!/usr/bin/env node
const fs = require("node:fs"), { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
if ((${condition}) && !fs.existsSync(${JSON.stringify(marker)})) {
 fs.writeFileSync(${JSON.stringify(marker)}, "1");
 ${action}
}
const result = spawnSync("mv", args, { stdio: "inherit", env: { ...process.env, PATH: ${JSON.stringify(process.env.PATH)} } });
process.exit(result.status ?? 1);
`, { mode: 0o755 });
}

test("retires the complete SoL-Pi Git checkout and nested caches in one backed-up transaction", (t) => {
	const f = fixture(t);
	assertSuccess(install(f));
	const files = seedSolPi(f);
	const preserved = [
		join(f.agentDir, "sessions/project/history.jsonl"),
		join(f.agentDir, "sessions/project/parent/run-0/session.jsonl"),
		join(f.agentDir, "sessions/--work-SoL-Pi--/history.jsonl"),
		join(f.agentDir, "extensions/custom/index.ts"),
		join(f.agentDir, "auth.json"),
		join(f.root, "unrelated-agent/sol-pi.json"),
		join(f.root, "unrelated-agent/sessions/project/sol-pi/obs.txt"),
		join(f.root, "unrelated-home/.pi/agent/sol-pi.json"),
		join(f.root, `unrelated-home/.pi/agent/${SOL_PACKAGE}/index.ts`),
		join(f.root, "unrelated-home/.pi/agent/sessions/project/sol-pi/obs.txt"),
	];
	for (const path of preserved) {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, "preserve fixture\n");
	}
	const result = install(f);
	assertSuccess(result);
	assert.match(result.stdout, /SoL-Pi.*备份/);
	assert.match(result.stdout, /进程可能重建缓存/);
	assertSolRetired(f, files);
	for (const path of preserved) assert.equal(readFileSync(path, "utf8"), "preserve fixture\n");
	assertSuccess(install(f));
	assertSolRetired(f, files);
});

test("declining SoL-Pi retirement leaves the entire group and caches untouched", (t) => {
	const f = fixture(t);
	assertSuccess(install(f));
	const files = seedSolPi(f);
	const result = install(f, { input: "n\n" });
	assertSuccess(result);
	for (const [relative, content] of files) assert.equal(readFileSync(join(f.agentDir, relative), "utf8"), content);
	assert.equal(existsSync(join(f.home, ".agent-config-backups")), false);
	assert.doesNotMatch(result.stdout, /旧 SoL-Pi.*已移至备份/);
	assert.deepEqual(calls(f), []);
});

for (const part of ["config", "package", "cache"]) {
	test(`retires orphaned SoL-Pi ${part} with consent even when settings already match`, (t) => {
		const f = fixture(t);
		assertSuccess(install(f));
		const files = seedSolPi(f, { parts: [part], declaration: false });
		assertSuccess(install(f, { input: "n\n" }));
		for (const [relative, content] of files) assert.equal(readFileSync(join(f.agentDir, relative), "utf8"), content);
		assert.equal(existsSync(join(f.home, ".agent-config-backups")), false);
		assertSuccess(install(f));
		assertSolRetired(f, files);
		assertSuccess(install(f));
		assertSolRetired(f, files);
	});
}

for (const phase of ["backup", "install"]) {
	test(`restores SoL-Pi package, config and caches when ${phase} fails`, (t) => {
		const f = fixture(t);
		assertSuccess(install(f));
		const files = seedSolPi(f);
		interceptMove(f, phase === "backup"
			? `args[0] === ${JSON.stringify(join(f.agentDir, "sessions/project/sol-pi"))}`
			: `args.at(-1) === ${JSON.stringify(join(f.agentDir, "extensions/session-ui"))}`);
		const result = install(f);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, phase === "backup" ? /备份失败/ : /安装失败/);
		for (const [relative, content] of files) assert.equal(readFileSync(join(f.agentDir, relative), "utf8"), content);
		assert.deepEqual(calls(f), []);
		assertSuccess(install(f));
		for (const relative of files.keys()) {
			if (relative !== "settings.json") assert.equal(existsSync(join(f.agentDir, relative)), false);
		}
	});
}

test("reports remaining SoL-Pi files even if the move command returns success", (t) => {
	const f = fixture(t);
	assertSuccess(install(f));
	seedSolPi(f);
	interceptMove(f, `args[0] === ${JSON.stringify(join(f.agentDir, SOL_PACKAGE))}`, "process.exit(0);");
	const result = install(f);
	assert.notEqual(result.status, 0, result.stdout + result.stderr);
	assert.match(result.stderr, /SoL-Pi 仍有残留.*新配置及备份已保留/);
	assert.equal(existsSync(join(f.agentDir, SOL_PACKAGE)), true);
	assert.equal(existsSync(join(f.agentDir, "sol-pi.json")), false);
	assert.equal(existsSync(join(solBackup(f), "sol-pi.json")), true);
	assert.equal(JSON.parse(readFileSync(join(f.agentDir, "settings.json"))).packages.includes(SOL_SOURCE), false);
	assertSuccess(install(f));
	assert.equal(existsSync(join(f.agentDir, SOL_PACKAGE)), false);
});

test("does not follow session symlinks and only moves a cache symlink itself", (t) => {
	const f = fixture(t);
	assertSuccess(install(f));
	const outside = join(f.root, "outside");
	mkdirSync(join(outside, "sol-pi"), { recursive: true });
	writeFileSync(join(outside, "sol-pi/obs.txt"), "outside fixture\n");
	const sessions = join(f.agentDir, "sessions");
	mkdirSync(join(sessions, "project"), { recursive: true });
	symlinkSync(outside, join(sessions, "linked-project"));
	symlinkSync(join(outside, "sol-pi"), join(sessions, "project/sol-pi"));
	assertSuccess(install(f));
	assert.equal(lstatSync(join(solBackup(f), "sessions/project/sol-pi")).isSymbolicLink(), true);
	assert.equal(existsSync(join(sessions, "project/sol-pi")), false);
	assert.equal(lstatSync(join(sessions, "linked-project")).isSymbolicLink(), true);
	assert.equal(readFileSync(join(outside, "sol-pi/obs.txt"), "utf8"), "outside fixture\n");
});

for (const relative of ["git", "sessions"]) {
	test(`refuses a symlinked ${relative} cleanup parent before changing installed files`, (t) => {
		const f = fixture(t);
		assertSuccess(install(f));
		const files = seedSolPi(f, { parts: ["config"] });
		const outside = join(f.root, "outside");
		mkdirSync(outside);
		symlinkSync(outside, join(f.agentDir, relative));
		const result = install(f);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /Cleanup parent must be a real directory/);
		for (const [path, content] of files) assert.equal(readFileSync(join(f.agentDir, path), "utf8"), content);
		assert.equal(existsSync(join(f.home, ".agent-config-backups")), false);
	});
}

test("rejects cache paths containing manifest delimiters without changing the installation", (t) => {
	const f = fixture(t);
	assertSuccess(install(f));
	mkdirSync(join(f.agentDir, "sessions/project|unsafe/sol-pi"), { recursive: true });
	const result = install(f);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /Cleanup path cannot be represented/);
	assert.equal(existsSync(join(f.agentDir, "sessions/project|unsafe/sol-pi")), true);
	assert.equal(existsSync(join(f.home, ".agent-config-backups")), false);
});

test("retired approval plugin configs are absent", () => {
	const configRoot = join(ROOT, "harnesses/pi/plugin-configs");
	for (const name of ["automode", "pi-auto-review", "pi-permission-system"]) {
		assert.equal(existsSync(join(configRoot, name)), false, name);
	}
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

test("a legacy entry alone triggers confirmation and is retired on an otherwise current install", (t) => {
	const f = fixture(t);
	assertSuccess(install(f));
	const legacyEntry = join(f.agentDir, "extensions/session-ui.ts");
	writeFileSync(legacyEntry, "old standalone entry\n");
	assertSuccess(install(f, { input: "n\n" }));
	assert.equal(readFileSync(legacyEntry, "utf8"), "old standalone entry\n");
	assert.equal(existsSync(join(f.home, ".agent-config-backups")), false);
	const result = install(f);
	assertSuccess(result);
	assert.match(result.stdout, /移除插件：session-ui 旧入口/);
	assert.equal(existsSync(legacyEntry), false);
	assert.ok(existsSync(join(f.agentDir, "extensions/session-ui/index.ts")));
	const backups = readdirSync(join(f.home, ".agent-config-backups"));
	assert.equal(backups.length, 1);
	assert.equal(readFileSync(join(f.home, ".agent-config-backups", backups[0], "pi/.pi/agent/extensions/session-ui.ts"), "utf8"), "old standalone entry\n");
	assertSuccess(install(f));
	assert.deepEqual(readdirSync(join(f.home, ".agent-config-backups")), backups);
});

test("replaces managed plugin directories only after consent and backs up obsolete files", (t) => {
	const f = fixture(t);
	assertSuccess(install(f));
	const oldFiles = {
		"extensions/session-ui.ts": "old standalone entry\n",
		"extensions/session-ui/obsolete.ts": "old session-ui module\n",
		"extensions/session-ui/AGENTS.md": "old local rules\n",
		"extensions/openai-fast/obsolete.ts": "old fast module\n",
		"extensions/fast/obsolete.ts": "old fast module\n",
	};
	const configPath = join(f.agentDir, "extensions/session-ui/config.json");
	const oldConfig = '{"workAnimation":{"enabled":false}}\n';
	mkdirSync(join(f.agentDir, "extensions/openai-fast"), { recursive: true });
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

test("rolls back both code and composed config if deployment fails", (t) => {
	const f = fixture(t);
	assertSuccess(install(f));
	const target = join(f.agentDir, "extensions/session-ui");
	const oldConfig = '{"workAnimation":{"enabled":false}}\n';
	writeFileSync(join(target, "config.json"), oldConfig);
	writeFileSync(join(target, "obsolete.ts"), "old module\n");
	const legacyEntry = join(f.agentDir, "extensions/session-ui.ts");
	writeFileSync(legacyEntry, "old standalone entry\n");
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
	assert.equal(readFileSync(legacyEntry, "utf8"), "old standalone entry\n");
	assert.equal(existsSync(join(target, "index.ts")), false);
	assert.equal(readFileSync(join(target, "config.json"), "utf8"), oldConfig);
	assert.equal(readFileSync(join(target, "obsolete.ts"), "utf8"), "old module\n");
	assert.equal(readFileSync(join(target, "config.ts"), "utf8"), readFileSync(join(ROOT, "harnesses/pi/builtins/session-ui/config.ts"), "utf8"));
	assert.deepEqual(calls(f), []);
	assertSuccess(install(f));
	assert.equal(existsSync(join(target, "obsolete.ts")), false);
	assert.equal(existsSync(legacyEntry), false);
	assert.equal(existsSync(join(target, "index.ts")), true);
});

test("fresh and repeat installs copy the multimodel profile without activating it", (t) => {
	const f = fixture(t);
	const relativePath = "profiles/pi-subagents/multimodel.json";
	const source = readFileSync(
		join(ROOT, "harnesses/pi/plugin-configs/pi-subagents/profiles/multimodel.json"),
		"utf8",
	);
	for (let attempt = 0; attempt < 2; attempt += 1) {
		assertSuccess(install(f));
		assert.equal(readFileSync(join(f.agentDir, relativePath), "utf8"), source);
		const settings = JSON.parse(readFileSync(join(f.agentDir, "settings.json")));
		assert.equal(Object.hasOwn(settings, "subagents"), false);
		assert.equal(
			existsSync(
				join(f.agentDir, "profiles/pi-subagents/three-model-context-first.json"),
			),
			false,
		);
	}
	assert.deepEqual(calls(f), []);
});

test("renamed multimodel profile retires the old profile only after consent with a backup", (t) => {
	const f = fixture(t);
	assertSuccess(install(f));
	const legacyProfile = join(f.agentDir, "profiles/pi-subagents/multimodel-ggk.json");
	writeFileSync(legacyProfile, "old profile\n");
	assertSuccess(install(f, { input: "n\n" }));
	assert.equal(readFileSync(legacyProfile, "utf8"), "old profile\n");
	assert.equal(existsSync(join(f.home, ".agent-config-backups")), false);
	const result = install(f);
	assertSuccess(result);
	assert.match(result.stdout, /移除配置：多模型 Profile 旧文件/);
	assert.equal(existsSync(legacyProfile), false);
	assert.ok(existsSync(join(f.agentDir, "profiles/pi-subagents/multimodel.json")));
	const backups = readdirSync(join(f.home, ".agent-config-backups"));
	assert.equal(backups.length, 1);
	assert.equal(
		readFileSync(join(f.home, ".agent-config-backups", backups[0], "pi/.pi/agent/profiles/pi-subagents/multimodel-ggk.json"), "utf8"),
		"old profile\n",
	);
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

test("installs replacement before uninstalling the exact old package and preserves backups", (t) => {
	const f = fixture(t);
	seedOld(f);
	assertSuccess(install(f));
	assert.equal(calls(f).length, 1);
	assert.equal(existsSync(f.packageDir), false);
	const backup = cleanupBackup(f);
	assert.ok(backup);
	assert.equal(
		readFileSync(join(backup, "previous-package/index.ts"), "utf8"),
		"old plugin fixture\n",
	);
	assert.equal(
		JSON.parse(readFileSync(join(backup, "package.json"))).dependencies[
			OLD_PACKAGE
		],
		"0.1.17",
	);
	assert.ok(existsSync(join(backup, "package-lock.json")));
	assert.equal(
		JSON.parse(readFileSync(join(f.agentDir, "extensions/fast.json")))
			.enabled,
		false,
	);
	assert.equal(
		JSON.parse(readFileSync(join(f.agentDir, "npm/package.json"))).dependencies[
			"unrelated-package"
		],
		"1.0.0",
	);
	assertSuccess(install(f));
	assert.equal(calls(f).length, 1, "repeat install must not uninstall again");
});

test("declining installation leaves the old plugin and manifests untouched", (t) => {
	const f = fixture(t);
	seedOld(f);
	const settings = readFileSync(join(f.agentDir, "settings.json"), "utf8");
	const manifest = readFileSync(join(f.agentDir, "npm/package.json"), "utf8");
	assertSuccess(install(f, { input: "n\n" }));
	assert.deepEqual(calls(f), []);
	assert.ok(existsSync(f.packageDir));
	assert.equal(
		readFileSync(join(f.agentDir, "settings.json"), "utf8"),
		settings,
	);
	assert.equal(
		readFileSync(join(f.agentDir, "npm/package.json"), "utf8"),
		manifest,
	);
	mkdirSync(join(f.agentDir, "extensions/openai-fast"), { recursive: true });
	writeFileSync(join(f.agentDir, "extensions/openai-fast/index.ts"), "old fast entry\n");
	assertSuccess(install(f, { input: "n\n" }));
	assert.equal(
		readFileSync(join(f.agentDir, "extensions/openai-fast/index.ts"), "utf8"),
		"old fast entry\n",
	);
	assert.equal(
		existsSync(join(f.agentDir, "extensions/fast/index.ts")),
		false,
	);
});

test("cleans a manifest-only installation using the install target, not the ambient agent dir", (t) => {
	const f = fixture(t);
	seedOld(f, { directory: false });
	assertSuccess(install(f));
	assert.equal(calls(f).length, 1);
	assert.equal(calls(f)[0].agent, f.agentDir);
	assert.equal(
		JSON.parse(readFileSync(join(f.agentDir, "npm/package.json"))).dependencies[
			OLD_PACKAGE
		],
		undefined,
	);
});

test("cleans an orphaned package directory even without a dependency declaration", (t) => {
	const f = fixture(t);
	seedOld(f, { declaration: false });
	assertSuccess(install(f));
	assert.equal(calls(f).length, 1);
	assert.equal(existsSync(f.packageDir), false);
});

test("cleanup runs when managed config is already up to date", (t) => {
	const f = fixture(t);
	assertSuccess(install(f));
	mkdirSync(f.packageDir, { recursive: true });
	writeFileSync(join(f.packageDir, "index.ts"), "orphan\n");
	assertSuccess(install(f));
	assert.equal(calls(f).length, 1);
});

test("cleanup failure is reported, keeps the new files and backup, and permits a later retry", (t) => {
	const f = fixture(t);
	seedOld(f);
	const result = install(f, { fail: true });
	assert.notEqual(result.status, 0, result.stdout + result.stderr);
	assert.match(result.stderr, /卸载失败/);
	assert.ok(existsSync(f.packageDir));
	assert.ok(existsSync(join(f.agentDir, "extensions/fast/index.ts")));
	assert.ok(cleanupBackup(f));
	assertSuccess(install(f));
	assert.equal(calls(f).length, 2);
	assert.equal(existsSync(f.packageDir), false);
});

test("accepts Pi's nonzero result only after verifying that the package was removed", (t) => {
	const f = fixture(t);
	seedOld(f);
	const result = install(f, { failAfter: true });
	assertSuccess(result);
	assert.match(result.stdout, /已复核/);
	assert.equal(existsSync(f.packageDir), false);
	assert.equal(
		JSON.parse(readFileSync(join(f.agentDir, "npm/package.json"))).dependencies[
			OLD_PACKAGE
		],
		undefined,
	);
});

test("does not trust a zero exit status if the old package remains", (t) => {
	const f = fixture(t);
	seedOld(f);
	const result = install(f, { noop: true });
	assert.notEqual(result.status, 0, result.stdout + result.stderr);
	assert.match(result.stderr, /仍有残留/);
	assert.ok(existsSync(f.packageDir));
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

test("retires the legacy ~/.pi/web-search.json after installing the agent-dir copy", (t) => {
	const f = fixture(t);
	mkdirSync(join(f.home, ".pi"), { recursive: true });
	writeFileSync(
		join(f.home, ".pi/web-search.json"),
		'{"workflow":"summary-review"}\n',
	);
	assertSuccess(install(f));
	assert.equal(existsSync(join(f.home, ".pi/web-search.json")), false);
	assert.ok(existsSync(join(f.agentDir, "web-search.json")));
	assert.match(
		readFileSync(join(f.agentDir, "web-search.json"), "utf8"),
		/auto-summary/,
	);
	const retired = readdirSync(join(f.home, ".agent-config-backups"))
		.map((name) =>
			join(
				f.home,
				".agent-config-backups",
				name,
				"pi-retired/.pi/web-search.json",
			),
		)
		.find((path) => existsSync(path));
	assert.ok(retired);
	assert.equal(readFileSync(retired, "utf8"), '{"workflow":"summary-review"}\n');
});

test("declining installation leaves the legacy web-search.json untouched", (t) => {
	const f = fixture(t);
	seedOld(f);
	mkdirSync(join(f.home, ".pi"), { recursive: true });
	writeFileSync(
		join(f.home, ".pi/web-search.json"),
		'{"workflow":"summary-review"}\n',
	);
	assertSuccess(install(f, { input: "n\n" }));
	assert.equal(
		readFileSync(join(f.home, ".pi/web-search.json"), "utf8"),
		'{"workflow":"summary-review"}\n',
	);
	assert.equal(existsSync(join(f.agentDir, "web-search.json")), false);
});

test("an unrelated dependency does not trigger removal", (t) => {
	const f = fixture(t);
	mkdirSync(join(f.agentDir, "npm"));
	writeFileSync(
		join(f.agentDir, "npm/package.json"),
		JSON.stringify({ dependencies: { [`${OLD_PACKAGE}-helper`]: "1.0.0" } }),
	);
	assertSuccess(install(f));
	assert.deepEqual(calls(f), []);
});

test("unreadable manifest content fails without invoking removal", (t) => {
	const f = fixture(t);
	mkdirSync(join(f.agentDir, "npm"));
	writeFileSync(join(f.agentDir, "npm/package.json"), "{");
	const result = install(f);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /Cannot read the Pi npm manifest/);
	assert.deepEqual(calls(f), []);
});
