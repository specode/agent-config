export type StatuslineOverflow = "drop-right" | "priority";

export interface StatuslineLayoutItem {
	id: string;
	priority: number;
	required: boolean;
	value: string;
	width: number;
	compactValue?: string;
	compactWidth?: number;
}

export interface McpStatusView {
	connectedCount: number;
	enabledCount: number;
	connectedNames: string[];
}

function totalWidth(
	items: readonly StatuslineLayoutItem[],
	separatorWidth: number,
): number {
	if (items.length === 0) return 0;
	return (
		items.reduce((total, item) => total + item.width, 0) +
		separatorWidth * (items.length - 1)
	);
}

/** Selects and optionally compacts statusline items without knowing about ANSI. */
export function fitStatuslineItems(
	items: readonly StatuslineLayoutItem[],
	width: number,
	separatorWidth: number,
	overflow: StatuslineOverflow,
): StatuslineLayoutItem[] {
	if (width <= 0 || items.length === 0) return [];
	const active = items.map((item) => ({ ...item }));

	if (overflow === "drop-right") {
		for (let count = active.length; count >= 1; count--) {
			const prefix = active.slice(0, count);
			if (totalWidth(prefix, separatorWidth) <= width) return prefix;
		}
		return [active[0]!];
	}

	if (totalWidth(active, separatorWidth) <= width) return active;
	const lowPriorityFirst = [...active].sort((a, b) => a.priority - b.priority);

	for (const candidate of lowPriorityFirst) {
		if (
			candidate.compactValue === undefined ||
			candidate.compactWidth === undefined ||
			candidate.compactValue === candidate.value
		) {
			continue;
		}
		candidate.value = candidate.compactValue;
		candidate.width = candidate.compactWidth;
		if (totalWidth(active, separatorWidth) <= width) return active;
	}

	for (const candidate of lowPriorityFirst) {
		if (candidate.required) continue;
		const index = active.findIndex((item) => item.id === candidate.id);
		if (index >= 0) active.splice(index, 1);
		if (totalWidth(active, separatorWidth) <= width) return active;
	}

	return active;
}

function escapeRegexLiteral(value: string): string {
	return value.replace(/[\\^$+?.()|[\]{}]/g, "\\$&");
}

/** Matches an extension status id; `*` is the only wildcard. */
export function matchesStatusPattern(id: string, pattern: string): boolean {
	const source = pattern
		.split("*")
		.map((part) => escapeRegexLiteral(part))
		.join(".*");
	return new RegExp(`^${source}$`).test(id);
}

export function isExtensionStatusExcluded(
	id: string,
	patterns: readonly string[],
): boolean {
	return patterns.some((pattern) => matchesStatusPattern(id, pattern));
}

export function findUnknownStatusSegments(
	configured: readonly string[],
	registered: ReadonlySet<string>,
): string[] {
	return configured.filter((id) => !registered.has(id));
}

function sanitizeStatusText(value: string): string {
	return value
		.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

export function parseMcpFooterText(text: string): McpStatusView | undefined {
	const raw = sanitizeStatusText(text);
	const compact = raw.match(/^MCP\s+(\d+)\s*\/\s*(\d+)$/i);
	if (compact) {
		return {
			connectedCount: Number(compact[1]),
			enabledCount: Number(compact[2]),
			connectedNames: [],
		};
	}

	const body = raw
		.replace(/^🔌\s*/u, "")
		.replace(/^MCP[:\s]+/i, "")
		.trim();
	const full = body.match(
		/^(\d+)\s+servers?\s+enabled(?:\s+\((\d+)\s+connected\))?/i,
	);
	if (!full) return undefined;
	return {
		connectedCount: full[2] ? Number(full[2]) : 0,
		enabledCount: Number(full[1]),
		connectedNames: [],
	};
}

/** Decodes the versioned pi-mcp-adapter status event at its boundary. */
export function parseMcpStatusEvent(data: unknown): McpStatusView | undefined {
	if (typeof data !== "object" || data === null) return undefined;
	const snapshot = data as {
		servers?: unknown;
		connectedCount?: unknown;
		disabledCount?: unknown;
	};
	const servers = Array.isArray(snapshot.servers) ? snapshot.servers : [];
	const connectedNames = servers
		.flatMap((server) => {
			if (typeof server !== "object" || server === null) return [];
			const { name, status } = server as {
				name?: unknown;
				status?: unknown;
			};
			return status === "connected" && typeof name === "string" ? [name] : [];
		})
		.sort((a, b) => a.localeCompare(b));
	const disabledCount =
		typeof snapshot.disabledCount === "number" ? snapshot.disabledCount : 0;
	const connectedCount =
		typeof snapshot.connectedCount === "number"
			? snapshot.connectedCount
			: connectedNames.length;
	const enabledCount = Math.max(0, servers.length - disabledCount);
	if (enabledCount <= 0 && connectedCount <= 0 && servers.length === 0) {
		return undefined;
	}
	return { connectedCount, enabledCount, connectedNames };
}
