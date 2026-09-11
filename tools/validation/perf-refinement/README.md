# Mobile-oriented refinement diagnostics

These scripts measure real functions imported from the selected source trees.
They do not modify the production configuration, coroutine budgets, corpus,
release gates, or the historical aggregate workload.

## Primary acceptance workload

Use `../aggregate-speed/run.mjs ROOT OUTPUT.json` from this tool directory.
The unchanged 13-stage workload includes module loading, 8 MiB file open,
resident/streaming hashing, fingerprinting, six searches, 135 corpus inputs with
optimization off and on, and 270-result export. It is not a browser UI benchmark.
Its baked-in historical source identifiers identify the original protocol, not a
newly supplied ROOT: the delivery measurement plan records actual archive and
product-file hashes. Include failures in the same order on both sides.

## Complementary isolated components

```
node tools/validation/perf-refinement/paired.mjs BASELINE_ROOT CANDIDATE_ROOT output.json
```

`cases.mjs` fixes cases and iteration counts. `paired.mjs` warms both sides and
alternates nine blocks per case in one process. Repeat in fresh processes and
reverse the root order to expose JIT and host-load sensitivity. Each pair must
produce matching observable output. These component medians are not added to the
primary aggregate nor averaged into a made-up overall speedup. Tiny operations
have measurable eligibility-check cost and high relative timing noise.

`micro.mjs` and `text-probe.mjs` are exploratory tools only. Rejected proposals
and diagnostic runs are kept separately from the frozen final campaign.

## Memory and correctness

Use `../mobile-balanced/retention.mjs` with `node --expose-gc` for three repeated
corpus cycles; the explicit collection is diagnostic only, not production logic.
RSS, retained JavaScript heap and logical cache payload limits are distinct.
A `--max-old-space-size=128` run does not emulate a phone or cap total process RAM.
Use `../aggregate-speed/capture.mjs` for independently normalized full-output
comparison, and run `npm run performance:test` for differential/edge tests.

No successful Node measurement proves WebKit, mobile-browser rendering, battery
use, build synchronization, deployment, or the absence of every possible leak.
