import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { COPY_BLOCK_COMMAND, COPY_BLOCK_SHORTCUT } from "./runtime.ts";

const PI_PACKAGE_ROOT = process.env.PI_PACKAGE_ROOT;
const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const ENTRY_PATH = join(EXTENSION_DIR, "index.ts");

test(
	"copy-block shortcut does not collide with Pi TUI or App default keybindings",
	{ skip: !PI_PACKAGE_ROOT && "PI_PACKAGE_ROOT is not set" },
	async () => {
		const piTuiKeybindingsPath = join(
			PI_PACKAGE_ROOT,
			"..",
			"pi-tui",
			"dist",
			"keybindings.js",
		);
		const piAppKeybindingsPath = join(
			PI_PACKAGE_ROOT,
			"dist",
			"core",
			"keybindings.js",
		);

		const tuiMod = await import(pathToFileURL(piTuiKeybindingsPath).href);
		const appMod = await import(pathToFileURL(piAppKeybindingsPath).href);
		const tuiMap = tuiMod.TUI_KEYBINDINGS;
		const appMap =
			appMod.DEFAULT_APP_KEYBINDINGS ??
			appMod.APP_KEYBINDINGS ??
			appMod.KEYBINDINGS;
		const maps = [tuiMap, appMap];

		for (const map of maps) {
			assert.ok(map && typeof map === "object");
			for (const [action, def] of Object.entries(map)) {
				const keys = Array.isArray(def.defaultKeys)
					? def.defaultKeys
					: [def.defaultKeys];
				assert.equal(
					keys.includes(COPY_BLOCK_SHORTCUT),
					false,
					`Shortcut ${COPY_BLOCK_SHORTCUT} collides with ${action}`,
				);
			}
		}
	},
);

test(
	"copy-block loads cleanly via Pi extension loader and respects untrusted project settings",
	{ skip: !PI_PACKAGE_ROOT && "PI_PACKAGE_ROOT is not set" },
	async (t) => {
		const piIndexPath = join(PI_PACKAGE_ROOT, "dist", "index.js");
		const { discoverAndLoadExtensions, SettingsManager } = await import(
			pathToFileURL(piIndexPath).href
		);

		const loaded = await discoverAndLoadExtensions([ENTRY_PATH], EXTENSION_DIR);
		assert.deepEqual(loaded.errors, []);
		const ext = loaded.extensions.find((e) => e.path === ENTRY_PATH);
		assert.ok(ext, "copy-block extension was not loaded");
		assert.ok(ext.commands.has(COPY_BLOCK_COMMAND));
		assert.ok(ext.shortcuts.has(COPY_BLOCK_SHORTCUT));

		// Verify projectTrusted: false prevents untrusted repo externalEditor override
		const sandbox = mkdtempSync(join(tmpdir(), "copy-block-trust-test-"));
		t.after(() => rmSync(sandbox, { recursive: true, force: true }));
		const agentDir = join(sandbox, "agent");
		const repoDir = join(sandbox, "repo");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(repoDir, ".pi"), { recursive: true });
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ externalEditor: "nvim" }),
		);
		writeFileSync(
			join(repoDir, ".pi", "settings.json"),
			JSON.stringify({ externalEditor: "sh -c 'evil'" }),
		);

		const untrusted = SettingsManager.create(repoDir, agentDir, {
			projectTrusted: false,
		});
		assert.equal(untrusted.getExternalEditorCommand(), "nvim");

		const trusted = SettingsManager.create(repoDir, agentDir, {
			projectTrusted: true,
		});
		assert.equal(trusted.getExternalEditorCommand(), "sh -c 'evil'");
	},
);
