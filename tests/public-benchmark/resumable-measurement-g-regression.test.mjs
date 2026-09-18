import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildRetryManifest,
  formatSummaryLine,
  measureCases,
  readSummary,
} from '../../tools/validation/direct-recompilability/resumable-measurement.mjs';

const HEAD = 'a'.repeat(40);
const manifest = { schema: 'hex-g-test-manifest/v1', cases: [{ id: 'case-a' }, { id: 'case-b' }, { id: 'case-c' }] };

function store() { return fs.mkdtempSync(path.join(os.tmpdir(), 'hex-g-regression-')); }

test('TIMEOUT stays in the full denominator and incomplete stays fail-closed', async () => {
  const dir = store();
  const first = await measureCases({
    storeDir: dir,
    manifest,
    headSha: HEAD,
    runCase: async ({ id }) => id === 'case-a' ? { state: 'PASS' } : { state: 'TIMEOUT', reason: 'subject-timeout' },
  });
  assert.equal(first.denominator, 3);
  assert.equal(first.counts.PASS, 1);
  assert.equal(first.counts.TIMEOUT, 2);
  assert.equal(first.complete, false);
  assert.match(formatSummaryLine(first), /^INCOMPLETE 1\/3 PASS/);
});

test('resume retries only TIMEOUT/NOT_RUN and does not double-count PASS', async () => {
  const dir = store();
  await measureCases({
    storeDir: dir,
    manifest,
    headSha: HEAD,
    runCase: async ({ id }) => id === 'case-a' ? { state: 'PASS' } : { state: 'TIMEOUT', reason: 'subject-timeout' },
  });
  const calls = [];
  const second = await measureCases({
    storeDir: dir,
    manifest,
    headSha: HEAD,
    runCase: async ({ id }) => { calls.push(id); return { state: 'PASS' }; },
  });
  assert.deepEqual(calls, ['case-b', 'case-c']);
  assert.equal(second.denominator, 3);
  assert.equal(second.counts.PASS, 3);
  assert.equal(second.complete, true);
  assert.equal(readSummary(dir).results.length, 3);
});

test('retry manifest preserves the denominator and only incomplete cases', async () => {
  const dir = store();
  await measureCases({
    storeDir: dir,
    manifest,
    headSha: HEAD,
    runCase: async ({ id }) => id === 'case-a' ? { state: 'PASS' } : { state: 'TIMEOUT', reason: 'subject-timeout' },
  });
  const retry = buildRetryManifest({ storeDir: dir, manifest, headSha: HEAD });
  assert.equal(retry.denominator, 3);
  assert.deepEqual(retry.cases.map(({ id }) => id), ['case-b', 'case-c']);
});
