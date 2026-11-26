/**
 * Per-file OCR orchestration (spec R1/R2/R5/R6/R10). Pi-free: exec, engine
 * calls, and progress reporting are injected. Raw text is returned
 * untouched; interpretation is metadata only (R6, user decision).
 */

import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { OcrConfig } from "./config.ts";
import { ocrImage, type Engine } from "./engine.ts";
import { cleanupWorkDir, extractTextLayer, pageCount, probeTextLayer, renderPage, type Exec } from "./pdftools.ts";
import { isImagePath, isPdfPath, mimeForPath } from "./paths.ts";
import { exists, sidecarPathFor, writeJsonAtomic, type PageEntry, type SidecarDocument, type OcrVerdict } from "./sidecar.ts";
import { countIllegible, evaluateVerdict, runValidators, type ValidatorResult } from "./validate.ts";

export interface PipelineHost {
	exec: Exec;
	signal?: AbortSignal;
	onProgress?: (message: string) => void;
}

export interface FileResult {
	input: string;
	sidecarPath: string | null;
	skipped: boolean;
	skipReason?: string;
	error?: string;
	source: "text-layer" | "vision" | null;
	verdict: OcrVerdict | null;
	text: string;
	truncated: boolean;
	summaryOnly: boolean;
	model: string | null;
	baseUrl: string | null;
	pages: PageEntry[];
	validators: ValidatorResult[];
}

function skippedResult(input: string, reason: string): FileResult {
	return {
		input,
		sidecarPath: sidecarPathFor(input),
		skipped: true,
		skipReason: reason,
		source: null,
		verdict: null,
		text: "",
		truncated: false,
		summaryOnly: false,
		model: null,
		baseUrl: null,
		pages: [],
		validators: [],
	};
}

/** OCR a single image file (one page, no dpi ladder — nothing to re-render). */
async function ocrImageFile(
	path: string,
	cfg: OcrConfig,
	engine: Engine,
	host: PipelineHost,
): Promise<FileResult> {
	const mime = mimeForPath(path);
	const bytes = await readFile(path).catch(() => null);
	if (!mime || !bytes) return { ...skippedResult(path, "unreadable"), error: "file could not be read" };
	if (cfg.maxBytes > 0 && bytes.length > cfg.maxBytes) {
		return { ...skippedResult(path, `exceeds maxBytes (${bytes.length} > ${cfg.maxBytes})`) };
	}
	const started = Date.now();
	const call = await ocrImage(engine, { mime, bytes }, cfg.prompt, cfg.maxTokens, cfg.timeoutMs, host.signal);
	const latencyMs = Date.now() - started;
	if (!call.ok) {
		return {
			...skippedResult(path, "engine error"),
			error: call.error,
			source: "vision",
			model: engine.model,
			baseUrl: engine.baseUrl,
			pages: [{ n: 1, status: "failed", bytes: bytes.length, latencyMs, dpi: null, chars: 0, illegibleCount: 0, attempts: [{ dpi: null, error: call.error }] }],
		};
	}
	const text = call.result.text;
	const illegibleCount = countIllegible(text);
	const pages: PageEntry[] = [
		{ n: 1, status: "ok", bytes: bytes.length, latencyMs: call.result.latencyMs, dpi: null, chars: text.length, illegibleCount },
	];
	return finalizeResult(path, cfg, engine, "vision", text, pages, false, [illegibleCount]);
}

async function ocrPdf(
	path: string,
	cfg: OcrConfig,
	engine: Engine,
	host: PipelineHost,
): Promise<FileResult> {
	// R2: text layer first — free extraction, no model call.
	const probe = await probeTextLayer(path, host.exec, host.signal);
	if (probe.available && probe.chars >= cfg.textLayerMinChars) {
		const text = await extractTextLayer(path, host.exec, host.signal);
		const illegible = countIllegible(text);
		return finalizeResult(path, cfg, engine, "text-layer", text, [], false, [illegible]);
	}
	if (!probe.available) {
		host.onProgress?.(`${basename(path)}: pdftotext unavailable (${probe.error ?? "?"}); continuing with vision OCR`);
	}

	const count = await pageCount(path, host.exec, host.signal);
	if (count === null) {
		return { ...skippedResult(path, "pdfinfo unavailable"), error: "pdfinfo could not report a page count" };
	}
	const truncated = count > cfg.maxPages;
	const limit = truncated ? cfg.maxPages : count;

	const workDir = join(dirname(path), ".ocrwork");
	const pages: PageEntry[] = [];
	const pageTexts: string[] = [];
	try {
		for (let n = 1; n <= limit; n++) {
			if (host.signal?.aborted) break;
			host.onProgress?.(`${basename(path)}: page ${n}/${limit}`);
			const entry = await ocrOnePdfPage(path, n, cfg, engine, workDir, host);
			pages.push(entry.page);
			pageTexts.push(entry.text);
		}
	} finally {
		await cleanupWorkDir(workDir, cfg.keepRenders);
	}

	const text = pageTexts
		.map((t, i) => (pages.length > 1 ? `--- page ${i + 1} ---\n${t}` : t))
		.join("\n\n");
	return finalizeResult(path, cfg, engine, "vision", text, pages, truncated, pages.map((p) => p.illegibleCount));
}

