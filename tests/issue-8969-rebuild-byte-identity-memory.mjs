// Issue #8969 regression: rebuild source/output identity used the generic
// structured-value digest `stableDigest(Array.from(bytes))`, boxing the entire
// binary into a number array + intermediate jsonSafe copy + decimal JSON string,
// so a valid-size 8 MiB source OOMed a 128 MiB worker before any budget or
// fail-closed result could be produced. The fix routes byte identity through the
// memory-bounded `stableDigestBytes` helper while preserving the exact content
// complete identity contract.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRebuildPlan, materializeRebuildPlan } from '../js/rebuild/index.js';
import { stableDigest } from '../js/core/identity/index.js';

// (A) Content-complete identity contract is preserved exactly: the production
// source identity must still equal the documented stableDigest(Array.from(bytes))
// value for a real buffer, so stored plan/source hashes keep validating.
{
  const n = 64 * 1024;
  const src = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) src[i] = (i * 31 + 7) & 0xff;
  const plan = createRebuildPlan({
    binaryId: 'b',
    sourceHash: 'bytes:probe',
    operations: [{ offset: 0, before: new Uint8Array([src[0]]), after: new Uint8Array([(src[0] + 1) & 0xff]) }],
  });
  const rejected = await materializeRebuildPlan(plan, src, { allowSourceHashMismatch: false });
  assert.equal(rejected.reason, 'source-identity-mismatch');
  assert.equal(rejected.observed, `bytes:${stableDigest(Array.from(src))}`,
    'byte-native identity must reproduce the exact legacy source identity');
}

// (B) A valid-size 8 MiB source must fail closed and materialize under a
// constrained worker heap instead of process-OOMing. Spawned as a child so the
// V8 heap limit applies to the production hashing path in isolation.
{
  const child = fileURLToPath(new URL('./phase12/rebuild/fixtures/issue-8969-large-identity-repro.mjs', import.meta.url));
  let stdout = '';
  try {
    stdout = execFileSync(process.execPath, ['--max-old-space-size=96', child], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120000,
    });
  } catch (error) {
    const crashed = error.status === 134 || error.signal === 'SIGABRT';
    assert.fail(`#8969: large rebuild identity must return a bounded result under a 96 MiB heap, `
      + `but the child ${crashed ? 'process-OOMed (exit 134)' : `failed (status ${error.status})`}: ${(error.stdout || error.message || '')}`);
  }
  assert.match(stdout, /OK_REJECTED/, 'stale source hash must be rejected without OOM');
  assert.match(stdout, /OK_MATERIALIZED/, 'valid one-byte rebuild must materialize without OOM');
}

console.log('issue #8969 rebuild byte-native identity memory regressions: PASS');
