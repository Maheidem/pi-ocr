/**
 * Input discovery: extension detection, directory expansion, and pasted-path
 * extraction for the input hook (R11). Pi-free.
 */

import { readdir, stat } from "node:fs/promises";
import { extname, isAbsolute, join, resolve } from "node:path";

export const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"]);
export const OCR_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, ".pdf"]);

export function isPdfPath(path: string): boolean {
	return extname(path).toLowerCase() === ".pdf";
}

export function isImagePath(path: string): boolean {
	return IMAGE_EXTENSIONS.has(extname(path).toLowerCase());
}

export function isOcrPath(path: string): boolean {
	return OCR_EXTENSIONS.has(extname(path).toLowerCase());
}

/** Resolve a user-supplied path against cwd; ~ expansion supported. */
export function expandPath(input: string, cwd: string): string {
	let p = input.trim();
	if (p.startsWith("~")) p = join(process.env.HOME ?? process.cwd(), p.slice(1));
	return isAbsolute(p) ? p : resolve(cwd, p);
}

/**
 * Expand a list of paths into OCR-able files. Directories are scanned
 * (optionally recursively); non-OCR extensions are ignored; missing paths
 * are ignored (the caller reports an empty match).
 */
export async function expandInputs(paths: string[], cwd: string, recursive: boolean): Promise<string[]> {
	const found: string[] = [];

	async function walk(dir: string, depth: number): Promise<void> {
		const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
		if (!entries) return;
		for (const entry of entries) {
			if (entry.name.startsWith(".ocrwork")) continue;
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (recursive && depth > 0) await walk(full, depth - 1);
			} else if (isOcrPath(entry.name)) {
				found.push(full);
			}
		}
	}

	for (const input of paths) {
		const abs = expandPath(input, cwd);
		const info = await stat(abs).catch(() => null);
		if (!info) continue;
		if (info.isDirectory()) await walk(abs, recursive ? 8 : 1);
		else if (isOcrPath(abs)) found.push(abs);
	}

	// Dedupe, stable order.
	return [...new Set(found)].sort();
}

const MIME_BY_EXT: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".bmp": "image/bmp",
	".tif": "image/tiff",
	".tiff": "image/tiff",
};

export function mimeForPath(path: string): string | null {
	return MIME_BY_EXT[extname(path).toLowerCase()] ?? null;
}

const PATH_TOKEN = /(?:^|[\s'"(\[]|:=?)(~?\/[^\s'"()\[\]{}|<>,*?`\\]+|\.{1,2}\/[^\s'"()\[\]{}|<>,*?`\\]+)/g;

/**
 * Extract filesystem paths that look OCR-able from pasted text (input hook).
 * Conservative: only absolute / ~ / ./ ../ tokens with a known extension.
 */
export function extractOcrPaths(text: string): string[] {
	const matches = text.matchAll(PATH_TOKEN);
	const out: string[] = [];
	for (const match of matches) {
		const candidate = match[1] ?? "";
		if (isOcrPath(candidate)) out.push(candidate);
	}
	return [...new Set(out)];
}
