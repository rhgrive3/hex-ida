import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CASE_SCHEMA,
  DEFAULT_RETRY_STATES,
  RETRY_SCHEMA,
  RUN_SCHEMA,
  SUMMARY_SCHEMA,
  buildRetryManifest,
  formatSummaryLine,
  hashManifest,
  measureCases,
  openRun,
  readSummary,
} from '../../tools/validation/direct-recompilability/resumable-measurement.mjs';

const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);

function manifest(ids = ['case-a', 'case-b', 'case-c', 'case-d']) {
  return { schema: 'test-manifest/v1', cases: ids.map(id => ({ id })) };
}

function store() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hex-resumable-measurement-'));
}

function readCase(storeDir, id) {
  const hex = Buffer.from(id).toString('hex');
  return JSON.parse(fs.readFileSync(path.join(storeDir, 'cases', `${hex}.json`), 'utf8'));
}

function runnerFrom(plan, calls = []) {
  return async (entry) => {
    calls.push(entry.id);
    const behavior = plan[entry.id] ?? { state: 'PASS' };
    if (behavior.throw) throw new Error(behavior.throw);
    return { state: behavior.state, reason: behavior.reason ?? null, functions: behavior.functions ?? null };
  };
}

test('1: timeout mid-run preserves earlier completed results on disk', async () => {
  const dir = store();
  const calls = [];
  const runCase = runnerFrom({
    'case-a': { state: 'PASS' },
    'case-b': { state: 'PASS' },
    'case-c': { state: 'TIMEOUT', reason: 'subject-timeout' },
    'case-d': { throw: 'SIGKILL-simulated' },
  }, calls);
  const summary = await measureCases({ storeDir: dir, manifest: manifest(), runCase, headSha: HEAD_A });
  assert.deepEqual(calls, ['case-a', 'case-b', 'case-c', 'case-d']);
  assert.equal(readCase(dir, 'case-a').state, 'PASS');
  assert.equal(readCase(dir, 'case-b').state, 'PASS');
  assert.equal(readCase(dir, 'case-c').state, 'TIMEOUT');
  assert.equal(readCase(dir, 'case-d').state, 'CRASH');
  assert.match(readCase(dir, 'case-d').reason, /runner-throw/);
  assert.equal(readCase(dir, 'case-a').schema, CASE_SCHEMA);
  assert.equal(summary.denominator, 4);
  assert.equal(summary.complete, false);
});

test('2: resume re-executes only NOT_RUN and TIMEOUT cases', async () => {
  const dir = store();
  await measureCases({
    storeDir: dir,
    manifest: manifest(),
    runCase: runnerFrom({
      'case-a': { state: 'PASS' },
      'case-b': { state: 'FAIL', reason: 'link-failed' },
      'case-c': { state: 'TIMEOUT' },
      'case-d': { state: 'NOT_RUN', reason: 'input-not-ready:test-fixture' },
    }),
    headSha: HEAD_A,
  });
  const before = readCase(dir, 'case-a');
  const calls = [];
  const summary = await measureCases({
    storeDir: dir,
    manifest: manifest(),
    runCase: runnerFrom({ 'case-c': { state: 'PASS' } }, calls),
    headSha: HEAD_A,
  });
  // case-d had no record (NOT_RUN) so it runs too; a/b are terminal and skipped.
  assert.deepEqual(calls, ['case-c', 'case-d']);
  assert.equal(readCase(dir, 'case-a').attempts.length, before.attempts.length);
  assert.equal(readCase(dir, 'case-b').state, 'FAIL');
  assert.equal(readCase(dir, 'case-c').attempts.length, 2);
  assert.equal(readCase(dir, 'case-c').state, 'PASS');
  assert.equal(summary.counts.PASS, 3);
  assert.equal(summary.counts.FAIL, 1);
});

test('3: TIMEOUT is never counted as PASS and incomplete runs stay incomplete', async () => {
  const dir = store();
  const summary = await measureCases({
    storeDir: dir,
    manifest: manifest(['case-a', 'case-b']),
    runCase: runnerFrom({ 'case-a': { state: 'PASS' }, 'case-b': { state: 'TIMEOUT' } }),
    headSha: HEAD_A,
  });
  assert.equal(summary.counts.PASS, 1);
  assert.equal(summary.counts.TIMEOUT, 1);
  assert.equal(summary.complete, false);
  assert.match(formatSummaryLine(summary), /^INCOMPLETE 1\/2 PASS/);
  const done = await measureCases({
    storeDir: dir,
    manifest: manifest(['case-a', 'case-b']),
    runCase: runnerFrom({ 'case-b': { state: 'PASS' } }),
    headSha: HEAD_A,
  });
  assert.equal(done.complete, true);
  assert.match(formatSummaryLine(done), /^COMPLETE 2\/2 PASS/);
});

