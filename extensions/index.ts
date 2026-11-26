/**
 * ocr — Pi OCR extension. The R ids in comments refer to the design spec
 * (ocr-2026-10-01). The spec is not in this repo.
 *
 *   tool    ocr         — images and PDFs (page-split), raw text + metadata
 *   command /ocr        — control panel, /ocr now <paths…>, /ocr status
 *   hook    input       — auto-OCR pasted image/pdf paths (OFF by default)
 *
 * Domain logic lives in pipeline.ts / engine.ts / pdftools.ts (pi-free,
 * unit-tested); this adapter only binds them to pi surfaces.
 *
 * Architecture: pi-extension-builder scaffold. SettingsPanel and JsonStore
 * come from @maheidem/pi-panel-kit. UX archetype: control panel.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { ACTION_INVENTORY, OcrController, ocrVersion, type SettingKey } from "./application.ts";
import { CONFIG_PATH, loadConfig, normalizeBaseUrl, type OcrConfig } from "./config.ts";
import { resolveEngine, type SessionModelInfo } from "./engine.ts";
import { COMMAND_NAME } from "./metadata.ts";
import { expandInputs, extractOcrPaths, expandPath, isOcrPath } from "./paths.ts";
import { formatFileResult, ocrFile, type FileResult, type PipelineHost } from "./pipeline.ts";
import { buildOcrPanelSnapshot } from "./ui/ocr-panel.ts";
import { SettingsPanel, type PanelResult } from "@maheidem/pi-panel-kit";

const TAG = "[ocr]";

/** ctx.ui.notify is a no-op in print mode (hasUI === false) — route to stdout. */
function say(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(message, level);
	else console.log(message);
}

/** Snapshot pi's current model for R3a resolution (never throws). */
function sessionModelInfo(ctx: ExtensionContext): SessionModelInfo | undefined {
	const model = ctx.model;
	if (!model) return undefined;
	let apiKey: string | undefined;
	let headers: Record<string, string> | undefined;
	try {
		// Synchronous facade does not expose auth; adapter reads the async
		// registry lazily via a side-channel set at session start (below).
		apiKey = (model as unknown as { __ocrApiKey?: string }).__ocrApiKey;
		headers = (model as unknown as { __ocrHeaders?: Record<string, string> }).__ocrHeaders;
	} catch {
		/* best-effort only */
	}
	return {
		id: model.id,
		provider: String(model.provider ?? ""),
		api: String(model.api ?? ""),
		baseUrl: String(model.baseUrl ?? ""),
		input: [...(model.input ?? [])],
		apiKey,
		headers,
	};
}

/** Async auth resolution for the session model through the registry. */
async function hydrateSessionAuth(
	info: SessionModelInfo | undefined,
	ctx: ExtensionContext,
): Promise<SessionModelInfo | undefined> {
	if (!info || !ctx.modelRegistry || info.apiKey) return info;
	try {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model!);
		if (auth.ok) {
			const headers = auth.headers
				? Object.fromEntries(Object.entries(auth.headers).filter(([, v]) => typeof v === "string") as [string, string][])
				: undefined;
			return {
				...info,
				apiKey: auth.apiKey,
				headers,
				baseUrl: auth.baseUrl || info.baseUrl,
			};
		}
	} catch {
		/* fall back without auth */
	}
	return info;
}

interface EffectiveOverrides {
	model?: string;
	force?: boolean;
	dpi?: number;
	prompt?: string;
	maxPages?: number;
	summaryOnly?: boolean;
	validators?: Record<string, { pattern: string; min: number }>;
}

function effectiveConfig(overrides: EffectiveOverrides): OcrConfig {
	const cfg = { ...loadConfig() };
	if (overrides.model !== undefined) cfg.model = overrides.model || null;
	if (overrides.force !== undefined) cfg.force = overrides.force;
	if (overrides.dpi !== undefined) cfg.dpi = overrides.dpi;
	if (overrides.prompt !== undefined && overrides.prompt.trim()) cfg.prompt = overrides.prompt.trim();
	if (overrides.maxPages !== undefined) cfg.maxPages = overrides.maxPages;
	if (overrides.validators !== undefined) cfg.validators = overrides.validators;
	if (cfg.baseUrl) cfg.baseUrl = normalizeBaseUrl(cfg.baseUrl);
	return cfg;
}

