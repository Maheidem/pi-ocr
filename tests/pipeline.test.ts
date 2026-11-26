import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach } from "node:test";

import { DEFAULT_CONFIG } from "../extensions/config.ts";
import { ocrFile, formatFileResult } from "../extensions/pipeline.ts";
import type { Engine } from "../extensions/engine.ts";
import type { Exec } from "../extensions/pdftools.ts";

const ENGINE: Engine = { baseUrl: "http://fake/v1", model: "fake-vision", source: "config" };

interface ExecCall {
	command: string;
	args: string[];
}

function makeExec(options: {
	pages?: number;
	textLayer?: string | null; // null = pdftotext fails/empty
	renderFailAt?: Set<number>; // page numbers whose first render fails
	renderAlwaysFails?: boolean;
}): { exec: Exec; calls: ExecCall[] } {
	const calls: ExecCall[] = [];
	const exec: Exec = async (command, args) => {
		calls.push({ command, args });
		if (command === "pdfinfo") return { stdout: `Pages: ${options.pages ?? 1}\n`, code: 0 };
		if (command === "pdftotext") {
			if (options.textLayer === null) return { stdout: "", stderr: "no text", code: 99 };
			return { stdout: options.textLayer ?? "", code: 0 };
		}
		if (command === "pdftoppm") {
			const page = Number(args[args.indexOf("-f") + 1]);
			const dpi = Number(args[args.indexOf("-r") + 1]);
			const prefix = args[args.length - 1]!;
			const shouldFail =
				options.renderAlwaysFails ||
				(options.renderFailAt?.has(page) && dpi < 300);
			if (shouldFail) return { stdout: "", stderr: "I/O Error", code: 1 };
			const file = `${prefix}${page < 10 ? `0${page}` : page}.png`; // pdftoppm pads names
			mkdirSync(join(prefix, ".."), { recursive: true });
			writeFileSync(file, "fakepng");
			return { stdout: "", code: 0 };
		}
		return { stdout: "", code: 1 };
	};
	return { exec, calls };
}

function fakeFetch(status: number, text: string) {
	return (async (_url: unknown, init?: { body?: string }) => {
		// Record that the request body contains a base64 data URL + prompt.
		if (init?.body) {
			const body = JSON.parse(init.body as string) as { messages: Array<{ content: Array<{ type: string }> }> };
			if (!body.messages?.[0]?.content?.some((part) => part.type === "image_url")) {
				return new Response("missing image part", { status: 400 });
			}
		}
		return new Response(
			JSON.stringify({ choices: [{ message: { content: text } }] }),
			{ status, headers: { "content-type": "application/json" } },
		);
	}) as unknown as typeof fetch;
}

const REAL_FETCH = globalThis.fetch;

function cfg(overrides: Partial<typeof DEFAULT_CONFIG> = {}) {
	return { ...DEFAULT_CONFIG, ...overrides };
}

function tmp() {
	return mkdtempSync(join(tmpdir(), "pi-ocr-pipe-"));
}

afterEach(() => {
	globalThis.fetch = REAL_FETCH;
});