test('4: duplicate retry execution cannot double-count', async () => {
  const dir = store();
  const m = manifest(['case-a', 'case-b']);
  const calls = [];
  await measureCases({
    storeDir: dir, manifest: m, headSha: HEAD_A,
    runCase: runnerFrom({ 'case-a': { state: 'PASS' }, 'case-b': { state: 'TIMEOUT' } }, calls),
  });
  const retry = buildRetryManifest({ storeDir: dir, manifest: m, headSha: HEAD_A });
  assert.equal(retry.schema, RETRY_SCHEMA);
  assert.deepEqual(retry.cases.map(entry => entry.id), ['case-b']);
  assert.equal(retry.denominator, 2);
  const retryCases = m.cases.filter(entry => retry.cases.some(row => row.id === entry.id));
  const first = await measureCases({
    storeDir: dir, manifest: m, headSha: HEAD_A,
    cases: [...retryCases, ...retryCases],
    runCase: runnerFrom({ 'case-b': { state: 'FAIL', reason: 'syntax-failed' } }, calls),
  });
  const second = await measureCases({
    storeDir: dir, manifest: m, headSha: HEAD_A,
    cases: retryCases,
    runCase: runnerFrom({ 'case-b': { state: 'FAIL', reason: 'syntax-failed' } }, calls),
  });
  assert.deepEqual(first.counts, second.counts);
  assert.equal(second.counts.PASS, 1);
  assert.equal(second.counts.FAIL, 1);
  assert.equal(readSummary(dir).results.filter(row => row.id === 'case-b').length, 1);
  // Second pass found FAIL terminal, so the runner saw case-b only once total across retries.
  assert.deepEqual(calls.filter(id => id === 'case-b'), ['case-b', 'case-b']);
});

test('5: summary denominator always covers the full manifest', async () => {
  const dir = store();
  const m = manifest();
  const summary = await measureCases({
    storeDir: dir, manifest: m, headSha: HEAD_A,
    cases: m.cases.slice(0, 1),
    runCase: runnerFrom({ 'case-a': { state: 'PASS' } }),
  });
  assert.equal(summary.denominator, 4);
  assert.equal(summary.counts.PASS, 1);
  assert.equal(summary.counts.NOT_RUN, 3);
  assert.equal(summary.results.length, 4);
  assert.equal(summary.complete, false);
  const missing = summary.results.filter(row => row.state === 'NOT_RUN');
  assert.equal(missing.length, 3);
});

test('6: HEAD or manifest mismatch is rejected without mixing results', async () => {
  const dir = store();
  const m = manifest(['case-a']);
  await measureCases({
    storeDir: dir, manifest: m, headSha: HEAD_A,
    runCase: runnerFrom({ 'case-a': { state: 'PASS' } }),
  });
  await assert.rejects(
    measureCases({ storeDir: dir, manifest: m, headSha: HEAD_B, runCase: runnerFrom({}) }),
    /measurement-identity-mismatch/,
  );
  const drifted = manifest(['case-a', 'case-b']);
  assert.notEqual(hashManifest(m), hashManifest(drifted));
  await assert.rejects(
    measureCases({ storeDir: dir, manifest: drifted, headSha: HEAD_A, runCase: runnerFrom({}) }),
    /measurement-identity-mismatch/,
  );
  // Existing durable results are untouched by the rejected attempts.
  assert.equal(readCase(dir, 'case-a').state, 'PASS');
  assert.throws(() => openRun({ storeDir: dir, manifest: drifted, headSha: HEAD_A }), /measurement-identity-mismatch/);
});

test('function-level progress is preserved per case', async () => {
  const dir = store();
  await measureCases({
    storeDir: dir,
    manifest: manifest(['case-a']),
    headSha: HEAD_A,
    runCase: runnerFrom({
      'case-a': { state: 'PASS', functions: { total: 12, states: { PASS: 10, UNSUPPORTED: 2 } } },
    }),
  });
  assert.deepEqual(readCase(dir, 'case-a').functions, { total: 12, states: { PASS: 10, UNSUPPORTED: 2 }, extra: null });
});

test('runner defects fail closed instead of corrupting the run', async () => {
  const dir = store();
  const summary = await measureCases({
    storeDir: dir,
    manifest: manifest(['case-a', 'case-b', 'case-c']),
    headSha: HEAD_A,
    runCase: async (entry) => {
      if (entry.id === 'case-a') return { state: 'BOGUS' };
      if (entry.id === 'case-b') return { state: 'NOT_RUN', reason: 'runner-gave-up' };
      return null;
    },
  });
  assert.equal(readCase(dir, 'case-a').state, 'FAIL');
  assert.equal(readCase(dir, 'case-a').reason, 'invalid-runner-verdict');
  assert.equal(readCase(dir, 'case-b').state, 'FAIL');
  assert.equal(readCase(dir, 'case-c').state, 'FAIL');
  assert.equal(summary.counts.FAIL, 3);
});

test('run header pins HEAD and manifest hash with versioned schemas', async () => {
  const dir = store();
  const m = manifest(['case-a']);
  const run = openRun({ storeDir: dir, manifest: m, headSha: HEAD_A });
  assert.equal(run.schema, RUN_SCHEMA);
  assert.equal(run.headSha, HEAD_A);
  assert.equal(run.manifestSha256, hashManifest(m));
  assert.equal(run.denominator, 1);
  assert.deepEqual(DEFAULT_RETRY_STATES, ['NOT_RUN', 'TIMEOUT']);
  assert.match(RUN_SCHEMA, /\/v1$/);
  assert.match(SUMMARY_SCHEMA, /\/v1$/);
});
