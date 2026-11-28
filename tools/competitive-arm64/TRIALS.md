# Bounded T0–T3 trial execution (experimental, opt-in)

This directory contains executable source for bounded T0–T3 competitive ARM64 trial planning and execution (`trials.mjs`, `trial-worker.mjs`, `manifest.mjs`, `source-oracle.mjs`). It is not a published benchmark result: importing it does not load providers, call models, or enable a default rollout. Supplied synthetic fixtures are not real competitor measurements, and all release/default-rollout/victory flags remain `false`.

## Commands

```sh
npm run scpa:manifest   # node tools/competitive-arm64/manifest.mjs
npm run scpa:test       # node tests/scpa/run.mjs
npm run scpa:coverage   # node tests/scpa/coverage.mjs
```

Plan-only and bounded local host execution (with optional persisted continuation via `--resume`):

```sh
node tools/competitive-arm64/trials.mjs --plan input.json --out plan.json

node tools/competitive-arm64/trials.mjs --run input.json --host ./host.mjs \
  --timeout-ms 30000 --maximum-trials 64 --out batch-01.json

node tools/competitive-arm64/trials.mjs --run input.json --host ./host.mjs \
  --resume batch-01.json --timeout-ms 30000 --maximum-trials 256 --out batch-02.json
```

## Input plan and host contract

- **Input JSON (`input.json`)**: must contain exactly `protocols` and `config`. `protocols` holds raw competitive-protocol definitions for `T0` (`scripted-substrate`), `T1`/`T3` (`native-best`), and `T2` (`knowledge-equalized`), each validated by `createCompetitiveProtocol`. `config` supplies `seed`, `cacheStates`, one `tasks` entry per case, and `resources` (`deadlineMs`, `cleanupMs`). No tasks are inferred from an incomplete file. See `tests/scpa/benchmark-fixture.mjs` for a synthetic example and `tests/scpa/trial-cli.test.mjs` for the CLI plan-file contract.
- **Host module (`--host host.mjs`)**: must export `createTrialHost({ plan, protocols, signal })` returning `{ getAdapter, adjudicate? }`. `getAdapter(binding, context)` returns the native-adapter wrapper plus preparation, currentness, and cleanup callbacks. Adapters are never auto-discovered or downloaded; any external model or competitor requires separately supplied, authorized local host integration.
- **Worker isolation limits**: host JavaScript runs in a terminateable worker (`trial-worker.mjs`: 256 MiB old generation, 32 MiB young generation, 4 MiB stack) with parent wall-deadline enforcement and a 32 KiB host-log cap (raw logs are discarded rather than copied into reports). This is **not a security sandbox**, OS process-tree killer, or remote-job cancellation guarantee—hosts are trusted local code and must bound and clean up their own subprocesses, network traffic, and external costs.

## Resource caps and file safety

- **Plan cap**: 4,096 cells max; input source files up to 1 MiB.
- **Per-invocation execution cap**: 1–256 cells (`--maximum-trials`, default 64); cells beyond the cap remain `UNMEASURED` rather than omitted.
- **Worker wall timeout**: 100–120,000 ms (`--timeout-ms`, default 30,000).
- **Saved report / worker message / expansion cap**: 8 MiB.
- **Output safety**: output files are created exclusively with mode `0600`; existing output, input, host, and resume files are never overwritten. Use a new `--out` path for each resumed batch. Inputs, host modules, and checkpoints must be bounded regular files (FIFOs are rejected without blocking).

## Continuation and wire/JavaScript interfaces

- A successful `--run` invocation returns `status: "executed-not-admitted"` (not product or experiment acceptance). Inspect `result.progress.nextOrdinal` against `result.denominator`; `review.verdict` remains `NOT-YET`, and release/default-rollout/victory flags remain `false`.
- Each consumed cell (including failed or unavailable cells) stays consumed across batches; automatic retry is intentionally absent.
- The CLI emits compact JSON with schema `same-astra-trial-results-compact/v1`, omitting only fields bound by the exact plan while preserving statuses, observations, cleanup failures, and measurement references.
- The JavaScript API `executeAstraTrialFile` returns expanded `same-astra-trial-results/v1` by default (`compactResult: true` requests the compact wire form). Core callers can persist and resume via `runAstraTrials`, `packAstraTrialContinuation(plan, result)`, and `validateAstraTrialContinuation(plan, protocols, raw)` using plans created by `createAstraTrialPlan`.

## Governance and admission boundaries

- Missing adapters stay `UNAVAILABLE`. Completed raw answers stay `UNMEASURED` until independently adjudicated; a host adjudicator produces measurement **candidates** only.
- T2 knowledge-policy mismatches invalidate the paired group (and retract earlier affected candidates across resumed batches). Failed cleanup invalidates the cell and removes its candidates. Parent cancellation and stale owners reject late publication.
- Progress digests detect accidental transport corruption; they are not cryptographic signatures. Entry-module SHA-256 binds only the root host file, not transitive imports or remote services.
- `reviewAstraTrialReadiness` evaluates branded in-process plans/results and preserves independent oracle, device, statistical, and human-adjudication vetoes. Passing synthetic scale/continuation tests does not satisfy external admission gates.

## Related SCPA core interfaces

- **Knowledge**: `recognizeScoped` supports single-use scope/revision-bound page continuation and opt-in `retrieval: 'indexed'`, rereading selected primary records and invalidating on database revision. Approximate candidate cuts never establish an exhaustive reference universe or exact identity.
- **Investigation**: host-bound fixed success contracts and budget/cost samples qualify only the read-only frontier; missing/new obligations and cycles keep a task unresolved.
- **Certificates**: optional `encoding: 'shared-dag-v1'` for certificate exports (raw canonical encoding remains the default); `replayProof` restores the full certificate and invokes existing replay checks without discarding contradictions, premises, unknowns, or explanation paths.
- **Swift metadata**: generic declarations come only from the private current metadata-owner hook. Cycles, ambiguities, resilient/conditional conformances, and unsupported dependent members remain `UNKNOWN`.
