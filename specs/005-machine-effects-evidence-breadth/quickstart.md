# Quickstart

```sh
node --test tests/machine-effects/formal-architectural-evidence.test.mjs
node --test tests/machine-effects/relaxed-memory-evidence.test.mjs
node --test tests/machine-effects/undefined-result-contract.test.mjs
node --test tests/machine-effects/x86-bit-scan-undefined-result.test.mjs
node --test tests/semantic-v2/undefined-result-transport.test.mjs
node --test tests/phase8/scalar/undefined-result-soundness.test.mjs
npm run phase8:test -- --group scalar
npm run effects:test
node scripts/run-quiet-command.mjs --label check -- npm run check
```

Expected for the clean Phase 2 lane: malformed/stale/partial cases have zero exact pass contribution; canonical undefined masks validate and serialize exactly; broad gates do not change the locked denominator.

Each canonical undefined-result class survives Semantic IR v2 and both v1 compatibility paths without a concrete value. SCCP publishes no constant and a full range, malformed descriptors fail closed, and descriptor-free exact arithmetic still folds normally. A partial input bundle remains partial. Real Capstone-decoded BSF/BSR register and memory forms establish the x86 producer boundary; unsupported or inconsistent forms remain partial.

External formal-evidence regeneration, candidate-tree validation, exact-head CI, and live-main verification remain release exit criteria. Local checked-in fixture validation is not relabeled as current QEMU/Isla/Sail/herd execution.
