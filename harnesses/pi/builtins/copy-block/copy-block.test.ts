import assert from "node:assert/strict";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	launchExternalEditor,
	parseEditorCommand,
	quoteWindowsShellArg,
	resolveFallbackEditorCommand,
	type EditorLaunchResult,
} from "./editor.ts";
import {
	collectAssistantMessages,
	extractCopyItems,
	parseMessageIndexArg,
	sanitizeFileExtension,
	sanitizePreviewLine,
	stripTerminalControl,
} from "./extract.ts";
import {
	CopyBlockPickerComponent,
	type CopyBlockPickerAction,
	type PickerUiHelpers,
} from "./picker.ts";
import {
	COPY_BLOCK_COMMAND,
	COPY_BLOCK_SHORTCUT,
	registerCopyBlock,
} from "./runtime.ts";

function stripSgr(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function charWidth(ch: string): number {
	const code = ch.codePointAt(0) ?? 0;
	// Treat common CJK unified ideographs and astral emoji as 2-cell wide.
	if (
		code > 0xffff ||
		(code >= 0x4e00 && code <= 0x9fff) ||
		(code >= 0x3000 && code <= 0x303f) ||
		(code >= 0xff00 && code <= 0xffef)
	) {
		return 2;
	}
	return 1;
}

function measureWidth(text: string): number {
	let width = 0;
	for (const ch of stripSgr(text)) width += charWidth(ch);
	return width;
}

function testHelpers(): PickerUiHelpers {
	return {
		visibleWidth: measureWidth,
		truncateToWidth: (text, maxWidth, ellipsis = "…") => {
			if (measureWidth(text) <= maxWidth) return text;
			const plain = stripSgr(text);
			const ellipsisWidth = measureWidth(ellipsis);
			const limit = Math.max(0, maxWidth - ellipsisWidth);
			let out = "";
			let used = 0;
			for (const ch of plain) {
				const w = charWidth(ch);
				if (used + w > limit) break;
				out += ch;
				used += w;
			}
			return maxWidth >= ellipsisWidth ? `${out}${ellipsis}` : out;
		},
		matchesKey: (data, key) => {
			if (key === "left") return data === "\x1b[D";
			if (key === "right") return data === "\x1b[C";
			if (key === "ctrl+d") return data === "\x04";
			if (key === "ctrl+u") return data === "\x15";
			if (key === "shift+e") return data === "E" || data === "\x1b[101;2u";
			return data === key;
		},
	};
}

const plainTheme = {
	fg: (_token: string, text: string) => text,
	bold: (text: string) => text,
};

const plainKeybindings = {
	matches: (data: string, action: string) => {
		if (action === "tui.select.up") return data === "\x1b[A";
		if (action === "tui.select.down") return data === "\x1b[B";
		if (action === "tui.select.confirm") return data === "\r";
		if (action === "tui.select.cancel") return data === "\x1b";
		if (action === "tui.select.pageDown") return data === "\x1b[6~";
		if (action === "tui.select.pageUp") return data === "\x1b[5~";
		return false;
	},
};

test("extractCopyItems extracts fenced code block nested inside ordered list preserving internal indent", () => {
	const markdown = [
		"### Solutions",
		"",
		"1. Disable padding and indent:",
		"   ```json",
		'   "outputPad": 0,',
		'   "markdown": {',
		'     "codeBlockIndent": ""',
		"   }",
		"   ```",
		"",
		"   - Done.",
	].join("\n");

	const items = extractCopyItems(markdown);
	assert.equal(items.length, 2);
	assert.equal(items[0]?.kind, "code");
	assert.equal(items[0]?.lang, "json");
	assert.equal(items[0]?.label, "code · json");
	assert.equal(
		items[0]?.content,
		['"outputPad": 0,', '"markdown": {', '  "codeBlockIndent": ""', "}"].join(
			"\n",
		),
	);
	assert.equal(items[1]?.kind, "full");
	assert.equal(items[1]?.content, markdown);
});

test("extractCopyItems preserves line-1 indentation when reply starts directly with an indented fence", () => {
	const markdown = [
		"   ```json",
		'   "a": 1,',
		'     "b": 2',
		"   ```",
	].join("\n");
	const items = extractCopyItems(markdown);
	assert.equal(items[0]?.kind, "code");
	assert.equal(items[0]?.content, '"a": 1,\n  "b": 2');
	assert.equal(items[1]?.content, markdown);
});

test("extractCopyItems handles tab-indented fences and multi-space list markers", () => {
	const markdown = [
		"\t```sh",
		"\techo one",
		"\t  echo two",
		"\t```",
		"",
		"-    ```bash",
		"     echo from list",
		"     ```",
	].join("\n");

	const items = extractCopyItems(markdown);
	assert.equal(items[0]?.content, "echo one\n  echo two");
	assert.equal(items[1]?.content, "echo from list");
});

test("extractCopyItems handles blockquotes, nested quotes, tilde fences, and 4-backtick fences", () => {
	const markdown = [
		"> Intro quote line",
		">",
		"> ```bash",
		"> export FOO=1",
		">",
		">   export BAR=2",
		"> ```",
		"",
		"> > Nested quote",
		"",
		"````markdown",
		"```json",
		'{"nested": true}',
		"```",
		"````",
		"",
		"~~~sh",
		"echo hi",
		"~~~",
	].join("\n");

	const items = extractCopyItems(markdown);
	assert.deepEqual(
		items.map((item) => ({ kind: item.kind, label: item.label })),
		[
			{ kind: "quote", label: "quote" },
			{ kind: "code", label: "code · bash" },
			{ kind: "quote", label: "quote" },
			{ kind: "code", label: "code · markdown" },
			{ kind: "code", label: "code · sh" },
			{ kind: "full", label: "Full response" },
		],
	);
	assert.equal(items[0]?.content, "Intro quote line");
	assert.equal(items[1]?.content, "export FOO=1\n\n  export BAR=2");
	assert.equal(items[2]?.content, "> Nested quote");
	assert.equal(items[3]?.content, '```json\n{"nested": true}\n```');
	assert.equal(items[4]?.content, "echo hi");
});

test("extractCopyItems does not close a 4-backtick fence on a 3-backtick line", () => {
	const markdown = ["````txt", "before", "```", "after", "````"].join("\n");
	const items = extractCopyItems(markdown);
	assert.equal(items[0]?.content, "before\n```\nafter");
});

test("extractCopyItems does not duplicate blockquote when it only wraps a fenced code block", () => {
	const markdown = ["> ```ts", "> const x = 1;", "> ```"].join("\n");
	const items = extractCopyItems(markdown);
	assert.deepEqual(
		items.map((item) => item.kind),
		["code", "full"],
	);
	assert.equal(items[0]?.content, "const x = 1;");
});

test("extractCopyItems closes blockquote fence cleanly if blockquote terminates early", () => {
	const markdown = ["> ```bash", "> echo inside", "Outside paragraph"].join("\n");
	const items = extractCopyItems(markdown);
	assert.equal(items[0]?.kind, "code");
	assert.equal(items[0]?.content, "echo inside");
});

test("extractCopyItems ignores inline triple-backtick spans, skips empty fences, and sanitizes lang escapes", () => {
	const markdown = [
		"Use ```inline code``` here.",
		"",
		"```txt",
		"   ",
		"```",
		"",
		"```bash\x1b]0;pwn\x07",
		"echo safe",
		"```",
	].join("\n");

	const items = extractCopyItems(markdown);
	assert.equal(items.length, 2);
	assert.equal(items[0]?.label, "code · bash");
	assert.equal(items[0]?.content, "echo safe");
});

test("extractCopyItems normalizes CRLF and handles unclosed fences", () => {
	const markdown = "```py\r\nprint(1)\r\n  print(2)";
	const items = extractCopyItems(markdown);
	assert.equal(items[0]?.kind, "code");
	assert.equal(items[0]?.content, "print(1)\n  print(2)");
});

test("stripTerminalControl and sanitizePreviewLine neutralize escapes without splitting surrogate pairs", () => {
	assert.equal(
		stripTerminalControl("hi \x1b]0;title\x07\x1b[2J\x1b[31mred\x1b[0m\x07"),
		"hi red",
	);
	const emojis = "🚀".repeat(10);
	const truncated = sanitizePreviewLine(emojis, 5);
	assert.equal([...truncated].length, 5);
	assert.equal(truncated, "🚀🚀🚀🚀…");
});

test("collectAssistantMessages returns newest-first non-empty assistant replies only", () => {
	const entries = [
		{ type: "message", message: { role: "user", content: "hi" } },
		{
			type: "message",
			timestamp: "2026-01-01T00:00:00Z",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "secret" },
					{ type: "text", text: "First " },
					{ type: "text", text: "reply" },
				],
			},
		},
		{
			type: "message",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", name: "bash" }],
			},
		},
		{
			type: "message",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "   \n  " }],
			},
		},
		{
			type: "message",
			timestamp: "2026-01-01T00:01:00Z",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Latest reply" }],
			},
		},
	];

	const messages = collectAssistantMessages(entries);
	assert.equal(messages.length, 2);
	assert.equal(messages[0]?.index, 1);
	assert.equal(messages[0]?.text, "Latest reply");
	assert.equal(messages[1]?.index, 2);
	assert.equal(messages[1]?.text, "First reply");
});

