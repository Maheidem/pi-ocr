/**
 * Panel snapshot for the /ocr control panel (spec R12): Engine, Pipeline,
 * Behavior sections over the canonical controller. Derived data only.
 */

import { CONFIG_PATH } from "../config.ts";
import { ACTION_INVENTORY, OcrController } from "../application.ts";
import { EXTENSION_TITLE } from "../metadata.ts";
import type { PanelSnapshot } from "@maheidem/pi-panel-kit";

function boolRow(controller: OcrController, key: "autoDetect" | "force" | "keepRenders", label: string) {
	const value = controller.config()[key];
	return {
		key,
		label,
		value: value ? "on" : "off",
		rawValue: String(value),
		kind: "toggle" as const,
	};
}

function numberRow(key: string, label: string, value: number, hint: string) {
	return {
		key,
		label,
		value: String(value),
		rawValue: String(value),
		inputHint: hint,
		kind: "input" as const,
	};
}

export function buildOcrPanelSnapshot(controller: OcrController): PanelSnapshot {
	const config = controller.config();
	const maskKey = (key: string | null) =>
		!key ? "(none)" : key.length <= 6 ? "****" : `${key.slice(0, 4)}…${key.slice(-2)}`;

	return {
		title: EXTENSION_TITLE,
		summaryLines: [
			`${controller.promptPreview().slice(0, 40)}`,
			`Engine: ${config.model ?? "session model → " + (config.defaultVisionModel ?? "none")} @ ${config.baseUrl}`,
		],
		sections: [
			{
				title: "Engine",
				rows: [
					{
						key: "baseUrl",
						label: "Base URL",
						value: config.baseUrl,
						rawValue: config.baseUrl,
						inputHint: "OpenAI-compatible base URL (…/v1)",
						kind: "input",
					},
					{
						key: "model",
						label: "Model",
						value: config.model ?? "(session model)",
						rawValue: config.model ?? "",
						inputHint: 'Model id, or "none" to follow the session model',
						kind: "input",
					},
					{
						key: "apiKey",
						label: "API key",
						value: maskKey(config.apiKey),
						rawValue: "",
						inputHint: 'Bearer token, "none" to clear (masked)',
						kind: "input",
					},
					{
						key: "defaultVisionModel",
						label: "Vision fallback",
						value: config.defaultVisionModel ?? "(none)",
						rawValue: config.defaultVisionModel ?? "",
						inputHint: 'Used when the session model lacks image input; "none" to clear',
						kind: "input",
					},
					numberRow("timeoutMs", "Timeout", config.timeoutMs, "Per engine call, ms (1000-3600000)"),
					numberRow("maxTokens", "maxTokens", config.maxTokens, "256-200000"),
				],
			},
			{
				title: "Pipeline",
				rows: [
					numberRow("dpi", "Render DPI", config.dpi, "PDF page render resolution (72-1200)"),
					numberRow("dpiRetry", "Retry DPI", config.dpiRetry, "Failed pages retry once at this DPI"),
					numberRow("maxPages", "Max pages", config.maxPages, "Safety cap per PDF (1-10000)"),
					numberRow("maxBytes", "Max image bytes", config.maxBytes, "0 = no limit"),
					numberRow("textLayerMinChars", "Text-layer min", config.textLayerMinChars, "Chars for a PDF to skip the model (pdftotext)"),
					numberRow("contextGuardChars", "Context guard", config.contextGuardChars, "Above this, return summary only"),
				],
			},
			{
				title: "Behavior",
				rows: [
					boolRow(controller, "autoDetect", "Auto-OCR input hook"),
					boolRow(controller, "force", "Force re-OCR"),
					boolRow(controller, "keepRenders", "Keep page renders"),
					{
						key: "prompt",
						label: "Prompt",
						value: controller.promptPreview(),
						rawValue: controller.config().prompt,
						inputHint: "Transcription prompt — empty keeps current",
						kind: "input",
					},
					{
						key: "validators",
						label: "Validators",
						value: Object.keys(config.validators).join(", ") || "(none)",
						valueStyle: "muted",
						kind: "info",
					},
					{
						key: "configPath",
						label: "Config path",
						value: CONFIG_PATH,
						valueStyle: "muted",
						kind: "info",
					},
					{
						key: "reset",
						label: "Reset settings",
						value: "confirm…",
						valueStyle: "warning",
						kind: "action",
					},
				],
			},
		],
		idleMessage: "Changes save immediately",
		shortcuts: [
			{ key: "s", label: "status", action: "status" },
			{ key: "r", label: "reset", action: "reset" },
		],
	};
}

/** Keys the panel routes to the host (parity surface with nested verbs). */
export const PANEL_ACTION_KEYS = [...ACTION_INVENTORY.map((item) => item.panelKey), "reset", "status", "paths"] as const;
