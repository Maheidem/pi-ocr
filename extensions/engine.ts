/**
 * Engine resolution (spec R3/R3a) and OpenAI-compatible vision calls.
 *
 * One model call per page: POST {baseUrl}/chat/completions with an inline
 * base64 data-URL image plus the transcription prompt. Pi-free — the
 * session-model snapshot is passed in by the adapter.
 */

import { normalizeBaseUrl } from "./config.ts";

/** Snapshot of pi's current driving model, supplied by the adapter (R3a). */
export interface SessionModelInfo {
	id: string;
	provider: string;
	/** pi-ai api id; only OpenAI-completions APIs accept our envelope. */
	api: string;
	/** Provider base URL (usually already /v1-terminated). */
	baseUrl: string;
	input: string[];
	apiKey?: string;
	headers?: Record<string, string>;
}

export interface Engine {
	baseUrl: string;
	model: string;
	apiKey?: string;
	headers?: Record<string, string>;
	source: "tool-arg" | "config" | "session-model" | "default-vision-model";
}

export type EngineResolution = { engine: Engine } | { error: string };

/**
 * Resolution order (R3a, user decision 2026-10-01):
 *   tool arg > config `model` > session model (if image-capable) >
 *   config `defaultVisionModel` > error.
 */
export function resolveEngine(
	cfg: { baseUrl: string; model: string | null; apiKey: string | null; defaultVisionModel: string | null },
	overrideModel?: string,
	sessionModel?: SessionModelInfo,
): EngineResolution {
	if (overrideModel && overrideModel.trim()) {
		return {
			engine: {
				baseUrl: cfg.baseUrl,
				model: overrideModel.trim(),
				apiKey: cfg.apiKey ?? undefined,
				source: "tool-arg",
			},
		};
	}
	if (cfg.model) {
		return {
			engine: { baseUrl: cfg.baseUrl, model: cfg.model, apiKey: cfg.apiKey ?? undefined, source: "config" },
		};
	}
	if (sessionModel) {
		const visionCapable = sessionModel.input.includes("image");
		const openaiCompatible = sessionModel.api === "openai-completions";
		if (visionCapable && openaiCompatible) {
			return {
				engine: {
					baseUrl: normalizeBaseUrl(sessionModel.baseUrl),
					model: sessionModel.id,
					apiKey: sessionModel.apiKey,
					headers: sessionModel.headers,
					source: "session-model",
				},
			};
		}
		if (visionCapable && !openaiCompatible) {
			// Fall through to defaultVisionModel, but say why in that error.
			if (!cfg.defaultVisionModel) {
				return {
					error:
						`The current session model (${sessionModel.id}) accepts images but its API (${sessionModel.api}) is not OpenAI-compatible, ` +
						`and no defaultVisionModel is configured. Set one with /ocr.`,
				};
			}
		}
		if (!visionCapable && !cfg.defaultVisionModel) {
			return {
				error:
					`The current session model (${sessionModel.id}) does not declare image input and no defaultVisionModel is configured. ` +
					`Configure one with /ocr (e.g. a local vision model) or pass model explicitly.`,
			};
		}
	}
	if (cfg.defaultVisionModel) {
		return {
			engine: {
				baseUrl: cfg.baseUrl,
				model: cfg.defaultVisionModel,
				apiKey: cfg.apiKey ?? undefined,
				source: "default-vision-model",
			},
		};
	}
	return {
		error: "No OCR engine available: no model override, no config model, no vision-capable session model, and no defaultVisionModel. Configure with /ocr.",
	};
}

export interface EngineCallResult {
	text: string;
	latencyMs: number;
}

/** OCR one image through chat/completions. Never throws; errors as strings. */
export async function ocrImage(
	engine: Engine,
	image: { mime: string; bytes: Uint8Array },
	prompt: string,
	maxTokens: number,
	timeoutMs: number,
	signal?: AbortSignal,
	fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; result: EngineCallResult } | { ok: false; error: string }> {
	const url = `${engine.baseUrl.replace(/\/+$/, "")}/chat/completions`;
	const body = {
		model: engine.model,
		max_tokens: maxTokens,
		messages: [
			{
				role: "user",
				content: [
					{ type: "image_url", image_url: { url: `data:${image.mime};base64,${Buffer.from(image.bytes).toString("base64")}` } },
					{ type: "text", text: prompt },
				],
			},
		],
	};
	const headers: Record<string, string> = { "content-type": "application/json", ...(engine.headers ?? {}) };
	if (engine.apiKey) headers.authorization = `Bearer ${engine.apiKey}`;

	const started = Date.now();
	const timeout = AbortSignal.any?.([signal ?? new AbortController().signal, AbortSignal.timeout(timeoutMs)]);
	try {
		const res = await fetchImpl(url, { method: "POST", headers, body: JSON.stringify(body), signal: timeout });
		const raw = await res.text();
		if (!res.ok) {
			// oMLX quirk: failures arrive as HTTP 500 with a prose body.
			return { ok: false, error: `HTTP ${res.status}: ${raw.slice(0, 200)}` };
		}
		const json = JSON.parse(raw) as { choices?: Array<{ message?: { content?: unknown } }> };
		const content = json.choices?.[0]?.message?.content;
		const text = typeof content === "string" ? content : Array.isArray(content)
			? content.map((part) => (part && typeof part === "object" && "text" in (part as Record<string, unknown>) ? String((part as { text: unknown }).text) : "")).join("")
			: "";
		if (!text.trim()) return { ok: false, error: "empty completion" };
		return { ok: true, result: { text, latencyMs: Date.now() - started } };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}
