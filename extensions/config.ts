/**
 * Persistent configuration for the ocr extension (spec R4).
 *
 * Precedence: defaults < JSON file. Per-run overrides (tool args / command
 * flags) are merged in the adapter and never written back. Env vars are not
 * used for engine selection on purpose — config file + tool args only, so
 * there is exactly one persistent source of truth.
 */

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { JsonStore } from "@maheidem/pi-panel-kit";

export const CONFIG_SCHEMA = "ocr/v1" as const;
export const CONFIG_PATH = join(getAgentDir(), "ocr", "config.json");

/**
 * Default transcription prompt — verbatim from the proven certidões
 * pipeline (qwen3.8-flash, 88/88 PDFs recovered where tesseract failed).
 */
export const DEFAULT_PROMPT =
	"Transcreva este documento EXATAMENTE como está escrito, preservando números de processo, CPFs, datas e pontuação. " +
	"Não resuma, não complete lacunas, não adicione nada. Se uma parte estiver ilegível, escreva [ILEGÍVEL]. " +
	"Saída: apenas o texto transcrito.";

export interface OcrConfig {
	schema: typeof CONFIG_SCHEMA;
	/** OpenAI-compatible base URL (including /v1) for engine calls. */
	baseUrl: string;
	/** Pinned model id used with baseUrl. Null = resolve session model (R3a). */
	model: string | null;
	/** Optional bearer token for the configured baseUrl. */
	apiKey: string | null;
	/** Fallback vision model (against baseUrl) when the session model has no image input (R3a). */
	defaultVisionModel: string | null;
	/** Request timeout per engine call, ms. */
	timeoutMs: number;
	/** Render resolution for PDF pages (dpi). */
	dpi: number;
	/** Retry resolution for failed pages (dpi ladder, R10). */
	dpiRetry: number;
	/** max_tokens sent to the engine. */
	maxTokens: number;
	/** Safety cap on pages per PDF (R-safety). */
	maxPages: number;
	/** Skip images larger than this many bytes (0 = no limit). */
	maxBytes: number;
	/** Above this many extracted characters the tool auto-forces summaryOnly (R1). */
	contextGuardChars: number;
	/** Input hook auto-OCR (R11). OFF by default — explicit tool use. */
	autoDetect: boolean;
	/** Overwrite existing sidecars instead of skipping (R5). */
	force: boolean;
	/** Keep rendered page PNGs for debugging instead of deleting them. */
	keepRenders: boolean;
	/** Minimum extracted characters for a PDF to count as having a text layer (R2). */
	textLayerMinChars: number;
	/** Transcription prompt. */
	prompt: string;
	/** Named validation regexes (R7): pass if absent, or present and matching >= min. */
	validators: Record<string, { pattern: string; min: number }>;
}

export const DEFAULT_CONFIG: OcrConfig = {
	schema: CONFIG_SCHEMA,
	baseUrl: "http://192.168.31.152:8123/v1",
	model: null,
	apiKey: null,
	defaultVisionModel: "qwen3.8-flash",
	timeoutMs: 300_000,
	dpi: 200,
	dpiRetry: 300,
	maxTokens: 4096,
	maxPages: 200,
	maxBytes: 0,
	contextGuardChars: 100_000,
	autoDetect: false,
	force: false,
	keepRenders: false,
	textLayerMinChars: 50,
	prompt: DEFAULT_PROMPT,
	validators: {},
};

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function coerceBool(value: unknown, fallback: boolean): boolean {
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		const s = value.trim().toLowerCase();
		if (["1", "true", "yes", "on"].includes(s)) return true;
		if (["0", "false", "no", "off"].includes(s)) return false;
	}
	return fallback;
}

function intInRange(value: unknown, min: number, max: number, fallback: number): number {
	const n = typeof value === "number" ? value : Number(value);
	return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

function nullableString(value: unknown): string | null {
	if (value === null) return null;
	if (typeof value === "string") {
		const s = value.trim();
		return s.length ? s : null;
	}
	return null;
}

/** Normalize a base URL to end with /v1 and no trailing slash. */
export function normalizeBaseUrl(input: string): string {
	let url = input.trim().replace(/\/+$/, "");
	if (!url) return DEFAULT_CONFIG.baseUrl;
	if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
	if (!/\/v1$/.test(url)) url = `${url}/v1`;
	return url;
}

function normalizeValidators(value: unknown, fallback: OcrConfig["validators"]): OcrConfig["validators"] {
	if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
	const out: OcrConfig["validators"] = {};
	for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
		if (typeof raw === "string") {
			out[name] = { pattern: raw, min: 1 };
			continue;
		}
		if (raw && typeof raw === "object" && typeof (raw as { pattern?: unknown }).pattern === "string") {
			const entry = raw as { pattern: string; min?: unknown };
			const min = intInRange(entry.min, 1, 10_000, 1);
			out[name] = { pattern: entry.pattern, min };
		}
	}
	return Object.keys(out).length ? out : fallback;
}

export function normalizeConfig(value: unknown, defaults: OcrConfig = DEFAULT_CONFIG): OcrConfig {
	const input = record(value);
	const baseUrl = typeof input.baseUrl === "string" && input.baseUrl.trim() ? normalizeBaseUrl(input.baseUrl) : defaults.baseUrl;
	const prompt = typeof input.prompt === "string" && input.prompt.trim() ? input.prompt : defaults.prompt;
	return {
		schema: CONFIG_SCHEMA,
		baseUrl,
		model: input.model === undefined ? defaults.model : nullableString(input.model),
		apiKey: input.apiKey === undefined ? defaults.apiKey : nullableString(input.apiKey),
		defaultVisionModel:
			input.defaultVisionModel === undefined ? defaults.defaultVisionModel : nullableString(input.defaultVisionModel),
		timeoutMs: intInRange(input.timeoutMs, 1_000, 3_600_000, defaults.timeoutMs),
		dpi: intInRange(input.dpi, 72, 1200, defaults.dpi),
		dpiRetry: intInRange(input.dpiRetry, 72, 1200, defaults.dpiRetry),
		maxTokens: intInRange(input.maxTokens, 256, 200_000, defaults.maxTokens),
		maxPages: intInRange(input.maxPages, 1, 10_000, defaults.maxPages),
		maxBytes: intInRange(input.maxBytes, 0, 2 ** 40, defaults.maxBytes),
		contextGuardChars: intInRange(input.contextGuardChars, 1_000, 10_000_000, defaults.contextGuardChars),
		autoDetect: coerceBool(input.autoDetect, defaults.autoDetect),
		force: coerceBool(input.force, defaults.force),
		keepRenders: coerceBool(input.keepRenders, defaults.keepRenders),
		textLayerMinChars: intInRange(input.textLayerMinChars, 0, 100_000, defaults.textLayerMinChars),
		prompt,
		validators: normalizeValidators(input.validators, defaults.validators),
	};
}

const store = new JsonStore<OcrConfig>({
	path: CONFIG_PATH,
	defaults: DEFAULT_CONFIG,
	normalize: normalizeConfig,
});

export function loadConfig(): OcrConfig {
	return store.load();
}

export function saveConfig(value: OcrConfig): OcrConfig {
	return store.save(value);
}

export function resetConfig(): OcrConfig {
	return store.reset();
}
