import "./isolate.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	DEFAULT_CONFIG,
	DEFAULT_PROMPT,
	normalizeBaseUrl,
	normalizeConfig,
	CONFIG_PATH,
	loadConfig,
} from "../extensions/config.ts";
import { sidecarPathFor, writeJsonAtomic, SIDECAR_SCHEMA } from "../extensions/sidecar.ts";
import { countIllegible, evaluateVerdict, runValidators } from "../extensions/validate.ts";
import type { PageEntry } from "../extensions/sidecar.ts";
import { parsePageNumber } from "../extensions/pdftools.ts";
import { resolveEngine, ocrImage, type SessionModelInfo } from "../extensions/engine.ts";
import { expandInputs, extractOcrPaths, isOcrPath, mimeForPath } from "../extensions/paths.ts";

test("config: defaults written on boot, discoverable (R4)", () => {
	const cfg = loadConfig();
	assert.equal(cfg.schema, "ocr/v1");
	assert.equal(cfg.autoDetect, false); // R11: off by default (user decision)
	assert.equal(cfg.dpi, 200);
	assert.equal(cfg.dpiRetry, 300);
	assert.equal(cfg.prompt, DEFAULT_PROMPT);
	assert.ok(CONFIG_PATH.startsWith(process.env.HOME!)); // isolated agent dir
});

test("config: normalization coerces and clamps", () => {
	const cfg = normalizeConfig({
		baseUrl: "192.168.31.152:8123",
		model: "  ",
		autoDetect: "yes",
		dpi: 9999,
		maxPages: "abc",
		validators: { cpf: "\\d{3}\\.\\d{3}\\.\\d{3}-\\d{2}", cnj: { pattern: "\\d{7}-\\d{2}", min: 2 } },
	});
	assert.equal(cfg.baseUrl, "http://192.168.31.152:8123/v1");
	assert.equal(cfg.model, null);
	assert.equal(cfg.autoDetect, true);
	assert.equal(cfg.dpi, DEFAULT_CONFIG.dpi); // clamped back to default
	assert.equal(cfg.maxPages, DEFAULT_CONFIG.maxPages);
	assert.deepEqual(cfg.validators, {
		cpf: { pattern: "\\d{3}\\.\\d{3}\\.\\d{3}-\\d{2}", min: 1 },
		cnj: { pattern: "\\d{7}-\\d{2}", min: 2 },
	});
});

test("normalizeBaseUrl appends /v1 exactly once", () => {
	assert.equal(normalizeBaseUrl("http://x:8123"), "http://x:8123/v1");
	assert.equal(normalizeBaseUrl("http://x:8123/v1/"), "http://x:8123/v1");
	assert.equal(normalizeBaseUrl("x:1"), "http://x:1/v1");
});

test("sidecar paths replace the source extension (R5)", () => {
	assert.equal(sidecarPathFor("docs/1 GRAU TJRJ.pdf"), "docs/1 GRAU TJRJ.ocr.json"); // spaces safe
	assert.equal(sidecarPathFor("img.png"), "img.ocr.json");
	assert.equal(sidecarPathFor("/a/.hidden"), "/a/.hidden.ocr.json");
});

