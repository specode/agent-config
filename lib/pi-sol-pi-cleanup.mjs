import { lstatSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// Only emit absent entries. The shared installer owns consent, backup and rollback.
function retiredEntries(home) {
	const entries = [];
	const stat = (path) => {
		try {
			return lstatSync(path);
		} catch (error) {
			if (error.code === "ENOENT") return undefined;
			throw error;
		}
	};
	const checkParents = (relative) => {
		let path = home;
		for (const part of dirname(relative).split("/")) {
			path = join(path, part);
			const info = stat(path);
			if (!info) break;
			if (info.isSymbolicLink() || !info.isDirectory()) {
				throw new Error(`Cleanup parent must be a real directory: ${path}`);
			}
		}
	};
	const add = (relative, kind, label) => {
		if (/[|\r\n]/u.test(relative)) {
			throw new Error("Cleanup path cannot be represented in the install manifest");
		}
		checkParents(relative);
		if (stat(join(home, relative))) {
			entries.push(`-|${relative}|absent|-|${kind}|${label}`);
		}
	};

	add(".pi/agent/sol-pi.json", "配置", "SoL-Pi 旧配置");
	// A Git package's dependencies and npm manifests live inside its checkout.
	// Moving the entire checkout retires them without running package scripts.
	add(".pi/agent/git/github.com/NVlabs/SoL-Pi", "插件", "SoL-Pi 旧安装包");

	const sessions = ".pi/agent/sessions";
	checkParents(`${sessions}/placeholder`);
	const visit = (relative) => {
		for (const entry of readdirSync(join(home, relative), { withFileTypes: true })) {
			const child = `${relative}/${entry.name}`;
			if (entry.name === "sol-pi" && (entry.isDirectory() || entry.isSymbolicLink())) {
				// Move a cache symlink itself; never traverse its external target.
				add(child, "配置", "SoL-Pi 专属缓存");
			} else if (entry.isDirectory()) {
				visit(child);
			}
		}
	};
	if (stat(join(home, sessions))) visit(sessions);
	return entries;
}

try {
	if (process.argv.length !== 3) throw new Error("An explicit installation home is required");
	const entries = retiredEntries(resolve(process.argv[2]));
	if (entries.length) process.stdout.write(`${entries.join("\n")}\n`);
} catch (error) {
	console.error(`Cannot plan SoL-Pi cleanup: ${error.message}`);
	process.exitCode = 1;
}
