/**
 * ui/endpoint-panel.ts — template-side BACK_KEY source.
 *
 * The vendored `ui/report-panel.ts` is byte-identical to
 * `custom-extensions/model-discovery/ui/report-panel.ts`, which imports
 * `BACK_KEY` from its (domain-specific, 28 KiB drill-down) endpoint panel.
 * The generic control-panel template has no such drill-down, so this file
 * supplies only the shared back-key constant the report panel needs.
 */

/** Row key that tells the host to pop back to the previous screen. */
export const BACK_KEY = "back";