test("parseMessageIndexArg validates empty, valid, zero, huge, and out-of-range arguments", () => {
	assert.deepEqual(parseMessageIndexArg("", 3), { ok: true, index: 1 });
	assert.deepEqual(parseMessageIndexArg(" 2 ", 3), { ok: true, index: 2 });
	const zero = parseMessageIndexArg("0", 3);
	assert.equal(zero.ok, false);
	if (!zero.ok) assert.match(zero.error, /positive integer/);
	const huge = parseMessageIndexArg("99999999999999999999", 3);
	assert.equal(huge.ok, false);
	if (!huge.ok) assert.match(huge.error, /Only 3 assistant replies/);
	assert.equal(parseMessageIndexArg("4", 3).ok, false);
	assert.equal(parseMessageIndexArg("abc", 3).ok, false);
});

test("parseEditorCommand handles POSIX quoting and Windows backslash paths", () => {
	assert.deepEqual(parseEditorCommand("nvim", "darwin"), ["nvim"]);
	assert.deepEqual(parseEditorCommand("code --wait", "darwin"), [
		"code",
		"--wait",
	]);
	assert.deepEqual(
		parseEditorCommand(
			'"/Applications/Visual Studio Code.app/code" --wait',
			"darwin",
		),
		["/Applications/Visual Studio Code.app/code", "--wait"],
	);
	assert.deepEqual(
		parseEditorCommand("C:\\tools\\nvim.exe -R", "win32"),
		["C:\\tools\\nvim.exe", "-R"],
	);
	assert.deepEqual(
		parseEditorCommand(
			'"C:\\Program Files\\VS Code\\code.cmd" --wait',
			"win32",
		),
		["C:\\Program Files\\VS Code\\code.cmd", "--wait"],
	);
	assert.equal(
		quoteWindowsShellArg("C:\\Program Files\\code.cmd"),
		'"C:\\Program Files\\code.cmd"',
	);
	assert.equal(quoteWindowsShellArg("--wait"), "--wait");
	assert.equal(
		resolveFallbackEditorCommand({ VISUAL: "nvim" }, "darwin"),
		"nvim",
	);
	assert.equal(resolveFallbackEditorCommand({}, "darwin"), "nano");
	assert.equal(resolveFallbackEditorCommand({}, "win32"), "notepad");
	assert.equal(sanitizeFileExtension("typescript"), "ts");
	assert.equal(sanitizeFileExtension("bash"), "sh");
	assert.equal(sanitizeFileExtension("../../evil"), "evil");
});