test("image file: raw text + metadata + sidecar, verdict ok", async () => {
	globalThis.fetch = fakeFetch(200, "linha 1\nlinha 2");
	const dir = tmp();
	try {
		const file = join(dir, "foto com espaco.png"); // R8: spaces everywhere
		writeFileSync(file, "png");
		const { exec, calls } = makeExec({});
		const result = await ocrFile(file, cfg(), ENGINE, { exec });
		assert.equal(result.verdict, "ok");
		assert.equal(result.source, "vision");
		assert.equal(result.text, "linha 1\nlinha 2");
		assert.equal(result.pages.length, 1);
		assert.ok(result.sidecarPath!.endsWith("foto com espaco.ocr.json"));
		const sidecar = JSON.parse(readFileSync(result.sidecarPath!, "utf8"));
		assert.equal(sidecar.schema, "pi-ocr/v1");
		assert.equal(sidecar.verdict, "ok");
		assert.equal(sidecar.text, "linha 1\nlinha 2");
		assert.equal(calls.length, 0); // no shell-out for direct images
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("image with [ILEGÍVEL]: verdict review, text untouched (R6)", async () => {
	globalThis.fetch = fakeFetch(200, "a [ILEGÍVEL] b");
	const dir = tmp();
	try {
		const file = join(dir, "x.png");
		writeFileSync(file, "png");
		const result = await ocrFile(file, cfg(), ENGINE, { exec: makeExec({}).exec });
		assert.equal(result.verdict, "review");
		assert.equal(result.text, "a [ILEGÍVEL] b");
		assert.equal(result.pages[0]!.illegibleCount, 1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("pdf with a real text layer: free extraction, no engine call (R2)", async () => {
	globalThis.fetch = fakeFetch(200, "SHOULD NOT BE CALLED");
	const dir = tmp();
	try {
		const file = join(dir, "native.pdf");
		writeFileSync(file, "pdf");
		const { exec } = makeExec({ textLayer: "Certidão integral de distribuição criminal com conteúdo textual nativo suficiente para o teste." });
		const result = await ocrFile(file, cfg(), ENGINE, { exec });
		assert.equal(result.source, "text-layer");
		assert.equal(result.verdict, "ok");
		assert.ok(result.text.includes("Certidão"));
		assert.deepEqual(result.pages, []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("pdf vision: arg-array exec keeps spaced filenames whole (R8), padded names consumed (R9)", async () => {
	globalThis.fetch = fakeFetch(200, "texto da pagina");
	const dir = tmp();
	try {
		const file = join(dir, "1 GRAU TJRJ.pdf"); // the exact certidões regression
		writeFileSync(file, "pdf");
		const { exec, calls } = makeExec({ pages: 1, textLayer: null });
		const result = await ocrFile(file, cfg(), ENGINE, { exec });
		assert.equal(result.verdict, "ok");
		assert.equal(result.source, "vision");
		const pdftoppm = calls.find((c) => c.command === "pdftoppm")!;
		assert.ok(pdftoppm.args.includes(file), "spaced filename must stay ONE argv element");
		assert.ok(result.sidecarPath!.endsWith("1 GRAU TJRJ.ocr.json"));
		// work dir cleaned up by default
		assert.ok(!existsSync(join(dir, ".ocrwork")));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("dpi retry ladder: first render fails at 200, succeeds at 300 (R10)", async () => {
	let engineCalls = 0;
	globalThis.fetch = (async () => {
		engineCalls += 1;
		return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
	}) as unknown as typeof fetch;
	const dir = tmp();
	try {
		const file = join(dir, "scan.pdf");
		writeFileSync(file, "pdf");
		const { exec } = makeExec({ pages: 1, textLayer: null, renderFailAt: new Set([1]) });
		const result = await ocrFile(file, cfg(), ENGINE, { exec });
		assert.equal(result.verdict, "ok");
		assert.equal(result.pages[0]!.dpi, 300);
		assert.equal(result.pages[0]!.status, "ok");
		assert.equal(engineCalls, 1); // only the successful attempt reaches the engine
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("engine failure on both dpi rungs: verdict failed, attempts recorded (R6/R10)", async () => {
	globalThis.fetch = fakeFetch(500, "boom");
	const dir = tmp();
	try {
		const file = join(dir, "bad.pdf");
		writeFileSync(file, "pdf");
		const { exec } = makeExec({ pages: 1, textLayer: null });
		const result = await ocrFile(file, cfg(), ENGINE, { exec });
		assert.equal(result.verdict, "failed");
		const page = result.pages[0]!;
		assert.equal(page.status, "failed");
		assert.equal(page.attempts!.length, 2);
		assert.ok(page.attempts!.every((a) => /HTTP 500|render/.test(a.error)));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("maxPages cap: truncated + summaryOnly + partial sidecar (safety)", async () => {
	globalThis.fetch = fakeFetch(200, "texto curto");
	const dir = tmp();
	try {
		const file = join(dir, "big.pdf");
		writeFileSync(file, "pdf");
		const { exec } = makeExec({ pages: 5, textLayer: null });
		const result = await ocrFile(file, cfg({ maxPages: 2 }), ENGINE, { exec });
		assert.ok(result.truncated);
		assert.ok(result.summaryOnly);
		assert.equal(result.pages.length, 2);
		const sidecar = JSON.parse(readFileSync(result.sidecarPath!, "utf8"));
		assert.equal(sidecar.truncated, true);
		const formatted = formatFileResult(result, dir);
		assert.match(formatted, /truncated, summary-only/);
		assert.match(formatted, /read the sidecar/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("existing sidecar skips; force re-runs (R5)", async () => {
	globalThis.fetch = fakeFetch(200, "novo texto");
	const dir = tmp();
	try {
		const file = join(dir, "once.png");
		writeFileSync(file, "png");
		const host = { exec: makeExec({}).exec };
		const first = await ocrFile(file, cfg(), ENGINE, host);
		assert.equal(first.verdict, "ok");
		const second = await ocrFile(file, cfg(), ENGINE, host);
		assert.ok(second.skipped);
		assert.equal(second.skipReason, "sidecar exists");
		const third = await ocrFile(file, cfg({ force: true }), ENGINE, host);
		assert.ok(!third.skipped);
		assert.equal(third.text, "novo texto");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("validators downgrade the verdict and land in the sidecar (R7)", async () => {
	globalThis.fetch = fakeFetch(200, "CPF 463.923.197-00 e processo 0293427-93.2022");
	const dir = tmp();
	try {
		const file = join(dir, "v.png");
		writeFileSync(file, "png");
		const result = await ocrFile(
			file,
			cfg({ validators: { cpf: { pattern: "\\d{3}\\.\\d{3}\\.\\d{3}-\\d{2}", min: 2 } } }),
			ENGINE,
			{ exec: makeExec({}).exec },
		);
		assert.equal(result.verdict, "review");
		assert.equal(result.validators[0]!.name, "cpf");
		assert.equal(result.validators[0]!.pass, false); // CPF present once, min 2
		const sidecar = JSON.parse(readFileSync(result.sidecarPath!, "utf8"));
		assert.deepEqual(sidecar.validators, [{ name: "cpf", present: true, matches: 1, pass: false }]); // one CPF, min 2
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("formatFileResult: metadata block first, raw text after (R1/R6)", async () => {
	globalThis.fetch = fakeFetch(200, "TEXTO BRUTO [ILEGÍVEL]");
	const dir = tmp();
	try {
		const file = join(dir, "fmt.png");
		writeFileSync(file, "png");
		const result = await ocrFile(file, cfg(), ENGINE, { exec: makeExec({}).exec });
		const out = formatFileResult(result, dir);
		const metaIdx = out.indexOf("verdict: review");
		const textIdx = out.indexOf("TEXTO BRUTO");
		assert.ok(metaIdx >= 0 && textIdx > metaIdx, "metadata must precede raw text");
		assert.match(out, /source: vision/);
		assert.match(out, /sidecar: /);
		assert.ok(out.includes("TEXTO BRUTO [ILEGÍVEL]"), "raw text must be untouched");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
