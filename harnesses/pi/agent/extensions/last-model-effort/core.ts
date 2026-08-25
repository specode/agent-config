import type {
	ExtensionAPI,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";

export type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;
export type ThinkingLevelGuard = (value: unknown) => value is ThinkingLevel;

export interface LastModelEffortState {
	version: 1;
	provider: string;
	modelId: string;
	thinkingLevel: ThinkingLevel;
	updatedAt: string;
}

export class RestoreThinkingEventGate {
	private restoring = false;
	private observedDuringRestore = 0;
	private pendingFromRestore = 0;

	get isRestoring(): boolean {
		return this.restoring;
	}

	begin(): void {
		this.restoring = true;
	}

	end(): void {
		this.restoring = false;
	}

	async track<T>(
		currentLevel: () => ThinkingLevel,
		operation: () => T | Promise<T>,
	): Promise<T> {
		const before = currentLevel();
		const observedBefore = this.observedDuringRestore;
		try {
			return await operation();
		} finally {
			if (
				currentLevel() !== before &&
				this.observedDuringRestore === observedBefore
			) {
				this.pendingFromRestore++;
			}
		}
	}

	shouldSuppressThinkingEvent(): boolean {
		if (this.restoring) {
			this.observedDuringRestore++;
			return true;
		}
		if (this.pendingFromRestore > 0) {
			this.pendingFromRestore--;
			return true;
		}
		return false;
	}
}

export type SessionStartReason = SessionStartEvent["reason"];

export function parseLastModelEffortState(
	value: unknown,
	isThinkingLevel: ThinkingLevelGuard,
): LastModelEffortState | undefined {
	if (!value || typeof value !== "object") return undefined;

	const candidate = value as Partial<LastModelEffortState>;
	if (
		candidate.version !== 1 ||
		typeof candidate.provider !== "string" ||
		candidate.provider.trim() === "" ||
		typeof candidate.modelId !== "string" ||
		candidate.modelId.trim() === "" ||
		!isThinkingLevel(candidate.thinkingLevel) ||
		typeof candidate.updatedAt !== "string" ||
		Number.isNaN(Date.parse(candidate.updatedAt))
	) {
		return undefined;
	}

	return {
		version: 1,
		provider: candidate.provider,
		modelId: candidate.modelId,
		thinkingLevel: candidate.thinkingLevel,
		updatedAt: candidate.updatedAt,
	};
}

export function hasModelThinkingSuffix(
	model: string | undefined,
	isThinkingLevel: ThinkingLevelGuard,
): boolean {
	if (!model) return false;
	const separator = model.lastIndexOf(":");
	return separator >= 0 && isThinkingLevel(model.slice(separator + 1));
}

export function shouldRestoreLastSelection(
	reason: SessionStartReason,
	hasSessionRestore: boolean,
	hasConversation: boolean,
): boolean {
	if (reason === "new") return true;
	if (reason !== "startup" || hasSessionRestore) return false;
	return !hasConversation;
}