test("launchExternalEditor writes 0600 temp file, cleans up after exit, and reports exit/launch errors", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "copy-block-editor-test with space-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));

	const recordPath = join(dir, "record.json");
	const scriptPath = join(dir, "fake editor.mjs");
	writeFileSync(
		scriptPath,
		`import fs from "node:fs";
const filePath = process.argv.at(-1);
const mode = fs.statSync(filePath).mode & 0o777;
const content = fs.readFileSync(filePath, "utf8");
fs.writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({ filePath, mode, content }));
if (process.argv.includes("--fail")) process.exit(2);
`,
		"utf8",
	);

	const okCmd = `"${process.execPath}" "${scriptPath}"`;
	const okRes = await launchExternalEditor(okCmd, '{"k": 1}', "json");
	assert.deepEqual(okRes, { ok: true });

	const recorded = JSON.parse(readFileSync(recordPath, "utf8")) as {
		filePath: string;
		mode: number;
		content: string;
	};
	assert.ok(recorded.filePath.endsWith("snippet.json"));
	assert.equal(recorded.content, '{"k": 1}');
	if (process.platform !== "win32") {
		assert.equal(recorded.mode, 0o600);
	}
	assert.equal(existsSync(dirname(recorded.filePath)), false);

	const failRes = await launchExternalEditor(
		`"${process.execPath}" "${scriptPath}" --fail`,
		"hello",
		"md",
	);
	assert.equal(failRes.ok, false);
	assert.match(failRes.message ?? "", /code 2/);

	const enoentRes = await launchExternalEditor(
		"/definitely-nonexistent-copy-block-editor-bin",
		"hello",
		"md",
	);
	assert.equal(enoentRes.ok, false);
	assert.match(enoentRes.message ?? "", /Failed to launch/);
});