test("atomic sidecar write survives concurrent-looking runs and reads back", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-ocr-sidecar-"));
	try {
		const path = join(dir, "doc.ocr.json");
		await writeJsonAtomic(path, { schema: SIDECAR_SCHEMA, verdict: "ok" });
		assert.equal(JSON.parse(readFileSync(path, "utf8")).schema, "pi-ocr/v1");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("illegible markers are counted in both languages (R6)", () => {
	assert.equal(countIllegible("linha ok\n[ILEGÍVEL]\nfim"), 1);
	assert.equal(countIllegible("[ILLEGIBLE] and [ILEGIVEL]"), 2);
	assert.equal(countIllegible("no markers"), 0);
});

test("verdict: failed beats review beats ok (R6)", () => {
	const ok: PageEntry[] = [{ n: 1, status: "ok", bytes: 1, latencyMs: 1, dpi: 200, chars: 10, illegibleCount: 0 }];
	const review = [{ ...ok[0]!, illegibleCount: 1 }];
	const failed: PageEntry[] = [{ n: 1, status: "failed", bytes: 0, latencyMs: 0, dpi: null, chars: 0, illegibleCount: 0 }];
	assert.equal(evaluateVerdict(ok, []), "ok");
	assert.equal(evaluateVerdict(review, []), "review");
	assert.equal(evaluateVerdict(failed, []), "failed");
	assert.equal(evaluateVerdict(ok, [{ name: "cpf", present: true, matches: 0, pass: false }]), "review");
});

test("validators pass when absent, or present and >= min (R7)", () => {
	const text = "CPF 463.923.197-00 e processo 0293427-93";
	const results = runValidators(text, {
		cpf: { pattern: "\\d{3}\\.\\d{3}\\.\\d{3}-\\d{2}", min: 1 },
		cnpj: { pattern: "\\d{2}\\.\\d{3}\\.\\d{3}/\\d{4}", min: 1 },
		pair: { pattern: "0293427-93", min: 2 },
	});
	const byName = Object.fromEntries(results.map((r) => [r.name, r]));
	assert.equal(byName.cpf!.pass, true); // present and matches
	assert.equal(byName.cnpj!.pass, true); // absent => pass
	assert.equal(byName.pair!.pass, false); // present but fewer than min
});

test("pdftoppm naming: page numbers parsed from ACTUAL filenames, padded and not (R9)", () => {
	assert.equal(parsePageNumber("p1-1.png", "p1-"), 1);
	assert.equal(parsePageNumber("p10-10.png", "p10-"), 10);
	assert.equal(parsePageNumber("p2-02.png", "p2-"), 2);
	assert.equal(parsePageNumber("p2-unrelated.png", "p2-"), null); // non-numeric junk
	assert.equal(parsePageNumber("other-1.png", "p1-"), null); // wrong prefix
});

const SESSION: SessionModelInfo = {
	id: "gpt-x",
	provider: "p",
	api: "openai-completions",
	baseUrl: "https://api.example/v1",
	input: ["text", "image"],
	apiKey: "sk-test",
};

test("engine resolution order: tool arg > config > session vision model > fallback (R3a)", () => {
	const cfg = { baseUrl: "http://local:8123/v1", model: null as string | null, apiKey: null, defaultVisionModel: "qwen3.8-flash" };

	const toolArg = resolveEngine(cfg, "override");
	assert.ok("engine" in toolArg);
	assert.equal(toolArg.engine.source, "tool-arg");
	assert.equal(toolArg.engine.model, "override");
	const configPinned = resolveEngine({ ...cfg, model: "pinned" });
	if (!("engine" in configPinned)) assert.fail("expected an engine");
	assert.equal(configPinned.engine.source, "config");

	const session = resolveEngine(cfg, undefined, SESSION);
	assert.ok("engine" in session);
	assert.equal(session.engine.source, "session-model");
	assert.equal(session.engine.model, "gpt-x");
	assert.equal(session.engine.apiKey, "sk-test");

	const noVision = resolveEngine(cfg, undefined, { ...SESSION, input: ["text"] });
	assert.ok("engine" in noVision);
	assert.equal(noVision.engine.source, "default-vision-model");

	const nothing = resolveEngine({ ...cfg, defaultVisionModel: null }, undefined, { ...SESSION, input: ["text"] });
	if (!("error" in nothing)) assert.fail("expected an error");
	assert.match(nothing.error, /does not declare image input/);
});

test("engine resolution: vision session model on a non-openai API falls back with a reason (R3a)", () => {
	const cfg = { baseUrl: "http://local:8123/v1", model: null, apiKey: null, defaultVisionModel: null };
	const res = resolveEngine(cfg, undefined, { ...SESSION, api: "anthropic-messages" });
	if (!("error" in res)) assert.fail("expected an error");
	assert.match(res.error, /not OpenAI-compatible/);
});

function fakeFetch(status: number, body: unknown) {
	return (async () =>
		new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
}

test("engine call: happy path returns text + latency", async () => {
	const engine = { baseUrl: "http://x/v1", model: "m", source: "config" as const };
	const res = await ocrImage(
		engine,
		{ mime: "image/png", bytes: new Uint8Array([1, 2, 3]) },
		"prompt",
		1000,
		5000,
		undefined,
		fakeFetch(200, { choices: [{ message: { content: "texto transcrito" } }] }),
	);
	assert.ok(res.ok);
	assert.equal(res.result.text, "texto transcrito");
	assert.ok(res.result.latencyMs >= 0);
});

test("engine call: HTTP 500 surfaces the prose body (oMLX quirk)", async () => {
	const engine = { baseUrl: "http://x/v1", model: "m", source: "config" as const };
	const res = await ocrImage(
		engine,
		{ mime: "image/png", bytes: new Uint8Array([1]) },
		"p",
		10,
		5000,
		undefined,
		fakeFetch(500, { error: "boom" }),
	);
	assert.ok(!res.ok);
	assert.match(res.error!, /HTTP 500/);
});

test("engine call: empty completion is an error, not silent success", async () => {
	const engine = { baseUrl: "http://x/v1", model: "m", source: "config" as const };
	const res = await ocrImage(
		engine,
		{ mime: "image/png", bytes: new Uint8Array([1]) },
		"p",
		10,
		5000,
		undefined,
		fakeFetch(200, { choices: [{ message: { content: "" } }] }),
	);
	assert.ok(!res.ok);
	assert.equal(res.error, "empty completion");
});

test("path helpers: extension detection, mime map, pasted-path extraction (R1/R11)", () => {
	assert.ok(isOcrPath("/a/b/Scan 001.PDF")); // case-insensitive extension match
	assert.ok(isOcrPath("x.png") && isOcrPath("x.TIFF"));
	assert.ok(!isOcrPath("x.docx"));
	assert.equal(mimeForPath("a.jpg"), "image/jpeg");
	assert.equal(mimeForPath("a.bin"), null);

	const text = 'look at ~/Documents/certidao 1 grau.pdf and ./scan.tif plus /etc/hosts';
	const found = extractOcrPaths(text);
	// space-containing paths split at the space; conservative matcher still yields the extension-bearing tail token
	assert.deepEqual(found, ["./scan.tif"]);
});

test("expandInputs: directories expand (non-recursive by default), skips dot-work dirs", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-ocr-expand-"));
	try {
		writeFileSync(join(dir, "a.png"), "x");
		writeFileSync(join(dir, "b.pdf"), "x");
		writeFileSync(join(dir, "c.txt"), "x");
		writeFileSync(join(dir, "d.tiff"), "x");
		const sub = join(dir, "sub");
		mkdirSync(sub);
		writeFileSync(join(sub, "e.png"), "x");
		const top = await expandInputs([dir], dir, false);
		assert.deepEqual(top.map((p) => p.split("/").pop()).sort(), ["a.png", "b.pdf", "d.tiff"]);
		const rec = await expandInputs([dir], dir, true);
		assert.equal(rec.length, 4);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
