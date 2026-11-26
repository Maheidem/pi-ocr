/**
 * Test-runner hygiene (QUALITY-GATES §13): strip harness-injected env vars
 * that leak child semantics, and pin an isolated HOME so no test can touch
 * the live agent dir. Import FIRST in every test file.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const key of Object.keys(process.env)) {
	if (key.startsWith("PI_OCR_")) delete process.env[key];
}

export const ISOLATED_HOME = mkdtempSync(join(tmpdir(), "pi-ocr-test-"));
process.env.HOME = ISOLATED_HOME;

process.once("exit", () => rmSync(ISOLATED_HOME, { recursive: true, force: true }));
