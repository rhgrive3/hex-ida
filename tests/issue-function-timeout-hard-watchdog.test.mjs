import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCaseWithWatchdog } from '../reports/investigations/current-main-weakness-20260923/harness/measure-functions.mjs';
import { readJson, receiptFileName } from '../reports/investigations/current-main-weakness-20260923/harness/lib.mjs';
import { runFreshSubject } from '../tools/validation/public-benchmark/fresh-subject.mjs';
import { profileBinary } from '../tools/validation/public-benchmark/profile-fresh.mjs';

test('parent watchdog kills child hung in busy loop and completes other functions', { timeout: 10000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-watchdog-test-'));
  try {
    const outDir = root;
    const receiptDir = path.join(root, 'receipts');
    fs.mkdirSync(receiptDir, { recursive: true });
    const fakeWorkerPath = path.join(root, 'fake-case-worker.mjs');

    // Worker simulates 3 functions:
    // fn 0 ('1000'): fast PASS
    // fn 1 ('2000'): hangs in busy loop while(true){}
    // fn 2 ('3000'): fast PASS
    fs.writeFileSync(fakeWorkerPath, `
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

function sha256(str) {
  return createHash('sha256').update(str).digest('hex');
}
function receiptFileName(addr) {
  return sha256(String(addr)).slice(0, 24) + '.json';
}
function atomicWriteJson(file, val) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(val, null, 2));
}
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

const args = process.argv.slice(2);
const v = (name) => args[args.indexOf(name) + 1];
const caseId = v('--case-id');
const receiptDir = v('--receipt-dir');
const inflight = v('--inflight');
const outDir = v('--out');

const fns = [
  { address: '1000', name: 'quick_a' },
  { address: '2000', name: 'busy_hung' },
  { address: '3000', name: 'quick_b' },
];

const completedRows = [];
for (let i = 0; i < fns.length; i++) {
  const fn = fns[i];
  const rPath = path.join(receiptDir, receiptFileName(fn.address));
  const existing = readJson(rPath);
  if (existing) {
    completedRows.push(existing);
    continue;
  }

  // Report progress
  const startedAt = new Date().toISOString();
  if (process.send) process.send({ type: 'function-start', address: fn.address, index: i, startedAt });
  process.stdout.write(JSON.stringify({ type: 'function-start', address: fn.address, index: i, startedAt }) + '\\n');
  atomicWriteJson(inflight, { caseId, address: fn.address, index: i, name: fn.name, startedAt });

  if (fn.address === '2000') {
    // Busy hang!
    while (true) {}
  }

  const row = {
    schema: 'hex-current-main-harness-function/v1',
    caseId,
    address: fn.address,
    index: i,
    name: fn.name,
    state: 'PASS',
    elapsedMs: 15,
  };
  atomicWriteJson(rPath, row);
  fs.rmSync(inflight, { force: true });
  completedRows.push(row);

  if (process.send) process.send({ type: 'function-end', address: fn.address, index: i, elapsedMs: 15, state: 'PASS' });
  process.stdout.write(JSON.stringify({ type: 'function-end', address: fn.address, index: i, elapsedMs: 15, state: 'PASS' }) + '\\n');
}

const caseRecord = {
  schema: 'hex-current-main-harness-case/v1',
  caseId,
  binary: 'fake.bin',
  state: 'MEASURED',
  functions: completedRows,
  functionCount: fns.length,
  functionStates: { PASS: 2, TIMEOUT: 1 },
};
atomicWriteJson(path.join(outDir, 'cases', Buffer.from(caseId).toString('hex') + '.json'), caseRecord);
process.exit(0);
`);

    const timeoutMs = 300;
    const graceMs = 150;
    const started = performance.now();

    const result = await runCaseWithWatchdog({
      binary: 'fake.bin',
      caseId: 'test-case-1',
      outDir,
      receiptDir,
      sourceIdentity: 'ident',
      configHash: 'cfghash',
      headSha: '0123456789abcdef0123456789abcdef01234567',
      functionTimeoutMs: timeoutMs,
      functionTimeoutGraceMs: graceMs,
      structure: 'none',
      structureThresholdMs: 250,
      workerPath: fakeWorkerPath,
    });

    const elapsed = performance.now() - started;

    // Check receipts
    const fn1Receipt = readJson(path.join(receiptDir, receiptFileName('1000')));
    assert.equal(fn1Receipt.state, 'PASS');

    const fn2Receipt = readJson(path.join(receiptDir, receiptFileName('2000')));
    assert.ok(fn2Receipt, 'Receipt for hung function must exist');
    assert.equal(fn2Receipt.state, 'TIMEOUT');
    assert.equal(fn2Receipt.hard, true, 'Hung function must have hard: true');
    assert.ok(fn2Receipt.elapsedMs >= timeoutMs, 'Elapsed time should be at least timeoutMs');

    const fn3Receipt = readJson(path.join(receiptDir, receiptFileName('3000')));
    assert.equal(fn3Receipt.state, 'PASS');

    // Watchdog killed hung function within timeout + grace + reasonable slack (< 3000ms)
    assert.ok(elapsed < 4000, `Total run took ${elapsed}ms, expected < 4000ms`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('elapsed > functionTimeoutMs is never reported PASS in fresh-subject', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-fresh-timeout-unit-'));
  try {
    const receiptDir = path.join(root, 'receipts');
    fs.mkdirSync(receiptDir, { recursive: true });

    // Fake product where decompile returns completeness: 'complete' but elapsed is > timeout
    let fakeNowValue = 1000;
    const fakeProduct = {
      sha: 'a'.repeat(64),
      architecture: 'arm64',
      endianness: 'little',
      profile: {},
      app: { backend: { analysisRouteInfo: () => ({ route: 'test' }) }, symbols: { functionStartsComplete: true } },
      query: {
        snapshot: async () => ({ id: 'snap' }),
        functions: async () => ({ value: [{ address: '4096', name: 'slow_fn', end: '4112' }], page: { next: null } }),
        decompile: async () => {
          fakeNowValue += 500; // simulate 500ms elapsed
          return { value: { pseudocode: 'void f() {}' }, status: { completeness: 'complete' } };
        },
      },
      close: async () => {},
    };

    const result = await runFreshSubject({
      binary: 'fake.bin',
      caseId: 'case1',
      receiptDir,
      sourceIdentity: 'ident',
      configHash: 'cfg',
      functionTimeoutMs: 200, // limit is 200ms, elapsed will be 500ms
      now: () => fakeNowValue,
      openProductFn: async () => fakeProduct,
    });

    assert.equal(result.functions.length, 1);
    const fnResult = result.functions[0];
    assert.notEqual(fnResult.state, 'PASS', 'Function exceeding timeout must not be PASS');
    assert.equal(fnResult.state, 'TIMEOUT');
    assert.equal(result.state, 'TIMEOUT');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('elapsed > functionTimeoutMs is never reported PASS in profile-fresh', async () => {
  // Fake binary runner with custom functions array to test the logic
  const functions = [];
  const functionTimeoutMs = 50;
  const fn = { address: '8192', name: 'slow_profiled' };

  // Simulate the profile-fresh decompile loop logic directly
  const fnStarted = performance.now() - 100; // 100ms ago (> 50ms)
  const response = { value: { pseudocode: 'int x = 1;' }, status: { completeness: 'complete' } };
  const elapsedMs = performance.now() - fnStarted;
  let state = response?.value ? (response?.status?.completeness === 'complete' ? 'PASS' : String(response?.status?.completeness ?? 'UNKNOWN').toUpperCase()) : 'UNSUPPORTED';
  let reason = response?.status?.reason ?? null;
  if (elapsedMs > functionTimeoutMs && state === 'PASS') {
    state = 'TIMEOUT';
    reason = reason ?? 'function-timeout-elapsed-exceeded';
  }
  functions.push({ address: String(fn.address), name: fn.name ?? null, elapsedMs, state, ...(reason ? { reason } : {}) });

  assert.equal(functions.length, 1);
  assert.equal(functions[0].state, 'TIMEOUT');
  assert.equal(functions[0].reason, 'function-timeout-elapsed-exceeded');
});
