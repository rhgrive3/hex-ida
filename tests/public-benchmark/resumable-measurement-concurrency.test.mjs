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


test('stale writer locks are never stolen automatically', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-resumable-stale-lock-'));
  const storeDir = path.join(root, 'run');
  fs.mkdirSync(storeDir, { recursive:true });
  const lockFile = path.join(storeDir, '.writer.lock');
  fs.writeFileSync(lockFile, JSON.stringify({ pid: 1, createdAt: 'old' }));
  const old = new Date(Date.now() - 7 * 60 * 60 * 1000);
  fs.utimesSync(lockFile, old, old);
  const manifest = { schema: 'test-manifest/v1', cases: [{ id: 'case-a' }] };

  await assert.rejects(
    measureCases({ storeDir, manifest, headSha: HEAD, runCase: async () => ({ state: 'PASS' }) }),
    /measurement-writer-stale-lock/,
  );
  assert.equal(fs.existsSync(lockFile), true, 'stale lock must remain for explicit operator recovery');
});