test("CopyBlockPickerComponent respects height/width bounds across narrow, short, CJK, and hostile escape inputs", () => {
	const hostileMarkdown = [
		"```txt",
		"中文测试 🚀\tindented \x1b]0;evil-title\x07\x1b[2Jafter",
		"```",
	].join("\n");
	const messages = [{ index: 1, text: hostileMarkdown, preview: "中文" }];

	for (const rows of [12, 16, 20, 40]) {
		const picker = new CopyBlockPickerComponent({
			messages,
			initialMessageOffset: 0,
			tui: { requestRender: () => {}, terminal: { rows } },
			theme: plainTheme,
			keybindings: plainKeybindings,
			helpers: testHelpers(),
			onDone: () => {},
		});
		const maxAllowed = Math.floor(rows * 0.82);
		for (const width of [20, 30, 65]) {
			const lines = picker.render(width);
			assert.ok(
				lines.length <= maxAllowed,
				`rows=${rows} width=${width} rendered ${lines.length} > ${maxAllowed}`,
			);
			assert.ok(lines.at(-1)?.startsWith("╰"), `bottom border clipped at rows=${rows}`);
			for (const line of lines) {
				assert.equal(measureWidth(line), width, `width mismatch: ${line}`);
				assert.equal(/\x1b/.test(line), false, `unexpected raw ESC in ${line}`);
			}
		}
	}
});

