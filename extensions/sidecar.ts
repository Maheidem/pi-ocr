/**
 * Sidecar persistence (spec R5). `<name>.<ext>` -> `<name>.ocr.json`
 * (schema `pi-ocr/v1`), written atomically beside the source file.
 */

import { open, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";

export const SIDECAR_SCHEMA = "pi-ocr/v1";

export type PageStatus = "ok" | "failed";

export interface PageEntry {
	n: number;
	status: PageStatus;
	bytes: number;
	latencyMs: number;
	dpi: number | null;
	chars: number;
	illegibleCount: number;
	attempts?: Array<{ dpi: number | null; error: string }>;
}

export type OcrVerdict = "ok" | "review" | "failed";
export type OcrSource = "text-layer" | "vision";

export interface SidecarDocument {
	schema: typeof SIDECAR_SCHEMA;
	generatedAt: string;
	source: OcrSource;
	model: string;
	baseUrl: string;
	dpi: number | null;
	truncated: boolean;
	verdict: OcrVerdict;
	text: string;
	pages: PageEntry[];
	validators?: Array<{ name: string; present: boolean; matches: number; pass: boolean }>;
	[key: string]: unknown;
}

/** `certidao 1 grau.pdf` -> `certidao 1 grau.ocr.json` (extension replaced). */
export function sidecarPathFor(sourcePath: string): string {
	const ext = extname(sourcePath);
	if (!ext || sourcePath.startsWith(".") || ext.length > 6) return `${sourcePath}.ocr.json`;
	return `${sourcePath.slice(0, sourcePath.length - ext.length)}.ocr.json`;
}

/** Atomic write: same-directory temp file, then rename over the target. */
export async function writeJsonAtomic(path: string, doc: unknown): Promise<void> {
	const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
	const fh = await open(tmp, "w");
	try {
		await fh.writeFile(`${JSON.stringify(doc, null, 2)}\n`, "utf8");
		await fh.sync?.();
	} catch (err) {
		await fh.close().catch(() => {});
		await unlink(tmp).catch(() => {});
		throw err;
	}
	await fh.close();
	await rename(tmp, path);
}

export async function readSidecar(path: string): Promise<SidecarDocument | null> {
	try {
		const raw = await (await import("node:fs/promises")).readFile(path, "utf8");
		const doc = JSON.parse(raw) as SidecarDocument;
		return doc?.schema === SIDECAR_SCHEMA ? doc : null;
	} catch {
		return null;
	}
}

export function exists(path: string): Promise<boolean> {
	return stat(path).then(
		() => true,
		() => false,
	);
}
