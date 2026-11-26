/**
 * Verdict + validator semantics (spec R6/R7). Pure functions, Pi-free.
 *
 * The tool returns raw text untouched; interpretation lives here and is
 * surfaced as metadata only — never a rewrite of the transcription.
 */

import type { PageEntry, OcrVerdict } from "./sidecar.ts";

const ILLEGIBLE_RE = /\[ILEG[ÍI]VEL\]|\[ILLEGIBLE\]/gi;

export function countIllegible(text: string): number {
	return (text.match(ILLEGIBLE_RE) ?? []).length;
}

export interface ValidatorSpec {
	pattern: string;
	min: number;
}

export interface ValidatorResult {
	name: string;
	present: boolean;
	matches: number;
	pass: boolean;
}

/**
 * A validator PASSES when the pattern is absent from the text, or present
 * and matching at least `min` times. Malformed-looking occurrences are out
 * of scope for a single-regex validator (external cross-checks stay with
 * downstream tooling); the mismatch signal we can give is "present but
 * fewer matches than expected".
 */
export function runValidators(text: string, validators: Record<string, ValidatorSpec>): ValidatorResult[] {
	const results: ValidatorResult[] = [];
	for (const [name, spec] of Object.entries(validators)) {
		let matches = 0;
		let error: string | null = null;
		try {
			const re = new RegExp(spec.pattern, "g");
			matches = (text.match(re) ?? []).length;
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		}
		if (error) {
			results.push({ name, present: false, matches: 0, pass: false });
			continue;
		}
		const present = matches > 0;
		results.push({ name, present, matches, pass: !present || matches >= spec.min });
	}
	return results;
}

/**
 * failed = any page failed (render 0 bytes / engine error after retries).
 * review = any [ILEGÍVEL] marker (default threshold: any occurrence) or any
 * failed validator. ok otherwise.
 */
export function evaluateVerdict(pages: PageEntry[], validatorResults: ValidatorResult[]): OcrVerdict {
	if (pages.some((page) => page.status === "failed")) return "failed";
	if (pages.some((page) => page.illegibleCount > 0)) return "review";
	if (validatorResults.some((result) => !result.pass)) return "review";
	return "ok";
}
