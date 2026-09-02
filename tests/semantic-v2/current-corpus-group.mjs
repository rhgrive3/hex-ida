// These contracts intentionally communicate through in-process Phase 3 evidence.
// Keep the exact producer/consumer order from the historical serial runner while
// independent semantic-v2 tests execute in isolated workers.
import { resolvePhase3DualMode } from '../support/phase3-dual-mode.mjs';

const dualMode = resolvePhase3DualMode();
const previousReuseToken = process.env.HEX_PHASE3_INPROCESS_REUSE_TOKEN;
const previousCorpusConcurrency = process.env.HEX_PHASE3_CORPUS_CONCURRENCY;

if (dualMode.enabled) {
  process.env.HEX_PHASE3_INPROCESS_REUSE_TOKEN = `phase3-dual-${process.pid}`;
  process.env.HEX_PHASE3_CORPUS_CONCURRENCY = String(dualMode.perCorpusConcurrency);
  try {
    // Both modes execute the exact same locked 25-command denominator in isolated
    // child processes. Start the independent legacy proof beside the v2 producer;
    // final evidence later reuses that exact in-process result via the explicit
    // token instead of launching a second legacy corpus.
    await Promise.all([
      import('./legacy-corpus-prewarm.mjs'),
      import('./integration-current-corpus.test.mjs'),
    ]);
    await import('./integration-final-evidence.test.mjs');
  } finally {
    if (previousReuseToken == null) delete process.env.HEX_PHASE3_INPROCESS_REUSE_TOKEN;
    else process.env.HEX_PHASE3_INPROCESS_REUSE_TOKEN = previousReuseToken;
    if (previousCorpusConcurrency == null) delete process.env.HEX_PHASE3_CORPUS_CONCURRENCY;
    else process.env.HEX_PHASE3_CORPUS_CONCURRENCY = previousCorpusConcurrency;
  }
} else {
  await import('./integration-current-corpus.test.mjs');
  await import('./integration-final-evidence.test.mjs');
}

await import('./integration-memory.test.mjs');
await import('./integration-release-report.test.mjs');
await import('./integration-zz-current-corpus-gate.test.mjs');
