/**
 * image-gen — multi-provider image generation for pi
 *
 * Provider selection follows the **current session** model:
 *   - session provider is xai     → Grok Imagine
 *   - session provider is openai  → OpenAI Images (stub until wired)
 *   - otherwise                   → error (switch model /login first)
 *
 * If the active model id is already an image model for that provider, use it;
 * otherwise fall back to the provider's default image model.
 *
 * Optional tool params still override: provider, model, aspectRatio, n, save.
 *
 * Usage:
 *   "Generate a golden retriever"
 *   /img a golden retriever
 *
 * Save (tool param or env only — no config file):
 *   save=none|project|global|custom  (default: global)
 *   PI_IMAGE_SAVE_MODE / PI_IMAGE_SAVE_DIR
 */

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

const PROVIDERS = ["xai", "openai"] as const;
const ASPECT_RATIOS = [
	"1:1",
	"3:4",
	"4:3",
	"9:16",
	"16:9",
	"2:3",
	"3:2",
	"9:19.5",
	"19.5:9",
] as const;
const SAVE_MODES = ["none", "project", "global", "custom"] as const;
const DEFAULT_ASPECT_RATIO = "1:1";
const DEFAULT_SAVE_MODE = "global";
const REQUEST_TIMEOUT_MS = 120_000;
const MAX_RATE_LIMIT_RETRIES = 3;
const BASE_RETRY_WAIT_MS = 2_000;
const MAX_RETRY_WAIT_MS = 30_000;
const OVERALL_TIMEOUT_MS = 300_000;

type Provider = (typeof PROVIDERS)[number];
type AspectRatio = (typeof ASPECT_RATIOS)[number];
type SaveMode = (typeof SAVE_MODES)[number];

interface ProviderSpec {
	label: string;
	authHint: string;
	defaultImageModel: string;
	/** Model ids (or prefixes) that count as image models for this provider. */
	imageModels: readonly string[];
	imageModelPrefixes: readonly string[];
}

const PROVIDER_SPECS: Record<Provider, ProviderSpec> = {
	xai: {
		label: "xAI",
		authHint: "Run `/login xai` and choose subscription (or API key).",
		defaultImageModel: "grok-imagine-image",
		imageModels: ["grok-imagine-image", "grok-imagine-image-quality"],
		imageModelPrefixes: ["grok-imagine"],
	},
	openai: {
		label: "OpenAI",
		authHint: "Run `/login openai` (or set OPENAI_API_KEY).",
		defaultImageModel: "gpt-image-1",
		imageModels: ["gpt-image-1", "dall-e-3", "dall-e-2"],
		imageModelPrefixes: ["gpt-image", "dall-e"],
	},
};

const TOOL_PARAMS = Type.Object({
	prompt: Type.String({ description: "Image description / prompt." }),
	provider: Type.Optional(
		StringEnum(PROVIDERS, {
			description:
				"Override image provider. Default: follow current session provider when it supports image gen.",
		}),
	),
	model: Type.Optional(
		Type.String({
			description:
				"Override image model id. Default: session model if it is an image model, else provider default (xAI: grok-imagine-image; OpenAI: gpt-image-1).",
		}),
	),
	aspectRatio: Type.Optional(StringEnum(ASPECT_RATIOS)),
	n: Type.Optional(
		Type.Number({
			description: "Number of images to generate (1-4). Default: 1.",
			minimum: 1,
			maximum: 4,
		}),
	),
	save: Type.Optional(StringEnum(SAVE_MODES)),
	saveDir: Type.Optional(
		Type.String({
			description: "Directory when save=custom. Falls back to PI_IMAGE_SAVE_DIR.",
		}),
	),
});

type ToolParams = Static<typeof TOOL_PARAMS>;

interface SaveConfig {
	mode: SaveMode;
	outputDir?: string;
}

interface ImageItem {
	b64_json?: string;
	url?: string;
	mime_type?: string;
}

interface ProviderImageResponse {
	data?: ImageItem[];
	error?: { message?: string; code?: string } | string;
}

interface GeneratedImage {
	bytes: Buffer;
	mimeType: string;
	b64: string;
}

interface GenerateRequest {
	apiKey: string;
	model: string;
	prompt: string;
	aspectRatio: AspectRatio;
	n: number;
	signal?: AbortSignal;
	onRetry?: (message: string) => void;
}

interface SessionModelRef {
	provider?: string;
	id?: string;
}

function isProvider(value: string): value is Provider {
	return (PROVIDERS as readonly string[]).includes(value);
}

function isImageModel(provider: Provider, modelId: string): boolean {
	const spec = PROVIDER_SPECS[provider];
	const id = modelId.toLowerCase();
	if (spec.imageModels.some((m) => m.toLowerCase() === id)) return true;
	return spec.imageModelPrefixes.some((p) => id.startsWith(p.toLowerCase()));
}

