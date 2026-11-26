# Changelog

## [0.2.0]

- Move to the shared pi extension standard. The tool, the `/ocr` command, its verbs and the config file do not change.
- Import the UI parts (`SettingsPanel`, `JsonStore`, `extensionVersion`) from `@maheidem/pi-panel-kit`. Remove the local copies.
- Run the tests with `tests/run.mjs` (`runTests` of the kit). Remove `tsx`.
- Pin the dev host packages to pi 1.6.1. Add `CHANGELOG.md` to the package.
- Order the README sections: Install, Usage, Configuration, Development, License.