test("CopyBlockPickerComponent navigates, scrolls list and preview, handles mouse, and dispatches all actions", () => {
	const longCode = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
	const manyBlocks = Array.from(
		{ length: 9 },
		(_, i) => `\`\`\`txt\nblock ${i + 1}\n\`\`\``,
	).join("\n\n");
	const messages = [
		{
			index: 1,
			text: `Latest:\n\`\`\`bash\n${longCode}\n\`\`\``,
			preview: "Latest:",
		},
		{
			index: 2,
			text: manyBlocks,
			preview: "Many blocks",
		},
	];

	const results: Array<CopyBlockPickerAction | undefined> = [];
	const picker = new CopyBlockPickerComponent({
		messages,
		initialMessageOffset: 0,
		tui: { requestRender: () => {}, terminal: { rows: 24 } },
		theme: plainTheme,
		keybindings: plainKeybindings,
		helpers: testHelpers(),
		onDone: (res) => results.push(res),
	});

	const initial = picker.render(70).join("\n");
	assert.match(initial, /lines 1-\d+\/30/);
	assert.match(initial, /line 1/);

	// Scroll preview down via Ctrl+D and verify range advances
	picker.handleInput("\x04");
	const scrolledDown = picker.render(70).join("\n");
	assert.doesNotMatch(scrolledDown, /lines 1-\d+\/30/);

	// Scroll way past end and clamp cleanly
	for (let i = 0; i < 20; i++) picker.handleInput("\x1b[6~");
	const atBottom = picker.render(70).join("\n");
	assert.match(atBottom, /30\/30/);
	assert.match(atBottom, /line 30/);

	// Scroll back up to top via Ctrl+U
	for (let i = 0; i < 20; i++) picker.handleInput("\x15");
	assert.match(picker.render(70).join("\n"), /lines 1-\d+\/30/);

	// Switch to older reply (index 2, 10 items: 9 code blocks + Full response)
	picker.handleInput("\x1b[D");
	const page1 = picker.render(70).join("\n");
	assert.match(page1, /Reply 2\/2/);
	// Move down to item 9 via number key to exercise list scroll window
	picker.handleInput("9");
	const scrolledList = picker.render(70).join("\n");
	assert.match(scrolledList, /▸ 9\. code · txt/);

	// Mouse click on visible list row selects; double-click copies
	picker.handleMouse({
		type: "click",
		button: "left",
		x: 5,
		y: 4,
		screenX: 5,
		screenY: 4,
		width: 70,
		height: 19,
		shift: false,
		alt: false,
		ctrl: false,
		clickCount: 1,
	});
	picker.handleMouse({
		type: "click",
		button: "left",
		x: 5,
		y: 4,
		screenX: 5,
		screenY: 4,
		width: 70,
		height: 19,
		shift: false,
		alt: false,
		ctrl: false,
		clickCount: 2,
	});
	assert.equal(results.at(-1)?.action, "copy");

	// Keyboard edit, shift+e edit full, f copy full, q cancel
	picker.handleInput("e");
	assert.equal(results.at(-1)?.action, "edit");
	assert.equal(results.at(-1)?.item.kind, "code");

	picker.handleInput("E");
	assert.equal(results.at(-1)?.action, "edit");
	assert.equal(results.at(-1)?.item.kind, "full");

	picker.handleInput("f");
	assert.equal(results.at(-1)?.action, "copy");
	assert.equal(results.at(-1)?.item.kind, "full");

	picker.handleInput("q");
	assert.equal(results.at(-1), undefined);
});

