// These contracts intentionally communicate through in-process Phase 3 evidence.
// Keep the exact producer/consumer order from the historical serial runner while
// independent semantic-v2 tests execute in isolated workers.
await import('./integration-current-corpus.test.mjs');
await import('./integration-final-evidence.test.mjs');
await import('./integration-memory.test.mjs');
await import('./integration-release-report.test.mjs');
await import('./integration-zz-current-corpus-gate.test.mjs');