/** Format the tool/command output: metadata block first, then raw text. */
function formatOutput(results: FileResult[], cwd: string, engineSource: string): string {
	const summary = results
		.map((r) => `${r.verdict ?? "skipped"}\t${r.input.split("/").pop()}`)
		.join("\n");
	const blocks = results.map((result) => formatFileResult(result, cwd));
	return [
		`${TAG} ${ocrVersion()} · engine: ${engineSource}`,
		summary,
		"",
		...blocks,
	].join("\n");
}

export default function extension(pi: ExtensionAPI) {
	const controller = new OcrController();

	async function openPanel(ctx: ExtensionCommandContext, initialKey = "model"): Promise<void> {
		if (ctx.mode !== "tui") {
			say(ctx, controller.statusReport());
			return;
		}
		for (;;) {
			const result = await ctx.ui.custom<PanelResult>(
				(tui, theme, keybindings, done) =>
					new SettingsPanel({
						theme,
						keybindings,
						initialKey,
						snapshot: () => buildOcrPanelSnapshot(controller),
						apply: (key, rawValue) => controller.apply(key as SettingKey, rawValue),
						activate: (key) =>
							key === "reset" || key === "status" ? { kind: "close", action: key } : { kind: "none" },
						requestRender: () => tui.requestRender(),
						done,
					}),
				{
					onCancel: () => ({ /* esc closes */ }),
				} as unknown as Record<string, never>,
			);
			if (result?.action === "status") {
				say(ctx, controller.statusReport());
				initialKey = "model";
				continue;
			}
			if (result?.action === "reset") {
				const confirmed = await ctx.ui.confirm("Reset OCR settings?", "Restore every setting to its shipped default?");
				if (confirmed) {
					controller.reset();
					say(ctx, `${TAG} settings reset to defaults.`);
				}
				initialKey = "reset";
				continue;
			}
			return;
		}
	}

	pi.registerTool({
		name: "ocr",
		label: "OCR images and PDFs",
		description:
			"OCR PDFs (page-split via pdftoppm; a native text layer is extracted free with pdftotext) and images (PNG/JPG/WebP/BMP/TIFF) through a vision model. Returns the RAW extracted text plus a metadata block (verdict ok|review|failed, per-page status, illegible-marker count, validator results) and persists an auditable <name>.ocr.json sidecar beside each file. Skips files whose sidecar already exists unless force is true.",
		promptSnippet: "OCR images/PDFs via a vision model with JSON sidecars and verdicts",
		promptGuidelines: [
			"Use ocr whenever the user references a scanned document, image of text, or text-less PDF and wants its content — the read tool cannot open PDFs.",
			"ocr returns the raw transcription; treat verdict 'review' (illegible markers / validator mismatches) and 'failed' as signals to report rather than trusting the text blindly.",
			"ocr skips files whose sidecar exists; re-read <name>.ocr.json before assuming a file was OCRed fresh, or pass force: true.",
			"When a PDF has a native text layer, ocr extracts it directly (source: text-layer) — no model call, no cost.",
		],
		parameters: Type.Object({
			paths: Type.Array(Type.String(), { description: "Image or PDF file paths, or directories containing them" }),
			recursive: Type.Optional(Type.Boolean({ description: "Recurse into directories. Default false." })),
			model: Type.Optional(Type.String({ description: "Override the OCR model id (uses the configured base URL). Default: config > session vision model > defaultVisionModel." })),
			force: Type.Optional(Type.Boolean({ description: "Overwrite existing sidecars. Default false." })),
			dpi: Type.Optional(Type.Number({ description: "PDF render resolution. Default 200." })),
			prompt: Type.Optional(Type.String({ description: "Override the transcription prompt." })),
			maxPages: Type.Optional(Type.Number({ description: "Cap on PDF pages. Default 200." })),
			summaryOnly: Type.Optional(Type.Boolean({ description: "Return metadata + sidecar path only, no inline text." })),
			validators: Type.Optional(
				Type.Record(Type.String(), Type.Object({ pattern: Type.String(), min: Type.Optional(Type.Number()) }), {
					description: "Named regexes; a validator passes when absent or matching at least `min` times. Mismatch downgrades the verdict to review.",
				}),
			),
		}),

		async execute(_id, params, signal, onUpdate, ctx) {
			const overrides: EffectiveOverrides = {
				...(params.model !== undefined ? { model: params.model } : {}),
				...(params.force !== undefined ? { force: params.force } : {}),
				...(params.dpi !== undefined ? { dpi: params.dpi } : {}),
				...(params.prompt !== undefined ? { prompt: params.prompt } : {}),
				...(params.maxPages !== undefined ? { maxPages: params.maxPages } : {}),
				...(params.validators !== undefined ? { validators: params.validators as Record<string, { pattern: string; min: number }> } : {}),
			};
			const cfg = effectiveConfig(overrides);
			const resolution = resolveEngine(cfg, overrides.model, await hydrateSessionAuth(sessionModelInfo(ctx), ctx));
			if ("error" in resolution) throw new Error(`${TAG} ${resolution.error}`);
			const engine = resolution.engine;

			const files = await expandInputs(params.paths, ctx.cwd, params.recursive ?? false);
			if (!files.length) {
				throw new Error(`${TAG} no OCR-able files matched ${JSON.stringify(params.paths)}`);
			}

			const host: PipelineHost = {
				exec: (command, args, options) => pi.exec(command, args, options),
				signal,
				onProgress: (message) => onUpdate?.({ content: [{ type: "text", text: message }], details: {} }),
			};
			const results: FileResult[] = [];
			for (let i = 0; i < files.length; i++) {
				if (signal?.aborted) break;
				onUpdate?.({
					content: [{ type: "text", text: `${i + 1}/${files.length} ${files[i]!.split("/").pop()}` }],
					details: { index: i, total: files.length },
				});
				results.push(await ocrFile(files[i]!, cfg, engine, host));
			}

			const forcedSummary = params.summaryOnly === true;
			const rendered = forcedSummary
				? results.map((r) => formatFileResult({ ...r, summaryOnly: true }, ctx.cwd))
				: results.map((r) => formatFileResult(r, ctx.cwd));
			const body = [
				`${TAG} ${ocrVersion()} · engine: ${engine.model} (${engine.source}) @ ${engine.baseUrl}`,
				...rendered,
			].join("\n\n");
			return {
				content: [{ type: "text", text: body }],
				details: {
					model: engine.model,
					engineSource: engine.source,
					results: results.map(({ text, pages, ...rest }) => ({
						...rest,
						chars: text.length,
						pages: pages.map((p) => ({ n: p.n, status: p.status, dpi: p.dpi, illegibleCount: p.illegibleCount })),
					})),
				},
			};
		},
	});

	function argumentCompletions(prefix: string) {
		const roots = [
			"now ",
			"status",
			...ACTION_INVENTORY.map((item) => `${item.verb} `),
			"paths",
			"reset",
			"help",
		];
		const matches = roots.filter((value) => value.startsWith(prefix));
		return matches.length ? matches.map((value) => ({ value, label: value })) : null;
	}

	pi.registerCommand(COMMAND_NAME, {
		description: "Open the OCR control panel; /ocr now <paths…> runs OCR; /ocr status for config",
		getArgumentCompletions: argumentCompletions,
		handler: async (args, ctx) => {
			const raw = (args ?? "").trim();
			const [verb = "", ...rest] = raw.split(/\s+/);
			const value = rest.join(" ").trim();

			if (!raw) {
				await openPanel(ctx);
				return;
			}
			if (verb === "help") {
				say(ctx, controller.helpReport());
				return;
			}
			if (verb === "status") {
				const suggestions = await controller.visionSuggestions();
				say(
					ctx,
					suggestions.length
						? `${controller.statusReport()}\n  vision models:  ${suggestions.slice(0, 6).join(", ")}${suggestions.length > 6 ? ` (+${suggestions.length - 6})` : ""}`
						: controller.statusReport(),
				);
				return;
			}
			if (verb === "paths") {
				say(ctx, `Config: ${CONFIG_PATH}`);
				return;
			}
			if (verb === "reset") {
				controller.reset();
				say(ctx, `${TAG} settings reset to defaults.`);
				return;
			}
			if (verb === "now") {
				if (!value) {
					say(ctx, `${TAG} usage: /ocr now <paths…> [--force] [--dpi=N] [--model=M] [--recursive]`, "error");
					return;
				}
				const paths: string[] = [];
				const overrides: EffectiveOverrides = {};
				let recursive = false;
				for (const token of rest) {
					if (token === "--force") overrides.force = true;
					else if (token.startsWith("--dpi=")) overrides.dpi = Number(token.slice(6));
					else if (token.startsWith("--model=")) overrides.model = token.slice(8);
					else if (token === "--recursive") recursive = true;
					else paths.push(expandPath(token, ctx.cwd));
				}
				try {
					const cfg = effectiveConfig({ ...overrides, model: overrides.model });
					const resolution = resolveEngine(cfg, overrides.model, await hydrateSessionAuth(sessionModelInfo(ctx), ctx));
					if ("error" in resolution) {
						say(ctx, `${TAG} ${resolution.error}`, "error");
						return;
					}
					const files = await expandInputs(paths, ctx.cwd, recursive);
					if (!files.length) {
						say(ctx, `${TAG} no OCR-able files matched: ${value}`, "error");
						return;
					}
					say(ctx, `${TAG} OCR of ${files.length} file(s) via ${resolution.engine.model} (${resolution.engine.source})…`);
					const host: PipelineHost = {
						exec: (command, cmdArgs, options) => pi.exec(command, cmdArgs, options),
						signal: ctx.signal,
						onProgress: (message) => say(ctx, `${TAG} ${message}`),
					};
					const results: FileResult[] = [];
					for (const file of files) {
						if (ctx.signal?.aborted) break;
						results.push(await ocrFile(file, cfg, resolution.engine, host));
					}
					say(ctx, formatOutput(results, ctx.cwd, `${resolution.engine.model} (${resolution.engine.source})`));
				} catch (err) {
					say(ctx, `${TAG} ${err instanceof Error ? err.message : String(err)}`, "error");
				}
				return;
			}

			const inventoryItem = ACTION_INVENTORY.find((item) => item.verb === verb);
			if (inventoryItem) {
				const error = controller.apply(inventoryItem.panelKey, value);
				say(ctx, error ?? `${inventoryItem.panelKey}: ${controller.config()[inventoryItem.panelKey]}`, error ? "error" : "info");
				return;
			}

			say(ctx, `Unknown action: ${verb}\n\n${controller.helpReport()}`, "error");
		},
	});

	// Input hook (R11): OFF by default — explicit tool use is the design.
	pi.on("input", async (event, ctx) => {
		if (!loadConfig().autoDetect) return { action: "continue" as const };
		if (event.source === "extension") return { action: "continue" as const };
		const found = extractOcrPaths(event.text ?? "");
		if (!found.length) return { action: "continue" as const };

		// Session safety: this hook must NEVER break a prompt.
		try {
			const cfg = effectiveConfig({});
			const resolution = resolveEngine(cfg, undefined, await hydrateSessionAuth(sessionModelInfo(ctx), ctx));
			if ("error" in resolution) return { action: "continue" as const };
			const blocks: string[] = [];
			for (const candidate of found) {
				const abs = expandPath(candidate, ctx.cwd);
				if (!isOcrPath(abs)) continue;
				const stat = await (await import("node:fs/promises")).stat(abs).catch(() => null);
				if (!stat || stat.isDirectory()) continue;
				say(ctx, `${TAG} auto-OCR ${abs.split("/").pop()}`);
				const host: PipelineHost = { exec: (command, args, options) => pi.exec(command, args, options), signal: ctx.signal };
				const result = await ocrFile(abs, cfg, resolution.engine, host);
				if (result.error) blocks.push(`${TAG} ${abs}: FAILED — ${result.error}`);
				else if (result.skipped) blocks.push(`${TAG} ${abs}: skipped — ${result.skipReason}`);
				else blocks.push(formatFileResult(result, ctx.cwd));
			}
			if (!blocks.length) return { action: "continue" as const };
			return { action: "transform" as const, text: `${event.text}\n\n${blocks.join("\n\n")}` };
		} catch (err) {
			console.log(`${TAG} input hook failed (${err instanceof Error ? err.message : String(err)}); continuing`);
			return { action: "continue" as const };
		}
	});
}