/**
 * Pick provider from explicit tool param, else current session provider
 * when it is a known image provider.
 */
function resolveProvider(
	params: ToolParams,
	session: SessionModelRef | undefined,
): Provider {
	if (params.provider) {
		const raw = params.provider.toLowerCase();
		if (!isProvider(raw)) {
			throw new Error(
				`Unknown image provider "${params.provider}". Supported: ${PROVIDERS.join(", ")}`,
			);
		}
		return raw;
	}

	const sessionProvider = (session?.provider || "").toLowerCase();
	if (isProvider(sessionProvider)) return sessionProvider;

	const supported = PROVIDERS.join(", ");
	const current = session?.provider
		? `${session.provider}/${session.id ?? "?"}`
		: "(no model)";
	throw new Error(
		`Current session provider does not support image generation (${current}). Switch to one of: ${supported}, or pass provider= explicitly.`,
	);
}

/**
 * Model: tool override → session model if it is an image model → provider default.
 */
function resolveModel(
	params: ToolParams,
	provider: Provider,
	session: SessionModelRef | undefined,
): string {
	if (params.model?.trim()) return params.model.trim();

	const sessionId = session?.id?.trim();
	if (sessionId && isImageModel(provider, sessionId)) return sessionId;

	return PROVIDER_SPECS[provider].defaultImageModel;
}

function isSaveMode(value: string): value is SaveMode {
	return (SAVE_MODES as readonly string[]).includes(value);
}

function resolveSaveConfig(params: ToolParams, cwd: string): SaveConfig {
	const envMode = (process.env.PI_IMAGE_SAVE_MODE || "").toLowerCase();
	const requested = params.save || envMode || DEFAULT_SAVE_MODE;
	// Invalid env values fall back to the default mode (with its outputDir).
	const mode: SaveMode = isSaveMode(requested) ? requested : DEFAULT_SAVE_MODE;

	switch (mode) {
		case "none":
			return { mode };
		case "project":
			return { mode, outputDir: join(cwd, ".pi", "generated-images") };
		case "global":
			return { mode, outputDir: join(getAgentDir(), "generated-images") };
		case "custom": {
			const dir = params.saveDir || process.env.PI_IMAGE_SAVE_DIR;
			if (!dir?.trim()) {
				throw new Error("save=custom requires saveDir or PI_IMAGE_SAVE_DIR.");
			}
			return { mode, outputDir: dir };
		}
	}
}

function imageExtension(mimeType: string): string {
	const lower = mimeType.toLowerCase();
	if (lower.includes("jpeg") || lower.includes("jpg")) return "jpg";
	if (lower.includes("webp")) return "webp";
	if (lower.includes("gif")) return "gif";
	return "png";
}

function slugify(text: string): string {
	return (
		text
			.toLowerCase()
			.replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 40) || "image"
	);
}

async function saveImage(
	bytes: Buffer,
	mimeType: string,
	outputDir: string,
	prompt: string,
): Promise<string> {
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const ext = imageExtension(mimeType);
	const filename = `${slugify(prompt)}-${timestamp}-${randomUUID().slice(0, 8)}.${ext}`;
	const filePath = join(outputDir, filename);
	await mkdir(outputDir, { recursive: true });
	await writeFile(filePath, bytes);
	return filePath;
}

