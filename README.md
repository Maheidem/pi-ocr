# @maheidem/pi-ocr

Pi coding-agent extension that OCRs PDFs (page-split) and images through a
configurable vision model, returns the **raw** transcription with an
interpretation **metadata** block, and persists an auditable JSON sidecar
beside every file.

Design spec: [`.planning/ocr-2026-10-01.md`](.planning/ocr-2026-10-01.md)
(prior art: the certidões pipeline — qwen3.8-flash @ 200 dpi recovered 88/88
PDFs where tesseract corrupted process numbers and CPFs).

## Surfaces

| Surface | What it does |
|---|---|
| `ocr` tool | OCR files/directories: PDFs (rendered per page, `pdftoppm`) and PNG/JPG/WebP/BMP/TIFF. PDFs with a real text layer are extracted free via `pdftotext` (no model call). Returns metadata (verdict, per-page status, illegible count, validators) then the raw text; writes `<name>.ocr.json`. |
| `/ocr` | Control panel (Engine / Pipeline / Behavior sections). Headless degrades to a status report. |
| `/ocr now <paths…>` | Run OCR from the command surface (`--force`, `--dpi=`, `--model=`, `--recursive`). |
| `/ocr status` | Version provenance, effective config, vision-capable model suggestions (read from `model-discovery.json`, display-only). |
| input hook | Auto-OCR pasted image/pdf paths — **off by default**; enable with `/ocr autodetect on`. |

## Engine resolution (in order)

1. `model` tool arg / `--model=` (against the configured base URL)
2. `model` in `~/.pi/agent/ocr/config.json`
3. the **session's current model**, if it declares image input and speaks an
   OpenAI-compatible API (auth resolved through pi's model registry)
4. `defaultVisionModel` in config (default: `qwen3.8-flash` @ the local oMLX)
5. clear error pointing at `/ocr`

## Verdicts (metadata, never a rewrite of the text)

- `ok` — all pages extracted, no `[ILEGÍVEL]`/`[ILLEGIBLE]` markers, validators pass
- `review` — illegible markers present, or a validator found fewer matches than expected
- `failed` — a page failed after the dpi retry ladder (200 → 300 dpi)

Validators are named regexes in config (`validators: { cpf: { pattern: "…", min: 1 } }`);
a validator passes when the pattern is **absent** from the text, or present and
matching at least `min` times. Mismatches downgrade the verdict only.

## Sidecar — `pi-ocr/v1`

`<name>.ocr.json` beside the source: `{ schema, generatedAt, source:
"text-layer"|"vision", model, baseUrl, dpi, truncated, verdict, text, pages:
[{ n, status, bytes, latencyMs, dpi, chars, illegibleCount, attempts? }],
validators? }`. Existing sidecars are skipped unless `force`. Above the
context guard (100k chars default) or when `maxPages` truncates, the tool
returns metadata only — page through the sidecar with `read`.

## Config

`~/.pi/agent/ocr/config.json` (editable via the panel): `baseUrl`, `model`,
`apiKey`, `defaultVisionModel`, `timeoutMs`, `dpi` (200), `dpiRetry` (300),
`maxTokens` (4096), `maxPages` (200), `maxBytes`, `contextGuardChars`
(100000), `textLayerMinChars` (50), `autoDetect` (false), `force`,
`keepRenders`, `prompt`, `validators`.

Requires `pdftotext` / `pdftoppm` / `pdfinfo` (poppler) on PATH for PDFs.

## Development

```bash
npm run typecheck
npm test                 # 44 tests: domain, pipeline (fake exec+fetch), adapter, panel contract, tarball integrity
npm pack --dry-run --ignore-scripts
```

Vendored UI primitives are byte-identical to the pi-extension-builder kit —
enforced by `node skills/pi-extension-builder/scripts/check-vendored.mjs`
(ocr is a registered consumer, 8 artifacts).

**Not yet published** — `private: true` is retained deliberately as a
publish-blocker; publishing (M3) is user-gated: remove `private`, `npm
publish`, `pi install npm:@maheidem/pi-ocr@<exact>`, `/reload`.

Evidence: [`.planning/ocr-2026-10-01/evidence/`](.planning/ocr-2026-10-01/evidence/manifest.json)
(deterministic PNGs at 80/62/20, live TUI frame, real-session export of a
model-driven OCR run, live oMLX verification).