test("registerCopyBlock registers copy-block/alt+c, preserves editor draft on edit, passes ctx trust, and recovers TUI on error", async () => {
	let commandHandler:
		| ((args: string, ctx: ExtensionContext) => Promise<void>)
		| undefined;
	let shortcutHandler: ((ctx: ExtensionContext) => Promise<void>) | undefined;
	let registeredCommandName = "";
	let registeredShortcut = "";

	const pi = {
		registerCommand: (
			name: string,
			opts: { handler: (args: string, ctx: ExtensionContext) => Promise<void> },
		) => {
			registeredCommandName = name;
			commandHandler = opts.handler;
		},
		registerShortcut: (
			shortcut: string,
			opts: { handler: (ctx: ExtensionContext) => Promise<void> },
		) => {
			registeredShortcut = shortcut;
			shortcutHandler = opts.handler;
		},
	} as unknown as ExtensionAPI;

	const copied: string[] = [];
	const notices: Array<{ msg: string; level: string }> = [];
	const launched: Array<{ command: string; content: string; ext: string }> = [];
	const trustChecks: boolean[] = [];
	let copyShouldThrow = false;
	let launchShouldThrow = false;
	let tuiStops = 0;
	let tuiStarts = 0;
	let tuiFullRenders = 0;
	let nonOverlayCustomCalls = 0;
	let scriptedAction: CopyBlockPickerAction | undefined;

	registerCopyBlock(pi, {
		copyToClipboard: async (text) => {
			if (copyShouldThrow) throw new Error("clipboard denied");
			copied.push(text);
		},
		resolveEditorCommand: (ctx) => {
			trustChecks.push(ctx.isProjectTrusted());
			return "nvim";
		},
		launchEditor: async (
			command,
			content,
			ext,
		): Promise<EditorLaunchResult> => {
			if (launchShouldThrow) throw new Error("boom");
			launched.push({ command, content, ext });
			return { ok: true };
		},
		pickerHelpers: testHelpers(),
	});

	assert.equal(registeredCommandName, COPY_BLOCK_COMMAND);
	assert.equal(registeredShortcut, COPY_BLOCK_SHORTCUT);
	assert.equal(COPY_BLOCK_SHORTCUT, "alt+c");

	const branchEntries: unknown[] = [];
	let trusted = false;
	const makeCtx = (mode: "tui" | "rpc" = "tui"): ExtensionContext =>
		({
			hasUI: true,
			mode,
			cwd: "/tmp",
			isProjectTrusted: () => trusted,
			sessionManager: {
				getBranch: () => branchEntries,
			},
			ui: {
				notify: (msg: string, level = "info") => notices.push({ msg, level }),
				custom: async (
					factory: (
						tui: {
							stop: () => void;
							start: () => void;
							requestRender: (force?: boolean) => void;
						},
						theme: typeof plainTheme,
						kb: typeof plainKeybindings,
						done: (val: unknown) => void,
					) => unknown,
					options?: { overlay?: boolean },
				) => {
					if (!options?.overlay) {
						nonOverlayCustomCalls++;
					}
					const fakeTui = {
						stop: () => tuiStops++,
						start: () => tuiStarts++,
						requestRender: (force?: boolean) => {
							if (force) tuiFullRenders++;
						},
					};
					await factory(fakeTui, plainTheme, plainKeybindings, () => {});
					return scriptedAction;
				},
			},
		}) as unknown as ExtensionContext;

	// Non-TUI mode warns cleanly
	await commandHandler!("", makeCtx("rpc"));
	assert.match(notices.at(-1)?.msg ?? "", /requires interactive TUI mode/);

	// Empty session warns cleanly
	await commandHandler!("", makeCtx("tui"));
	assert.match(notices.at(-1)?.msg ?? "", /No assistant replies/);

	branchEntries.push({
		type: "message",
		message: {
			role: "assistant",
			content: [
				{
					type: "text",
					text: '1. Config:\n   ```json\n   {"ok": true}\n   ```',
				},
			],
		},
	});

	// Copy action succeeds
	scriptedAction = {
		action: "copy",
		item: {
			kind: "code",
			label: "code · json",
			lang: "json",
			content: '{"ok": true}',
			lineCount: 1,
			previewLine: '{"ok": true}',
		},
	};
	await shortcutHandler!(makeCtx("tui"));
	assert.deepEqual(copied, ['{"ok": true}']);
	assert.match(notices.at(-1)?.msg ?? "", /Copied code · json \(1 line\)/);

	// Copy failure notifies error
	copyShouldThrow = true;
	await shortcutHandler!(makeCtx("tui"));
	assert.equal(notices.at(-1)?.level, "error");
	assert.match(notices.at(-1)?.msg ?? "", /clipboard denied/);
	copyShouldThrow = false;

	// Edit action uses captured overlay TUI (no non-overlay custom() that would clobber editor draft)
	scriptedAction = {
		action: "edit",
		item: {
			kind: "code",
			label: "code · json",
			lang: "json",
			content: '{"ok": true}',
			lineCount: 1,
			previewLine: '{"ok": true}',
		},
	};
	await commandHandler!("1", makeCtx("tui"));
	assert.equal(nonOverlayCustomCalls, 0);
	assert.deepEqual(trustChecks, [false]);
	assert.equal(tuiStops, 1);
	assert.equal(tuiStarts, 1);
	assert.equal(tuiFullRenders, 1);
	assert.deepEqual(launched, [
		{ command: "nvim", content: '{"ok": true}', ext: "json" },
	]);

	// Throwing launcher still restarts TUI and surfaces warning instead of crashing
	trusted = true;
	launchShouldThrow = true;
	await commandHandler!("1", makeCtx("tui"));
	assert.deepEqual(trustChecks, [false, true]);
	assert.equal(tuiStops, 2);
	assert.equal(tuiStarts, 2);
	assert.equal(tuiFullRenders, 2);
	assert.equal(notices.at(-1)?.level, "warning");
	assert.match(notices.at(-1)?.msg ?? "", /boom/);
});
