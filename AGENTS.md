# AGENTS.md — @maheidem/pi-ocr

This repo is the pi extension "OCR". Its command is `/ocr` (see `extensions/metadata.ts`). Its tool is `ocr`.
It follows the pi extension standard of the `pi-extension-builder` skill.

## What the extension does

- The `ocr` tool reads PDFs and images (PNG/JPG/WebP/BMP/TIFF) through an OpenAI-compatible vision endpoint.
- A PDF with a real text layer goes through `pdftotext`. The other PDFs are split into pages with `pdftoppm`.
- The tool returns the RAW text and a metadata block (verdict `ok|review|failed`, `[ILEGÍVEL]` count, regex validators).
- The tool writes `<name>.ocr.json` (schema `pi-ocr/v1`) beside each file. It skips a file that has a sidecar, unless `force` is on. The dpi retry ladder is 200 → 300.
- Engine order: tool arg > config model > session model (image input and an OpenAI-completions API) > `defaultVisionModel`.
- The input hook is OFF by default.
- The config file is `getAgentDir()/ocr/config.json` (`CONFIG_PATH` in `extensions/config.ts`).
- `eng.traineddata` (5 MB) is tracked in git. No code uses it. It is not in the npm package. Keep it.

## Rules for a change

- Keep `extensions/index.ts` as wiring only. Put behaviour in `extensions/application.ts` and domain modules.
- Import UI parts from `@maheidem/pi-panel-kit`. Do not copy kit files into `extensions/ui/`.
- Get the config path from `getAgentDir()`. Export it as `CONFIG_PATH` from `extensions/config.ts`.
- Put all tests in `tests/`. `npm test` runs `tests/run.mjs` and never starts a live pi.
- Keep `.planning/` out of git.

## Release steps

1. Run `npm run typecheck` and `npm test`.
2. Run `npm version <minor|patch> --no-git-tag-version` and add a `## [x.y.z]` section to `CHANGELOG.md`.
3. Commit, then tag `vX.Y.Z`.
4. The owner pushes and runs `npm publish` with the OTP.
5. The owner runs `pi install npm:@maheidem/pi-ocr@<x.y.z>` and checks the version of the store copy.
