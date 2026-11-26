import assert from "node:assert/strict";
import test from "node:test";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import {
  SettingsPanel,
  type PanelResult,
  type PanelSnapshot,
} from "../extensions/ui/settings-panel.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  strikethrough: (text: string) => text,
} as unknown as Theme;

function fakeKeybindings(overrides: Partial<Record<string, string>> = {}): KeybindingsManager {
  const keys: Record<string, string> = {
    "tui.select.up": "\x1b[A",
    "tui.select.down": "\x1b[B",
    "tui.select.confirm": "\r",
    "tui.select.cancel": "\x1b",
    ...overrides,
  };
  return {
    matches: (data: string, binding: string) => data === keys[binding],
    getKeys: (binding: string) => {
      const display: Record<string, string> = {
        "tui.select.up": "up",
        "tui.select.down": "down",
        "tui.select.confirm": "enter",
        "tui.select.cancel": "escape",
      };
      return [display[binding] ?? binding];
    },
  } as unknown as KeybindingsManager;
}

function harness(initialKey = "enabled", keybindings = fakeKeybindings()) {
  const state = { enabled: true, mode: "auto", limit: 10 };
  let result: PanelResult | undefined;
  let renders = 0;

  const snapshot = (): PanelSnapshot => ({
    title: "Reference Panel",
    summaryLines: [`State: ${state.enabled ? "enabled" : "disabled"}`],
    sections: [
      {
        title: "General",
        rows: [
          { key: "enabled", label: "Extension", value: state.enabled ? "enabled" : "disabled", rawValue: String(state.enabled), kind: "toggle" },
          { key: "mode", label: "Mode", value: state.mode, rawValue: state.mode, choices: ["auto", "safe", "fast"], kind: "cycle" },
          { key: "limit", label: "Item limit", value: String(state.limit), rawValue: String(state.limit), inputHint: "1-100", kind: "input" },
          { key: "info", label: "Config", value: "/tmp/config.json", kind: "info" },
          { key: "reset", label: "Reset settings", value: "confirm…", kind: "action" },
        ],
      },
    ],
    idleMessage: "Changes save immediately",
    shortcuts: [{ key: "p", label: "paths", action: "paths" }],
  });

  const panel = new SettingsPanel({
    theme,
    keybindings,
    initialKey,
    snapshot,
    apply: (key, raw) => {
      if (key === "enabled") state.enabled = raw === "true";
      else if (key === "mode") state.mode = raw;
      else if (key === "limit") {
        const value = Number(raw);
        if (!Number.isInteger(value) || value < 1 || value > 100) return "Item limit must be 1-100";
        state.limit = value;
      }
      return null;
    },
    activate: (key) => key === "reset" || key === "paths"
      ? { kind: "close", action: key }
      : { kind: "none" },
    requestRender: () => { renders += 1; },
    done: (value) => { result = value; },
  });
  panel.focused = true;

  return { panel, state, get result() { return result; }, get renders() { return renders; } };
}

test("renders semantic sections and never exceeds the supplied width", () => {
  const { panel } = harness();
  for (const width of [80, 62, 20, 1]) {
    const lines = panel.render(width);
    assert.ok(lines.every((line) => visibleWidth(line) <= Math.max(1, width)), `overflow at width ${width}`);
  }
  const lines = panel.render(80);
  const text = lines.join("\n");
  assert.match(lines[0] ?? "", /Reference Panel ─+╮$/, "title border must continue horizontally");
  assert.match(text, /General/);
  assert.match(text, /p paths/);
  assert.match(text, /↑\/↓\/jk move/);
  assert.match(text, /enter select/);
});

test("uses the injected Pi keybindings for navigation", () => {
  const kb = fakeKeybindings({ "tui.select.down": "n" });
  const { panel, state } = harness("enabled", kb);
  panel.handleInput("n");
  panel.handleInput("\r");
  assert.equal(state.mode, "safe");
});

test("toggle and cycle changes apply immediately", () => {
  const toggle = harness("enabled");
  toggle.panel.handleInput("\r");
  assert.equal(toggle.state.enabled, false);
  assert.match(toggle.panel.render(80).join("\n"), /Extension: disabled/);

  const cycle = harness("mode");
  cycle.panel.handleInput("\r");
  assert.equal(cycle.state.mode, "safe");
});

test("prefilled inline input places the cursor and accepts a valid edit", () => {
  const h = harness("limit");
  h.panel.handleInput("\r");
  assert.ok(h.panel.render(80).join("\n").includes(CURSOR_MARKER));
  h.panel.handleInput("\x7f");
  h.panel.handleInput("\x7f");
  h.panel.handleInput("2");
  h.panel.handleInput("5");
  h.panel.handleInput("\r");
  assert.equal(h.state.limit, 25);
  assert.match(h.panel.render(80).join("\n"), /Item limit: 25/);
});

test("invalid inline input remains editable and escape cancels", () => {
  const h = harness("limit");
  h.panel.handleInput("\r");
  h.panel.handleInput("\x7f");
  h.panel.handleInput("\x7f");
  h.panel.handleInput("0");
  h.panel.handleInput("\r");
  assert.equal(h.state.limit, 10);
  assert.match(h.panel.render(80).join("\n"), /Item limit must be 1-100/);
  assert.ok(h.panel.render(80).join("\n").includes(CURSOR_MARKER));
  h.panel.handleInput("\x1b");
  assert.match(h.panel.render(80).join("\n"), /Edit cancelled/);
});

test("row actions and mnemonic shortcuts return typed results", () => {
  const row = harness("reset");
  row.panel.handleInput("\r");
  assert.deepEqual(row.result, { action: "reset" });

  const shortcut = harness();
  shortcut.panel.handleInput("p");
  assert.deepEqual(shortcut.result, { action: "paths" });
});

test("cancel and q close without an action", () => {
  const cancel = harness();
  cancel.panel.handleInput("\x1b");
  assert.deepEqual(cancel.result, {});

  const quit = harness();
  quit.panel.handleInput("q");
  assert.deepEqual(quit.result, {});
});
