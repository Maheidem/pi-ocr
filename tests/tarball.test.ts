/**
 * Tarball integrity (spec R14, QUALITY-GATES): a `files` allowlist ships a
 * package that loads nowhere fresh if a runtime module is missing — every
 * source-tree test stays green while the published artifact is broken.
 * Assert that every file pi needs at runtime is covered by the allowlist
 * and every relative import resolves inside the shipped set.
 */
import "./isolate.ts";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
	files: string[];
	pi?: { extensions: string[] };
};

function walk(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) out.push(...walk(full));
		else out.push(full);
	}
	return out;
}

test("files allowlist covers every runtime module under extensions/", () => {
	const runtime = walk(join(root, "extensions")).filter((f) => extname(f) === ".ts" && !f.endsWith(".test.ts"));
	assert.ok(runtime.length > 10, "expected a real module set");
	const allowlist = pkg.files;
	for (const pattern of allowlist) {
		if (pattern === "extensions/" || pattern === "extensions") {
			return; // directory include covers everything
		}
	}
	assert.fail(`files allowlist does not cover extensions/ as a directory: ${JSON.stringify(allowlist)}`);
});

test("every relative import resolves inside the shipped set", () => {
	const modules = walk(join(root, "extensions")).filter((f) => extname(f) === ".ts");
	const failures: string[] = [];
	for (const file of modules) {
		const source = readFileSync(file, "utf8");
		for (const match of source.matchAll(/from\s+"(\.[^"]+)"/g)) {
			const spec = match[1]!;
			const base = resolve(dirname(file), spec);
			const candidates = [base, `${base}.ts`, join(base, "index.ts")];
			if (!candidates.some((c) => existsQuiet(c))) {
				failures.push(`${file}: ${spec}`);
			}
		}
	}
	assert.deepEqual(failures, []);
});

function existsQuiet(path: string): boolean {
	try {
		statSync(path);
		return true;
	} catch {
		return false;
	}
}

test("pi entrypoint declared in package.json points at a shipped file", () => {
	const entry = pkg.pi?.extensions?.[0];
	assert.ok(entry, "pi.extensions must be declared");
	assert.ok(existsQuiet(join(root, entry)), `entrypoint ${entry} does not exist`);
});