/** Caller abort + default timeout, so a hung provider can't stall the tool forever. */
function withTimeout(
	signal: AbortSignal | undefined,
	ms = REQUEST_TIMEOUT_MS,
): AbortSignal {
	const timeout = AbortSignal.timeout(ms);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function resolveImageBytes(
	item: ImageItem,
	signal: AbortSignal,
): Promise<GeneratedImage> {
	if (item.b64_json) {
		const mimeType = item.mime_type || "image/png";
		return {
			bytes: Buffer.from(item.b64_json, "base64"),
			mimeType,
			b64: item.b64_json,
		};
	}
	if (item.url) {
		// Image URLs are often CDN-presigned and redirect; follow them.
		const res = await fetch(item.url, { signal });
		if (!res.ok) {
			throw new Error(`Failed to download image url (${res.status})`);
		}
		const mimeType =
			item.mime_type || res.headers.get("content-type") || "image/png";
		const bytes = Buffer.from(await res.arrayBuffer());
		return { bytes, mimeType, b64: bytes.toString("base64") };
	}
	throw new Error("Image response missing b64_json and url");
}

function parseProviderError(
	status: number,
	raw: string,
	parsed: ProviderImageResponse,
): Error {
	const errMsg =
		typeof parsed.error === "string"
			? parsed.error
			: parsed.error?.message || raw.slice(0, 400);
	return new Error(`Image request failed (${status}): ${errMsg}`);
}

/**
 * Wait hint from a 429: Retry-After (seconds or HTTP-date), else
 * x-ratelimit-reset (unix seconds or ms). Undefined → caller backs off.
 */
function parseRetryAfterMs(response: Response): number | undefined {
	const retryAfter = response.headers.get("retry-after");
	if (retryAfter) {
		const seconds = Number(retryAfter);
		if (Number.isFinite(seconds)) {
			const ms = seconds * 1000;
			// Negative or overflowing values are invalid, not "retry now".
			if (seconds >= 0 && Number.isFinite(ms)) return ms;
		} else {
			const date = Date.parse(retryAfter);
			if (!Number.isNaN(date) && date > Date.now()) return date - Date.now();
		}
	}
	const reset = response.headers.get("x-ratelimit-reset");
	if (reset) {
		const value = Number(reset);
		if (Number.isFinite(value) && value > 0) {
			const ms = (value > 1e12 ? value : value * 1000) - Date.now();
			if (ms > 0 && Number.isFinite(ms)) return ms;
		}
	}
	return undefined;
}

function rateLimitHint(response: Response): string {
	const remaining = response.headers.get("x-ratelimit-remaining");
	const resetMs = parseRetryAfterMs(response);
	const parts: string[] = [];
	if (remaining !== null) parts.push(`remaining=${remaining}`);
	if (resetMs !== undefined)
		parts.push(`resets in ~${Math.ceil(resetMs / 1000)}s`);
	return parts.length ? ` (${parts.join(", ")})` : "";
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal?.reason ?? new Error("Aborted while waiting to retry"));
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		if (signal?.aborted) return onAbort();
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

async function generateWithXai(
	req: GenerateRequest,
): Promise<GeneratedImage[]> {
	// Overall budget across all attempts and rate-limit waits, on top of
	// the per-attempt request timeout.
	const overallSignal = withTimeout(req.signal, OVERALL_TIMEOUT_MS);
	for (let attempt = 0; ; attempt++) {
		const signal = withTimeout(overallSignal, REQUEST_TIMEOUT_MS);
		const response = await fetch("https://api.x.ai/v1/images/generations", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${req.apiKey}`,
				"Content-Type": "application/json",
				Accept: "application/json",
				"User-Agent": "pi-image-gen/0.3",
			},
			body: JSON.stringify({
				model: req.model,
				prompt: req.prompt,
				n: req.n,
				aspect_ratio: req.aspectRatio,
				response_format: "b64_json",
			}),
			signal,
			redirect: "error",
		});

		if (response.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
			const hint = rateLimitHint(response);
			const hintedMs = parseRetryAfterMs(response);
			await response.body?.cancel();
			// Cancellation during body cleanup must win over the
			// rate-limit errors below.
			overallSignal.throwIfAborted();
			// When the server asks for a wait longer than we're willing to
			// retry through, surface that instead of burning retries.
			if (hintedMs !== undefined && hintedMs > MAX_RETRY_WAIT_MS) {
				throw new Error(
					`Image request rate limited (429)${hint}: server asks to wait ~${Math.ceil(hintedMs / 1000)}s — not retrying automatically, try again later.`,
				);
			}
			const waitMs = Math.min(
				hintedMs ?? BASE_RETRY_WAIT_MS * 2 ** attempt,
				MAX_RETRY_WAIT_MS,
			);
			try {
				req.onRetry?.(
					`Rate limited by xAI${hint}. Retrying in ${Math.ceil(waitMs / 1000)}s (${attempt + 1}/${MAX_RATE_LIMIT_RETRIES})...`,
				);
			} catch {
				// Progress notification must not break the retry loop.
			}
			await sleep(waitMs, overallSignal);
			continue;
		}

		const raw = await response.text();
		let parsed: ProviderImageResponse;
		try {
			parsed = JSON.parse(raw) as ProviderImageResponse;
		} catch {
			throw new Error(
				`Image request failed (${response.status}): invalid JSON response`,
			);
		}

		if (response.status === 429) {
			const err = parseProviderError(response.status, raw, parsed);
			throw new Error(
				`${err.message}${rateLimitHint(response)} — gave up after ${MAX_RATE_LIMIT_RETRIES} retries`,
			);
		}
		if (!response.ok) throw parseProviderError(response.status, raw, parsed);

		const items = parsed.data ?? [];
		if (items.length === 0) {
			throw new Error("No image data returned by xAI");
		}
		return Promise.all(items.map((item) => resolveImageBytes(item, signal)));
	}
}

/** OpenAI Images API — implement when you switch session to openai regularly. */
async function generateWithOpenAI(
	_req: GenerateRequest,
): Promise<GeneratedImage[]> {
	throw new Error(
		"OpenAI image provider is not implemented yet. Stay on an xAI model, or implement generateWithOpenAI.",
	);
}

async function generateImages(
	provider: Provider,
	req: GenerateRequest,
): Promise<GeneratedImage[]> {
	switch (provider) {
		case "xai":
			return generateWithXai(req);
		case "openai":
			return generateWithOpenAI(req);
		default: {
			const _exhaustive: never = provider;
			throw new Error(`Unhandled provider: ${_exhaustive}`);
		}
	}
}

export default function imageGen(pi: ExtensionAPI) {
	pi.registerTool({
		name: "generate_image",
		label: "Generate image",
		description:
			"Generate an image using the current session's provider when it supports image gen (xAI Grok Imagine today; OpenAI later). Uses the session image model if active, otherwise the provider default image model. Use when the user asks to draw/generate/create an image, illustration, photo, wallpaper, or icon.",
		promptSnippet: "Generate images via the active session provider",
		promptGuidelines: [
			"Use generate_image when the user asks to generate, draw, or create an image.",
			"Prefer generate_image over ASCII art or SVG placeholders for photorealistic requests.",
			"Provider follows the current session (xai → Grok Imagine). Do not pass provider/model unless the user explicitly asks for a different backend or quality model (e.g. grok-imagine-image-quality).",
		],
		parameters: TOOL_PARAMS,
		async execute(_toolCallId, params: ToolParams, signal, onUpdate, ctx) {
			const session: SessionModelRef | undefined = ctx.model
				? { provider: ctx.model.provider, id: ctx.model.id }
				: undefined;

			const provider = resolveProvider(params, session);
			const spec = PROVIDER_SPECS[provider];
			const apiKey = await ctx.modelRegistry.getApiKeyForProvider(provider);
			if (!apiKey) {
				throw new Error(`Missing ${spec.label} credentials. ${spec.authHint}`);
			}

			const model = resolveModel(params, provider, session);
			const aspectRatio = (params.aspectRatio ||
				DEFAULT_ASPECT_RATIO) as AspectRatio;
			const n = Math.min(4, Math.max(1, Math.floor(params.n ?? 1)));

			onUpdate?.({
				content: [
					{
						type: "text",
						text: `Requesting image from ${spec.label}/${model}...`,
					},
				],
				details: {
					provider,
					model,
					aspectRatio,
					n,
					sessionProvider: session?.provider,
					sessionModel: session?.id,
				},
			});

			const images = await generateImages(provider, {
				apiKey,
				model,
				prompt: params.prompt,
				aspectRatio,
				n,
				signal,
				onRetry: (message) => {
					onUpdate?.({ content: [{ type: "text", text: message }] });
				},
			});

			const saveConfig = resolveSaveConfig(params, ctx.cwd);
			const content: Array<
				| { type: "text"; text: string }
				| { type: "image"; data: string; mimeType: string }
			> = [];
			const savedPaths: string[] = [];
			const saveErrors: string[] = [];

			for (const image of images) {
				if (saveConfig.mode !== "none" && saveConfig.outputDir) {
					try {
						const path = await saveImage(
							image.bytes,
							image.mimeType,
							saveConfig.outputDir,
							params.prompt,
						);
						savedPaths.push(path);
					} catch (error) {
						saveErrors.push(error instanceof Error ? error.message : String(error));
					}
				}
				content.push({
					type: "image",
					data: image.b64,
					mimeType: image.mimeType,
				});
			}

			const summary = [
				`Generated ${images.length} image(s) via ${spec.label}/${model}.`,
				`Aspect ratio: ${aspectRatio}.`,
				session?.id && model !== session.id
					? `Session model: ${session.provider}/${session.id}.`
					: "",
				savedPaths.length ? `Saved: ${savedPaths.join(", ")}` : "",
				saveErrors.length ? `Save errors: ${saveErrors.join("; ")}` : "",
			]
				.filter(Boolean)
				.join(" ");

			content.unshift({ type: "text", text: summary });

			return {
				content,
				details: {
					provider,
					model,
					aspectRatio,
					n: images.length,
					savedPaths,
					saveMode: saveConfig.mode,
					sessionProvider: session?.provider,
					sessionModel: session?.id,
				},
			};
		},
	});

	pi.registerCommand("img", {
		description:
			"Generate an image using the current session provider (xAI / OpenAI when available)",
		handler: async (args, ctx) => {
			const prompt = (args || "").trim();
			if (!prompt) {
				ctx.ui.notify(
					"Usage: /img <prompt>  e.g. /img a golden retriever",
					"error",
				);
				return;
			}
			await pi.sendUserMessage(
				`Use generate_image to create an image with this prompt: ${prompt}`,
			);
		},
	});
}
