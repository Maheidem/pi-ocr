import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";

const home = mkdtempSync(join(tmpdir(), "ocr-ext-"));
process.env.HOME = home;

const [{ default: extension }, { CONFIG_PATH }, { ACTION_INVENTORY }] = await Promise.all([
	import("../extensions/index.ts"),
	import("../extensions/config.ts"),
	import("../extensions/application.ts"),
]);

after(() => rmSync(home, { recursive: true, force: true }));

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	strikethrough: (text: string) => text,
} as unknown as Theme;

const keybindings = {
	matches: (data: string, binding: string) =>
		({
			"tui.select.up": "\x1b[A",
			"tui.select.down": "\x1b[B",
			"tui.select.confirm": "\r",
			"tui.select.cancel": "\x1b",
		})[binding] === data,
	getKeys: (binding: string) => [],
} as unknown as KeybindingsManager;

interface RegisteredCommand {
	description: string;
	getArgumentCompletions(prefix: string): Array<{ value: string; label: string }> | null;
	handler(args: string, ctx: any): Promise<void>;
}
interface RegisteredTool {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	execute(id: string, params: any, signal: AbortSignal, onUpdate: unknown, ctx: any): Promise<unknown>;
}

const commands = new Map<string, RegisteredCommand>();
const tools = new Map<string, RegisteredTool>();
const inputHooks: Array<(event: { text?: string; source?: string }, ctx: any) => Promise<unknown>> = [];
let execImpl: (command: string, args: string[], options?: unknown) => Promise<{ stdout: string; code: number }> = async () => ({ stdout: "", code: 1 });

extension({
	registerCommand: (name: string, definition: RegisteredCommand) => commands.set(name, definition),
	registerTool: (definition: RegisteredTool) => tools.set(definition.name, definition),
	on: (event: string, handler: (e: any, ctx: any) => Promise<unknown>) => {
		if (event === "input") inputHooks.push(handler as never);
	},
	exec: (command: string, args: string[], options?: unknown) => execImpl(command, args, options),
} as any);

function makeCtx(options: { mode?: "tui" | "print"; interact?: (component: any) => void; confirm?: boolean } = {}) {
	const notifications: Array<{ message: string; level: string }> = [];
	let overlayOptions: unknown;
	const ctx = {
		mode: options.mode ?? "tui",
		hasUI: (options.mode ?? "tui") === "tui",
		cwd: process.cwd(),
		signal: undefined,
		model: undefined,
		modelRegistry: undefined,
		ui: {
			notify: (message: string, level: string) => notifications.push({ message, level }),
			confirm: async () => options.confirm ?? false,
			custom: async (factory: any, customOptions: unknown) => {
				overlayOptions = customOptions;
				let result: unknown;
				const component = factory({ requestRender() {} }, theme, keybindings, (value: unknown) => {
					result = value;
				});
				component.focused = true;
				options.interact?.(component);
				return result;
			},
		},
	};
	return { ctx, notifications, get overlayOptions() { return overlayOptions; } };
}

test("registers one command, one tool, one input hook; defaults discoverable", () => {
	assert.deepEqual([...commands.keys()], ["ocr"]);
	assert.deepEqual([...tools.keys()], ["ocr"]);
	assert.equal(inputHooks.length, 1);
	assert.ok(existsSync(CONFIG_PATH));
	const config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
	assert.equal(config.schema, "ocr/v1");
	assert.equal(config.autoDetect, false); // R11 default off
});

test("tool description teaches sidecar + verdict + text-layer behavior", () => {
	const tool = tools.get("ocr")!;
	assert.match(tool.description, /sidecar/);
	assert.match(tool.description, /verdict/);
	assert.match(tool.description, /text layer/);
	assert.ok((tool.parameters as { properties: Record<string, unknown> }).properties?.paths, "paths parameter must be declared");
});

test("nested verbs reach the same controller the panel uses (R12 parity)", async () => {
	const h = makeCtx();
	const command = commands.get("ocr")!;
	await command.handler("dpi 300", h.ctx);
	await command.handler("dpiretry 400", h.ctx);
	await command.handler("autodetect on", h.ctx);
	await command.handler("model none", h.ctx);
	await command.handler("visionmodel qwen3.8-flash", h.ctx);
	const config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
	assert.equal(config.dpi, 300);
	assert.equal(config.dpiRetry, 400);
	assert.equal(config.autoDetect, true);
	assert.equal(config.model, null);
	assert.equal(config.defaultVisionModel, "qwen3.8-flash");
	// every inventory verb is completable
	for (const item of ACTION_INVENTORY) {
		const completions = command.getArgumentCompletions(item.verb) ?? [];
		assert.ok(completions.some((c) => c.value.startsWith(item.verb)), `verb ${item.verb} missing from completions`);
	}
});

