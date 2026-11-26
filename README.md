# @maheidem/pi-ocr

Pi coding-agent extension that OCRs PDFs (page-split) and images through a
configurable vision model, returns the **raw** transcription with an
interpretation **metadata** block, and persists an auditable JSON sidecar
beside every file.

Prior art: the certidões pipeline (qwen3.8-flash @ 200 dpi recovered 88/88
PDFs where tesseract corrupted process numbers and CPFs).

## Install

```bash
pi install npm:@maheidem/pi-ocr@<x.y.z>
```

Use an exact version. Then run `/reload` in a Pi session that is open.

For PDFs, `pdftotext`, `pdftoppm` and `pdfinfo` (poppler) must be on PATH.

## Usage

| Surface | What it does |
|---|---|
| `ocr` tool | OCR files/directories: PDFs (rendered per page, `pdftoppm`) and PNG/JPG/WebP/BMP/TIFF. PDFs with a real text layer are extracted free via `pdftotext` (no model call). Returns metadata (verdict, per-page status, illegible count, validators) then the raw text; writes `<name>.ocr.json`. |
| `/ocr` | Control panel (Engine / Pipeline / Behavior sections). Headless degrades to a status report. |
| `/ocr now <paths…>` | Run OCR from the command surface (`--force`, `--dpi=`, `--model=`, `--recursive`). |
| `/ocr status` | Version provenance, effective config, vision-capable model suggestions (read from `model-discovery.json`, display-only). |
| `/ocr paths` | Print the config file path. |
| input hook | Auto-OCR pasted image/pdf paths — **off by default**; enable with `/ocr autodetect on`. |

### Engine resolution (in order)

1. `model` tool arg / `--model=` (against the configured base URL)
2. `model` in `~/.pi/agent/ocr/config.json`
3. the **session's current model**, if it declares image input and speaks an
   OpenAI-compatible API (auth resolved through pi's model registry)
4. `defaultVisionModel` in config (default: `qwen3.8-flash` @ the local oMLX)
5. clear error pointing at `/ocr`

### Verdicts (metadata, never a rewrite of the text)

- `ok` — all pages extracted, no `[ILEGÍVEL]`/`[ILLEGIBLE]` markers, validators pass
- `review` — illegible markers present, or a validator found fewer matches than expected
- `failed` — a page failed after the dpi retry ladder (200 → 300 dpi)

Validators are named regexes in config (`validators: { cpf: { pattern: "…", min: 1 } }`);
a validator passes when the pattern is **absent** from the text, or present and
matching at least `min` times. Mismatches downgrade the verdict only.

### Sidecar — `pi-ocr/v1`

`<name>.ocr.json` beside the source: `{ schema, generatedAt, source:
"text-layer"|"vision", model, baseUrl, dpi, truncated, verdict, text, pages:
[{ n, status, bytes, latencyMs, dpi, chars, illegibleCount, attempts? }],
validators? }`. Existing sidecars are skipped unless `force`. Above the
context guard (100k chars default) or when `maxPages` truncates, the tool
returns metadata only — page through the sidecar with `read`.

## Configuration

The config file is `<agent dir>/ocr/config.json`. The agent dir comes from
`getAgentDir()` (normally `~/.pi/agent`). `/ocr paths` prints the exact path.
You can edit the values in the panel.

Keys: `baseUrl`, `model`, `apiKey`, `defaultVisionModel`, `timeoutMs`, `dpi`
(200), `dpiRetry` (300), `maxTokens` (4096), `maxPages` (200), `maxBytes`,
`contextGuardChars` (100000), `textLayerMinChars` (50), `autoDetect` (false),
`force`, `keepRenders`, `prompt`, `validators`.

## Development

```bash
npm install
npm run typecheck
npm test
npm pack --dry-run
```

`npm test` runs `tests/run.mjs`. Each test file runs in its own process with
a temporary `HOME`, so no test can change the live Pi settings. The tests
cover the domain, the pipeline (fake exec and fetch), the adapter, the panel
contract and the packed file list.

The generic UI parts (`SettingsPanel`, `JsonStore`, `extensionVersion`) come
from `@maheidem/pi-panel-kit`.

## License

MIT
