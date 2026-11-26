/**
 * Canonical actions shared by the panel, nested command syntax, and the
 * tool (spec R12). The ACTION_INVENTORY below is the single declarative
 * join between panel keys, nested verbs, and controller methods — the
 * parity test runs over it (QUALITY-GATES §12).
 */

import {
	CONFIG_PATH,
	loadConfig,
	resetConfig,
	saveConfig,
	type OcrConfig,
} from "./config.ts";
import { COMMAND_NAME, EXTENSION_TITLE } from "./metadata.ts";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { extensionVersion } from "./ui/version.ts";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageJsonPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");

export function ocrVersion(): string {
	return extensionVersion({ packageJsonPath, label: EXTENSION_TITLE });
}

export type SettingKey =
	| "baseUrl"
	| "model"
	| "apiKey"
	| "defaultVisionModel"
	| "timeoutMs"
	| "dpi"
	| "dpiRetry"
	| "maxTokens"
	| "maxPages"
	| "maxBytes"
	| "contextGuardChars"
	| "autoDetect"
	| "force"
	| "keepRenders"
	| "textLayerMinChars"
	| "prompt";

/** Panel key ⇄ nested verb ⇄ controller method (R12 parity inventory). */
export const ACTION_INVENTORY: ReadonlyArray<{
	panelKey: SettingKey;
	verb: string;
	method: keyof OcrController;
	kind: "toggle" | "value";
}> = [
	{ panelKey: "baseUrl", verb: "baseurl", method: "apply", kind: "value" },
	{ panelKey: "model", verb: "model", method: "apply", kind: "value" },
	{ panelKey: "apiKey", verb: "apikey", method: "apply", kind: "value" },
	{ panelKey: "defaultVisionModel", verb: "visionmodel", method: "apply", kind: "value" },
	{ panelKey: "timeoutMs", verb: "timeout", method: "apply", kind: "value" },
	{ panelKey: "dpi", verb: "dpi", method: "apply", kind: "value" },
	{ panelKey: "dpiRetry", verb: "dpiretry", method: "apply", kind: "value" },
	{ panelKey: "maxTokens", verb: "maxtokens", method: "apply", kind: "value" },
	{ panelKey: "maxPages", verb: "maxpages", method: "apply", kind: "value" },
	{ panelKey: "maxBytes", verb: "maxbytes", method: "apply", kind: "value" },
	{ panelKey: "contextGuardChars", verb: "guard", method: "apply", kind: "value" },
	{ panelKey: "autoDetect", verb: "autodetect", method: "apply", kind: "toggle" },
	{ panelKey: "force", verb: "force", method: "apply", kind: "toggle" },
	{ panelKey: "keepRenders", verb: "keeprenders", method: "apply", kind: "toggle" },
	{ panelKey: "textLayerMinChars", verb: "textmin", method: "apply", kind: "value" },
	{ panelKey: "prompt", verb: "prompt", method: "apply", kind: "value" },
];

function intInput(value: string): number | null {
	const n = Number(value.trim());
	return Number.isInteger(n) && n >= 0 ? n : null;
}

function maskKey(key: string | null): string {
	if (!key) return "(none)";
	return key.length <= 6 ? "****" : `${key.slice(0, 4)}…${key.slice(-2)}`;
}

/** Canonical controller: the ONLY writer of ~/.pi/agent/ocr/config.json. */
export class OcrController {
	private configValue: OcrConfig;

	constructor() {
		this.configValue = loadConfig();
	}

	config(): OcrConfig {
		return { ...this.configValue, apiKey: this.configValue.apiKey };
	}