/** Render + OCR one PDF page with the dpi retry ladder (R10). */
async function ocrOnePdfPage(
	path: string,
	n: number,
	cfg: OcrConfig,
	engine: Engine,
	workDir: string,
	host: PipelineHost,
): Promise<{ page: PageEntry; text: string }> {
	const attempts: Array<{ dpi: number | null; error: string }> = [];

	for (const dpi of [cfg.dpi, cfg.dpiRetry]) {
		const png = await renderPage(path, n, dpi, workDir, host.exec, host.signal);
		if (!png) {
			attempts.push({ dpi, error: "render produced no file" });
			continue;
		}
		const bytes = await readFile(png).catch(() => null);
		if (!bytes || bytes.length === 0) {
			attempts.push({ dpi, error: "render produced 0 bytes" });
			continue;
		}
		if (cfg.maxBytes > 0 && bytes.length > cfg.maxBytes) {
			attempts.push({ dpi, error: `render exceeds maxBytes (${bytes.length})` });
			continue;
		}
		const call = await ocrImage(engine, { mime: "image/png", bytes }, cfg.prompt, cfg.maxTokens, cfg.timeoutMs, host.signal);
		if (!call.ok) {
			attempts.push({ dpi, error: call.error });
			continue;
		}
		const text = call.result.text;
		return {
			page: {
				n,
				status: "ok",
				bytes: bytes.length,
				latencyMs: call.result.latencyMs,
				dpi,
				chars: text.length,
				illegibleCount: countIllegible(text),
			},
			text,
		};
	}

	return {
		page: { n, status: "failed", bytes: 0, latencyMs: 0, dpi: null, chars: 0, illegibleCount: 0, attempts },
		text: "",
	};
}

/** Shared tail: validators, verdict, context guard, sidecar write. */
async function finalizeResult(
	path: string,
	cfg: OcrConfig,
	engine: Engine,
	source: "text-layer" | "vision",
	text: string,
	pages: PageEntry[],
	truncated: boolean,
	illegibleByPage: number[],
): Promise<FileResult> {
	const validators = runValidators(text, cfg.validators);
	const verdict = evaluateVerdict(pages, validators);
	const summaryOnly = text.length > cfg.contextGuardChars || truncated;

	const doc: SidecarDocument = {
		schema: "pi-ocr/v1" as const,
		generatedAt: new Date().toISOString(),
		source,
		model: engine.model,
		baseUrl: engine.baseUrl,
		dpi: source === "vision" ? cfg.dpi : null,
		truncated,
		verdict,
		text,
		pages,
		...(validators.length ? { validators } : {}),
	};
	const sidecarPath = sidecarPathFor(path);
	await writeJsonAtomic(sidecarPath, doc).catch(() => {});

	return {
		input: path,
		sidecarPath,
		skipped: false,
		source,
		verdict,
		text,
		truncated,
		summaryOnly,
		model: engine.model,
		baseUrl: engine.baseUrl,
		pages,
		validators,
	};
}

/** Entry point: OCR one file (image or PDF) under the effective config. */
export async function ocrFile(
	path: string,
	cfg: OcrConfig,
	engine: Engine,
	host: PipelineHost,
): Promise<FileResult> {
	if (!cfg.force) {
		const sidecar = sidecarPathFor(path);
		if (await exists(sidecar)) return skippedResult(path, "sidecar exists");
	}
	if (isPdfPath(path)) return ocrPdf(path, cfg, engine, host);
	if (isImagePath(path)) return ocrImageFile(path, cfg, engine, host);
	return skippedResult(path, "unsupported extension");
}

/** Human/model-readable per-file block: metadata first, raw text after. */
export function formatFileResult(result: FileResult, cwd: string): string {
	const rel = result.input.startsWith(cwd) ? result.input.slice(cwd.length + 1) || result.input : result.input;
	const lines: string[] = [];
	const flags: string[] = [];
	if (result.truncated) flags.push("truncated");
	if (result.summaryOnly) flags.push("summary-only");
	const head = [
		`## ${rel}`,
		`verdict: ${result.verdict ?? "skipped"}${flags.length ? ` (${flags.join(", ")})` : ""}`,
		result.skipped ? `skipped: ${result.skipReason}` : null,
		result.error ? `error: ${result.error}` : null,
		result.source ? `source: ${result.source}` : null,
		result.model ? `model: ${result.model} (${result.baseUrl})` : null,
		result.pages.length ? `pages: ${result.pages.length} (${result.pages.filter((p) => p.status === "ok").length} ok, ${result.pages.filter((p) => p.status === "failed").length} failed)` : null,
		result.pages.some((p) => p.illegibleCount > 0) ? `illegible markers: ${result.pages.reduce((sum, p) => sum + p.illegibleCount, 0)}` : null,
		result.validators.length ? `validators: ${result.validators.map((v) => `${v.name}=${v.pass ? "pass" : `FAIL(${v.matches})`}`).join(" ")}` : null,
		result.sidecarPath ? `sidecar: ${result.sidecarPath}` : null,
	].filter(Boolean);
	lines.push(head.join("\n"));
	if (result.summaryOnly) {
		lines.push(`text omitted (>context guard) — read the sidecar for the full transcription`);
	} else if (result.text) {
		lines.push(`--- OCR text ---\n${result.text}`);
	}
	return lines.join("\n");
}