test("status prints version provenance and config summary", async () => {
	const h = makeCtx({ mode: "print" });
	const output: string[] = [];
	const original = console.log;
	console.log = (...parts: unknown[]) => output.push(parts.join(" "));
	try {
		await commands.get("ocr")!.handler("status", h.ctx);
	} finally {
		console.log = original;
	}
	const text = output.join("\n");
	assert.match(text, /OCR v\d+\.\d+\.\d+/); // version provenance, version-agnostic
	assert.match(text, /input hook:/);
});

test("panel: opens INLINE like pi-delegate (no overlay popup)", async () => {
	const h = makeCtx({
		interact: (component) => {
			// navigate: default initialKey is "model"; move down to autodetect row is
			// fragile — use the controller-path instead: q closes the panel.
			component.handleInput("q");
		},
	});
	await commands.get("ocr")!.handler("", h.ctx);
	// pi-delegate UX: INLINE panel (no overlay) — matches openDashboard.
	const options = h.overlayOptions as Record<string, unknown> | undefined;
	assert.ok(options && !("overlay" in options), "must not mount as an overlay popup");
	assert.equal(typeof options?.onCancel, "function");
});

test("/ocr now with no engine and no session model fails with guidance, not a crash", async () => {
	const dir = mkdtempSync(join(tmpdir(), "ocr-now-"));
	try {
		writeFileSync(join(dir, "a.png"), "png");
		const config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
		// clear model + fallback so resolution must fail
		config.model = null;
		config.defaultVisionModel = null;
		writeFileSync(CONFIG_PATH, JSON.stringify(config));
		const h = makeCtx(); // ctx.model undefined
		await commands.get("ocr")!.handler(`now ${join(dir, "a.png")}`, h.ctx);
		assert.ok(
			h.notifications.some((n) => /No OCR engine available|does not declare image input|not OpenAI-compatible/.test(n.message)),
			"expected a resolution error notification",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("input hook: off by default, transform when enabled (R11)", async () => {
	const hook = inputHooks[0]!;
	const dir = mkdtempSync(join(tmpdir(), "ocr-hook-"));
	try {
		const file = join(dir, "pasted.png");
		writeFileSync(file, "png");

		// default: hook passes through untouched
		let out = (await hook({ text: `see ${file}`, source: "user" }, makeCtx().ctx)) as { action: string; text?: string };
		assert.equal(out.action, "continue");

		// enabled: a vision-capable fake session model + fake fetch OCRs it
		const config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
		config.autoDetect = true;
		config.model = "fake-vision";
		writeFileSync(CONFIG_PATH, JSON.stringify(config));
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ choices: [{ message: { content: "texto do hook" } }] }), { status: 200 })) as unknown as typeof fetch;
		const logged: string[] = [];
		const originalLog = console.log;
		console.log = (...parts: unknown[]) => logged.push(parts.join(" "));
		try {
			const ctx = makeCtx().ctx;
			out = (await hook({ text: `see ${file}`, source: "user" }, ctx)) as { action: string; text?: string };
			assert.equal(out.action, "transform");
			assert.match(out.text!, /texto do hook/);
			assert.match(out.text!, /verdict: ok/);
		} finally {
			globalThis.fetch = realFetch;
			console.log = originalLog;
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("tool execute: end-to-end via fake session model — raw text + metadata + sidecar", async () => {
	const dir = mkdtempSync(join(tmpdir(), "ocr-tool-"));
	try {
		const file = join(dir, "doc com espaco.png");
		writeFileSync(file, "png");
		const tool = tools.get("ocr")!;
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ choices: [{ message: { content: "CONTEUDO BRUTO" } }] }), { status: 200 })) as unknown as typeof fetch;
		try {
			const result = (await tool.execute(
				"id",
				{ paths: [file], model: "fake-vision" },
				new AbortController().signal,
				undefined,
				makeCtx().ctx,
			)) as { content: Array<{ type: string; text: string }>; details: Record<string, unknown> };
			const text = result.content[0]!.text;
			assert.match(text, /CONTEUDO BRUTO/);
			assert.match(text, /verdict: ok/);
			assert.match(text, /source: vision/);
			assert.equal(result.details.model, "fake-vision");
			assert.equal(result.details.engineSource, "tool-arg");
			assert.ok(existsSync(join(dir, "doc com espaco.ocr.json")));
		} finally {
			globalThis.fetch = realFetch;
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