	apply(key: SettingKey, rawValue: string): string | null {
		const next = { ...this.configValue };
		const trimmed = rawValue.trim();

		switch (key) {
			case "baseUrl":
				if (!trimmed) return "Base URL must not be empty";
				next.baseUrl = trimmed;
				break;
			case "model":
				next.model = trimmed.toLowerCase() === "none" ? null : trimmed || null;
				break;
			case "apiKey":
				next.apiKey = trimmed.toLowerCase() === "none" ? null : trimmed || null;
				break;
			case "defaultVisionModel":
				next.defaultVisionModel = trimmed.toLowerCase() === "none" ? null : trimmed || null;
				break;
			case "timeoutMs": {
				const n = intInput(trimmed);
				if (n === null || n < 1_000 || n > 3_600_000) return "Timeout must be 1000-3600000 ms";
				next.timeoutMs = n;
				break;
			}
			case "dpi": {
				const n = intInput(trimmed);
				if (n === null || n < 72 || n > 1200) return "DPI must be 72-1200";
				next.dpi = n;
				break;
			}
			case "dpiRetry": {
				const n = intInput(trimmed);
				if (n === null || n < 72 || n > 1200) return "Retry DPI must be 72-1200";
				next.dpiRetry = n;
				break;
			}
			case "maxTokens": {
				const n = intInput(trimmed);
				if (n === null || n < 256 || n > 200_000) return "maxTokens must be 256-200000";
				next.maxTokens = n;
				break;
			}
			case "maxPages": {
				const n = intInput(trimmed);
				if (n === null || n < 1 || n > 10_000) return "maxPages must be 1-10000";
				next.maxPages = n;
				break;
			}
			case "maxBytes": {
				const n = intInput(trimmed);
				if (n === null || n > 2 ** 40) return "maxBytes must be >= 0";
				next.maxBytes = n;
				break;
			}
			case "contextGuardChars": {
				const n = intInput(trimmed);
				if (n === null || n < 1_000 || n > 10_000_000) return "Context guard must be 1000-10000000 chars";
				next.contextGuardChars = n;
				break;
			}
			case "textLayerMinChars": {
				const n = intInput(trimmed);
				if (n === null || n > 100_000) return "Text-layer threshold must be >= 0 chars";
				next.textLayerMinChars = n;
				break;
			}
			case "autoDetect":
			case "force":
			case "keepRenders": {
				const on = ["1", "true", "yes", "on", "enabled"].includes(trimmed.toLowerCase());
				const off = ["0", "false", "no", "off", "disabled"].includes(trimmed.toLowerCase());
				if (!on && !off) return `${key} accepts on or off`;
				next[key] = on;
				break;
			}
			case "prompt":
				if (!trimmed) return "Prompt must not be empty";
				next.prompt = trimmed;
				break;
		}

		this.configValue = saveConfig(next);
		return null;
	}

	reset(): OcrConfig {
		this.configValue = resetConfig();
		return this.config();
	}

	promptPreview(): string {
		const prompt = this.configValue.prompt;
		return prompt.length > 72 ? `${prompt.slice(0, 69)}…` : prompt;
	}

	/**
	 * R13: suggest vision-capable models, read-only, from
	 * ~/.pi/agent/model-discovery.json overrides when present. Config stays
	 * the source of truth — this is display-only.
	 */
	async visionSuggestions(): Promise<string[]> {
		interface Override {
			input?: string[];
		}
		interface ProviderEntry {
			baseUrl?: string;
			modelOverrides?: Record<string, Override>;
		}
		try {
			const raw = await readFile(join(homedir(), ".pi", "agent", "model-discovery.json"), "utf8");
			const providers = JSON.parse(raw) as Record<string, ProviderEntry>;
			const out: string[] = [];
			for (const [providerName, provider] of Object.entries(providers)) {
				for (const [modelId, override] of Object.entries(provider.modelOverrides ?? {})) {
					if (override.input?.includes("image")) out.push(`${providerName}/${modelId} (${provider.baseUrl ?? "?"})`);
				}
			}
			return out.sort();
		} catch {
			return [];
		}
	}

	statusReport(): string {
		const c = this.configValue;
		return [
			`${ocrVersion()}`,
			`  engine:        ${c.baseUrl}`,
			`  model:         ${c.model ?? "(resolve: session model if vision-capable)"}`,
			`  fallback:      ${c.defaultVisionModel ?? "(none)"}`,
			`  api key:       ${maskKey(c.apiKey)}`,
			`  pdf pipeline:  ${c.dpi} dpi (retry ${c.dpiRetry}), max ${c.maxPages} pages, text-layer >= ${c.textLayerMinChars} chars`,
			`  limits:        maxTokens ${c.maxTokens}, maxBytes ${c.maxBytes || "none"}, context guard ${c.contextGuardChars} chars`,
			`  input hook:    ${c.autoDetect ? "on" : "off (default — tool is invoked on demand)"}`,
			`  force:         ${c.force ? "on" : "off"} · keepRenders: ${c.keepRenders ? "on" : "off"}`,
			`  validators:    ${Object.keys(c.validators).join(", ") || "(none)"}`,
			`  prompt:        ${this.promptPreview()}`,
			`  config:        ${CONFIG_PATH}`,
		].join("\n");
	}

	helpReport(): string {
		const verbs = ACTION_INVENTORY.map((item) =>
			item.kind === "toggle" ? `/${COMMAND_NAME} ${item.verb} on|off` : `/${COMMAND_NAME} ${item.verb} <value>`,
		);
		return [
			`/${COMMAND_NAME} — open the control panel`,
			`/${COMMAND_NAME} now <paths…> — run OCR now (same engine resolution as the tool)`,
			`/${COMMAND_NAME} status`,
			...verbs,
			`/${COMMAND_NAME} paths`,
			`/${COMMAND_NAME} reset`,
			`/${COMMAND_NAME} help`,
			`model/apikey/visionmodel accept "none" to clear`,
		].join("\n");
	}
}
