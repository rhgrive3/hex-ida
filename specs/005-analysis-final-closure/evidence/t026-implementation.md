# T026 implementation closure

This packet records implementation completion under the user-authorized
development-speed amendment. It does not certify P-COMPETITIVE release
measurement or threshold acceptance.

The current competitive implementation at `8e045342d` has the required
identity-bound path:

- `tools/validation/competitive/measurements.mjs` collects P5/P6, native P8,
  benchmark, and source-fixture records into one `measurements.json` while
  preserving the frozen denominator and explicit `UNMEASURED` outcomes.
- `tools/validation/competitive/score.mjs` validates current producer
  git/tree identity, capture replay, metric keys, and canonical profile data;
  `--from-measurements` promotes only validated rows.
- `tools/validation/competitive/workload-twins.mjs` keeps missing or
  unproven BattleCats/TsumTsum/YWP fixture identity fail-closed.

Current Node 22 focused evidence on this source snapshot:

- `tests/competitive/repository-scorecard.test.mjs`: 3/3 PASS, covering the
  ten-row denominator, CLI import, stale producer identity, capture mutation,
  and wrong metric-key rejection.
- `tests/competitive/workload-twins.test.mjs` plus
  `tests/competitive/benchmark-measurements.test.mjs`: 13/13 PASS, including
  explicit missing-fixture `UNMEASURED` behavior and per-fixture work limits.

Retained native adapter (6/6) and source-fixture (3/3) logs remain historical
supporting evidence at
`.dev-state/hex-development-batch/native-arm64-adapter-db32.log` and
`.dev-state/hex-development-batch/t026-arm64-run-632f7d231/source-fixture-test.log`.
Their producer packets are not relabeled as current-head evidence. The current
canonical `npm run check` emits no competitive measurement packet, so fresh
current-head producers remain a release task.

The remaining debt is preserved under T040/T042: current-head P5/P6/native-P8
observations, external game source/compiler/debug identities, and the frozen
P-COMPETITIVE thresholds. No row is promoted from missing or stale evidence.
