# Quickstart

```sh
node --test tests/machine-effects/evidence-breadth-counterexamples.test.mjs
node --test tests/machine-effects/formal-architectural-evidence.test.mjs
node --test tests/machine-effects/relaxed-memory-evidence.test.mjs
node --test tests/semantic-v2/undefined-result-transport.test.mjs
node --test tests/phase8/undefined-result-soundness.test.mjs
npm run effects:test
npm run semantic-v2:test
node scripts/run-quiet-command.mjs --label check -- npm run check
```

Expected: malformed/stale/partial cases have zero exact pass contribution; every mask is byte-identical after lowering; Phase 8 publishes no exact scalar for masked results; broad gates pass without denominator changes.
