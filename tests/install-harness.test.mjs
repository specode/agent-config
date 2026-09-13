import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OLD_PACKAGE = "@diegopetrucci/pi-openai-fast";
const SOURCE = `npm:${OLD_PACKAGE}`;

function fixture(t) {
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
assert.deepEqual(process.argv.slice(2), ["remove", ${JSON.stringify(SOURCE)}, "--no-approve"]);
assert.equal(fs.realpathSync(process.cwd()), fs.realpathSync(path.dirname(path.dirname(agent))));
assert.ok(fs.existsSync(path.join(agent, "extensions/openai-fast/index.ts")), "new plugin must be installed first");
const settings = JSON.parse(fs.readFileSync(path.join(agent, "settings.json")));
assert.equal(settings.packages.includes(${JSON.stringify(SOURCE)}), false);
fs.appendFileSync(process.env.PI_TEST_CALL_LOG, JSON.stringify({ agent, args: process.argv.slice(2) }) + "\\n");
if (process.env.PI_TEST_REMOVE_FAIL === "1") process.exit(9);
if (process.env.PI_TEST_REMOVE_NOOP === "1") process.exit(0);
fs.rmSync(path.join(agent, "npm/node_modules", ${JSON.stringify(OLD_PACKAGE)}), { recursive: true, force: true });
const manifestPath = path.join(agent, "npm/package.json");
if (fs.existsSync(manifestPath)) {
 const manifest = JSON.parse(fs.readFileSync(manifestPath));
 for (const key of ["dependencies", "devDependencies", "optionalDependencies"]) if (manifest[key]) delete manifest[key][${JSON.stringify(OLD_PACKAGE)}];
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
		packageDir: join(agentDir, "npm/node_modules", OLD_PACKAGE),
	};
}

function seedOld(f, { directory = true, declaration = true } = {}) {
	mkdirSync(join(f.agentDir, "npm"), { recursive: true });
	const settings = JSON.parse(
		readFileSync(join(ROOT, "harnesses/pi/agent/settings.json")),
	);
	settings.packages.push(SOURCE);
	writeFileSync(join(f.agentDir, "settings.json"), JSON.stringify(settings));
	writeFileSync(
		join(f.agentDir, "npm/package.json"),
		JSON.stringify({
			dependencies: {
				"unrelated-package": "1.0.0",
				...(declaration ? { [OLD_PACKAGE]: "0.1.17" } : {}),
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

test("fresh install does not invoke package removal", (t) => {
	const f = fixture(t);
	assertSuccess(install(f));
	assert.deepEqual(calls(f), []);
	assert.ok(existsSync(join(f.agentDir, "extensions/openai-fast/index.ts")));
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
		JSON.parse(readFileSync(join(f.agentDir, "extensions/openai-fast.json")))
			.enabled,
		true,
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
	assert.equal(
		existsSync(join(f.agentDir, "extensions/openai-fast/index.ts")),
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
	assert.ok(existsSync(join(f.agentDir, "extensions/openai-fast/index.ts")));
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
	assert.equal(
		readFileSync(retired, "utf8"),
		'{"workflow":"summary-review"}\n',
	);
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
