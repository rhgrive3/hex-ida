# Test fixtures

Small synthetic and domain fixtures are tracked directly under `tests/fixtures/`. Large real-world application binaries used for heavyweight accuracy and oracle checks are intentionally **not tracked by Git** and are fetched on demand.

## Real binary fixtures

Two manifests pin the real binary fixtures (including `TsumTsum` mapped to `bainary-test` (12.12.0)):

### 1. Environment-URL manifest (`tests/fixtures/real-binaries.json`)

Used by `scripts/fetch-real-fixtures.mjs` to install verified binaries under `tests/.real-fixtures/` (Git-ignored). Download URLs are supplied at runtime via HTTPS environment variables so repository source never embeds expiring or private links:

| Fixture | Target file (`tests/.real-fixtures/`) | Size (bytes) | SHA-256 | URL env var |
| --- | --- | ---: | --- | --- |
| `battlecats` | `battlecats` | `28153072` | `567234909b2a33d62548257c4148290d9215d7edf414fa17c6b06fcf8c7cdf13` | `HEX_FIXTURE_BATTLECATS_URL` |
| `TsumTsum` (12.12.0) | `bainary-test` | `46402912` | `b722a2a9c5162eb1a9972e8636ea94f00ba7cb5674c3352ab3247a2ec79431b8` | `HEX_FIXTURE_TSUMTSUM_URL` |
| `YWP` | `YWP` | `63455952` | `cd1c72a30ba29f423a670f9e534c8865689ca09890769a95822869c162d240a6` | `HEX_FIXTURE_YWP_URL` |

Commands:

```sh
npm run fixtures:fetch                          # fetch and verify all fixtures into tests/.real-fixtures/
node scripts/fetch-real-fixtures.mjs battlecats # fetch a single fixture
npm run fixtures:check                          # verify already-downloaded fixtures offline
```

`scripts/fetch-real-fixtures.mjs` rejects non-HTTPS URLs, enforces a 120s download timeout, and verifies exact byte size and SHA-256 digest before atomically installing each file.

### 2. Large-fixture release manifest (`tests/large-fixtures.json`)

Used by `tools/fetch-large-fixtures.mjs` (`npm run fixtures:large`), which verifies exact byte size and Git blob SHA-1 digests (`tests/battlecats`, `tests/bainary-test` from the `fixtures-bainary-test` release asset, and `tests/YWP`):

```sh
npm run fixtures:large
```

Placeholder pointer files at `tests/battlecats`, `tests/TsumTsum`, and `tests/YWP` are documentation stubs only—never pass placeholder files to `openBinary`. Heavyweight real-binary tests are opt-in and should not run on ordinary pull-request CI without explicit fixture provisioning.

## Tracked fixtures in this directory

- `real-binaries.json` — pinned SHA-256 manifest for real binary fixtures.
- `cxx-dwarf-holdout/` — stripped ARM64 C++ ELF fixture (`holdout.stripped.elf`) with source (`holdout.cpp`, `abi-stubs.s`) and DWARF layout truth.
- `module-boundaries/` — fixture files for module-boundary validation tests.
- `pinpoint-confidence-queries.json` / `pinpoint-false-likely-dsda.json` — pinpoint confidence calibration and regression fixtures.
- `chatgpt-bridge-entry.js` / `chatgpt-production-dom.mjs` — ChatGPT web bridge and DOM harness fixtures.
