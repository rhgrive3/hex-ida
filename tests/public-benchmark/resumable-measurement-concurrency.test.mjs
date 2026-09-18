import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { measureCases } from '../../tools/validation/direct-recompilability/resumable-measurement.mjs';

const HEAD = 'a'.repeat(40);

test('concurrent resumptions fail closed instead of losing attempts', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-resumable-concurrency-'));
  const storeDir = path.join(root, 'run');
  const manifest = { schema: 'test-manifest/v1', cases: [{ id: 'case-a' }] };
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const first = measureCases({
    storeDir,
    manifest,
    headSha: HEAD,
    runCase: async () => { await gate; return { state: 'PASS' }; },
  });
  await new Promise(resolve => setTimeout(resolve, 10));
  await assert.rejects(
    measureCases({ storeDir, manifest, headSha: HEAD, runCase: async () => ({ state: 'PASS' }) }),
    /measurement-writer-busy/,
  );
  release();
  const summary = await first;
  assert.equal(summary.counts.PASS, 1);
});
