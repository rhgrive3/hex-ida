# OpenJev Advisory & Boundary Referee Architecture

Last updated: 2026-11-28

## Overview

OpenJev integration in Hex is strictly an **optional, non-authoritative ranking/retrieval advisory layer** — never a proof source, evidence producer, verdict authority, or replacement analysis engine. All binary facts, field offsets, types, proofs, and verdicts remain exclusively binary-grounded in Hex's deterministic analysis pipeline.

## Implemented Architecture

### 1. Client Advisory & Release Function Recovery

- **`js/analysis/query/jev-advisory.js`**: Pure projection and client for interactive partial-query C++ member/object candidate ranking (`adviseWithJev`, `rerankWithJev` wired via `js/pinpoint.js`).
  - Sends only bounded, binary-derived anonymous candidate descriptions and user phrase (`model: 'openjev'`, `choice` contract over opaque candidate IDs `c0`, `c1`, ...). Never sends raw binaries, assembly, pseudocode, or unbranded oracle objects.
  - Enforces a `512 KiB` response size cap (`JEV_MAX_RESPONSE_BYTES`) and an in-session LRU cache (`JEV_CACHE_MAX = 64`).
  - Endpoint resolution (`resolveJevEndpoint`): uses explicit `baseUrl` if configured, falls back to `${__HEX_RUNTIME_ORIGIN__}/api/jev/systemone` under opaque sandbox origins, or defaults to `https://api.openjev.sh/v1/systemone`.
- **`js/analysis/query/jev-recovery.js`**: Semantic retrieval over already-proven release function identities (`createJevRecoveryClient`, `queryKind: 'release-function-retrieval'`).
  - Remote choices may direct existing Fast analysis probes; they cannot prove a field or owner.
  - Enforces `512 KiB` bounded JSON reading (`JEV_RECOVERY_MAX_RESPONSE_BYTES`), currentness checks (`options.isCurrent() === true`), abort signal checks, and strict `payload?.model === 'openjev'` validation.

### 2. Worker Proxy & Network Boundary

- **`worker-entry.js`**: Exposes `/api/jev/systemone` (`handleOpenJevSystemOne`), forwarding validated JSON POST bodies (`<= 512 KiB`, returning `413 payload_too_large` above the cap) to `https://api.openjev.sh/v1/systemone` with CORS and security headers.
- **`js/userscript/network.js`**: Restricts external runtime origins via `ALLOWED_EXTERNAL_ORIGINS` (`https://api.openjev.sh`).

## Core Invariants & Failure Semantics

1. **No Proof or Verdict Authority**: OpenJev preferences never create binary evidence, never promote a candidate to `LIKELY` or `CONFIRMED` on their own, and never override deterministic proof/verdict semantics.
2. **Bounded Binary-Grounded Verification**: Any candidate prioritized or rescued by OpenJev must still pass existing binary-grounded verification (`program.functionRange()`, `analyze()`, `describePurpose()`, `changeAt()`).
3. **Fail-Closed Deterministic Fallback**: Any missing API key, network error, timeout, HTTP error (`401`/`403`/`429`/`5xx`), oversized payload, malformed JSON, unexpected `model`, invalid candidate ID, stale context (`isCurrent() !== true`), or aborted `signal` falls back cleanly to the deterministic local result without failing Hex analysis.
4. **Zero Impact When Unconfigured**: When no OpenJev client/key is supplied, Hex executes its deterministic pipeline unchanged.

## Verification

- `node --test tests/jev-realgame-holdout.test.mjs tests/jev-realgame-final.test.mjs tests/pinpoint-jev-shortlist.test.mjs`
- `node tests/pinpoint-jev-eligibility.mjs`
- `node tests/pinpoint-jev-probe-audit.mjs`
- `node jev-context/tests/run.mjs`
