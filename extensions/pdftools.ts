/**
 * PDF tooling (spec R2/R8/R9): text-layer probe, page count, page rendering.
 *
 * All shell-outs use injected exec with ARG ARRAYS — never string
 * interpolation — so filenames with spaces are safe (R8, the certidões
 * regression). Rendered filenames are DISCOVERED by globbing the work
 * directory, never constructed from an expected naming scheme (R9 —
 * pdftoppm emits `<prefix>-<page>.png` with zero-padded page numbers that
 * surprised the original pipeline).
 *
 * Pi-free: dependencies are injected for testability.
 */

import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

export type Exec = (
	command: string,
	args: string[],
	options?: { signal?: AbortSignal },
) => Promise<{ stdout: string; stderr?: string; code: number }>;

export interface ProbeResult {
	available: boolean;
	chars: number;
	error?: string;
}

/** Full-document text-layer probe: `pdftotext -layout <pdf> -` (R2). */
export async function probeTextLayer(pdfPath: string, exec: Exec, signal?: AbortSignal): Promise<ProbeResult> {
	let res: { stdout: string; stderr?: string; code: number };
	try {
		res = await exec("pdftotext", ["-layout", pdfPath, "-"], { signal });
	} catch (err) {
		return { available: false, chars: 0, error: `pdftotext could not run: ${err instanceof Error ? err.message : String(err)}` };
	}
	if (res.code !== 0) {
		return { available: false, chars: 0, error: `pdftotext exit ${res.code}${res.stderr?.trim() ? `: ${res.stderr.trim().slice(0, 160)}` : ""}` };
	}
	const chars = res.stdout.replace(/\s/g, "").length;
	return { available: true, chars };
}

/** Extract the full text layer (only called when the probe says it exists). */
export async function extractTextLayer(pdfPath: string, exec: Exec, signal?: AbortSignal): Promise<string> {
	const res = await exec("pdftotext", ["-layout", pdfPath, "-"], { signal });
	return res.code === 0 ? res.stdout : "";
}

/** Page count via `pdfinfo`; null when pdfinfo is unavailable. */
export async function pageCount(pdfPath: string, exec: Exec, signal?: AbortSignal): Promise<number | null> {
	try {
		const res = await exec("pdfinfo", [pdfPath], { signal });
		if (res.code !== 0) return null;
		const match = /^Pages:\s+(\d+)/m.exec(res.stdout);
		return match ? Number(match[1]) : null;
	} catch {
		return null;
	}
}

/** Parse pdftoppm's actual emitted page numbers from filenames (R9). */
export function parsePageNumber(filename: string, prefix: string): number | null {
	if (!filename.startsWith(prefix)) return null;
	const tail = filename.slice(prefix.length).replace(/\.png$/i, "");
	const page = Number(tail.replace(/[^0-9]/g, ""));
	return Number.isInteger(page) && page > 0 ? page : null;
}

/**
 * Render ONE page at `dpi` into `workDir` and return the actual emitted
 * file path (discovered, not constructed). Returns null when the render
 * fails or produces nothing (0-byte files are surfaced by the caller).
 */
export async function renderPage(
	pdfPath: string,
	page: number,
	dpi: number,
	workDir: string,
	exec: Exec,
	signal?: AbortSignal,
): Promise<string | null> {
	await mkdir(workDir, { recursive: true });
	const prefix = join(workDir, `p${page}-`);
	try {
		const res = await exec("pdftoppm", ["-f", String(page), "-l", String(page), "-r", String(dpi), "-png", pdfPath, prefix], {
			signal,
		});
		if (res.code !== 0) return null;
	} catch {
		return null;
	}
	// R9: glob what pdftoppm actually emitted — never guess the name.
	const entries = await readdir(workDir).catch(() => [] as string[]);
	const candidates = entries
		.map((name) => ({ name, page: parsePageNumber(name, `p${page}-`) }))
		.filter((item): item is { name: string; page: number } => item.page === page)
		.sort((a, b) => a.name.localeCompare(b.name));
	if (!candidates.length) return null;
	return join(workDir, candidates[0]!.name);
}

export async function cleanupWorkDir(workDir: string, keep: boolean): Promise<void> {
	if (keep) return;
	await rm(workDir, { recursive: true, force: true }).catch(() => {});
}
