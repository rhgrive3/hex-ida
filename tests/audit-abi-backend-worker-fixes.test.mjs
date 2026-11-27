import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  classifyMicrosoftX64CallReturn,
  classifyMicrosoftX64FunctionReturn,
  classifyMicrosoftX64Arguments,
} from '../js/targets/abi/microsoft-x64.js';
import {
  classifyMicrosoftVectorcallCallReturn,
  classifyMicrosoftVectorcallFunctionReturn,
} from '../js/targets/abi/microsoft-vectorcall.js';
import { DARWIN_ARM64_ABI } from '../js/targets/abi/darwin-arm64.js';
import { Backend } from '../js/backend.js';
import { CodeViewer } from '../js/viewer.js';
import { PlatformPluginRegistry } from '../js/platform/plugin-api-core.js';
import { ResourceBudget } from '../js/core/budgets/index.js';
import { ScopedAnalysisWork } from '../js/core/budgets/scoped-work.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('1a. Microsoft x64 classifies __m512 returns as unsupported 512-bit wide vectors, not rax', () => {
  const res = classifyMicrosoftX64CallReturn({ callPrototype: { returnType: '__m512' } });
  assert.equal(res.reg, null);
  assert.equal(res.partial, true);
  assert.equal(res.unsupported, true);
  assert.equal(res.vector, true);
  assert.equal(res.bits, 512);
  assert.equal(res.hiddenResultPossible, true);
  assert.equal(res.reason, 'microsoft-x64-wide-vector-return-not-modeled');

  const resD = classifyMicrosoftX64FunctionReturn({ returnType: '__m512d' });
  assert.equal(resD.reg, null);
  assert.equal(resD.bits, 512);
  assert.equal(resD.reason, 'microsoft-x64-wide-vector-return-not-modeled');

  const args = classifyMicrosoftX64Arguments({
    callPrototype: { returnType: '__m512i', args: [{ type: 'int' }] },
  });
  assert.equal(args.hiddenResultPossible, true);
  assert.equal(args.returnClassification, 'partial-hidden-result-possible');
});

test('1b. Microsoft __vectorcall classifies __m512 returns as unsupported wide vector, not rax', () => {
  const res512 = classifyMicrosoftVectorcallCallReturn({ callPrototype: { returnType: '__m512' } });
  assert.equal(res512.reg, null);
  assert.equal(res512.partial, true);
  assert.equal(res512.reason, 'microsoft-vectorcall-wide-vector-return-unsupported');

  const fn512 = classifyMicrosoftVectorcallFunctionReturn({ returnType: '__m512i' });
  assert.equal(fn512.reg, null);
  assert.equal(fn512.partial, true);
  assert.equal(fn512.reason, 'microsoft-vectorcall-wide-vector-return-unsupported');

  // __m256 remains modeled in ymm0
  const res256 = classifyMicrosoftVectorcallCallReturn({ callPrototype: { returnType: '__m256' } });
  assert.equal(res256.reg, 'ymm0');
  assert.equal(res256.bits, 256);
});

test('2. Darwin ARM64 normalizes options.returnType === "long double" to 64-bit double in v0', () => {
  const fromOptsOnly = DARWIN_ARM64_ABI.classifyCallReturn({}, { returnType: 'long double' });
  assert.deepEqual(fromOptsOnly, { reg: 'v0', bits: 64 });

  const overrideProto = DARWIN_ARM64_ABI.classifyCallReturn(
    { callPrototype: { returnType: 'int' } },
    { returnType: 'long double' },
  );
  assert.deepEqual(overrideProto, { reg: 'v0', bits: 64 });

  const fnRet = DARWIN_ARM64_ABI.classifyFunctionReturn({ returnType: 'long double' });
  assert.deepEqual(fnRet, { reg: 'v0', bits: 64 });

  const conflict = DARWIN_ARM64_ABI.classifyCallReturn({}, { returnType: 'long double', returnBits: 128 });
  assert.equal(conflict.reg, null);
  assert.equal(conflict.reason, 'darwin-arm64-long-double-width-conflicts-with-apple-binary64');
});

test('3. Backend._finishChunk does not infinitely re-dispatch when wantAsm was already dispatched and mn is null', async () => {
  const backend = Object.create(Backend.prototype);
  backend.analysisEpoch = 1;
  backend.cache = new Map();
  backend.inflight = new Map();
  backend.queue = [];
  backend.onChunk = () => {};

  let calls = 0;
  backend.call = async (type, params) => {
    assert.equal(type, 'chunk');
    calls++;
    if (calls > 5) throw new Error('infinite chunk re-dispatch loop detected');
    return { bytes: new Uint8Array(16), rows: 4, mn: null, ops: null };
  };

  backend.request('data-region', 0, true, 'visible');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls, 1, 'should dispatch once when wantAsm was already true');
  assert.equal(backend.inflight.size, 0);
  assert.equal(backend.queue.length, 0);

  // Verify upgrade path: initial wantAsm=false upgraded to wantAsm=true while in-flight retries exactly once.
  let upgradeCalls = [];
  let resolveFirst;
  backend.call = (type, params) => {
    upgradeCalls.push(params.wantAsm);
    if (upgradeCalls.length === 1) {
      return new Promise((resolve) => { resolveFirst = resolve; });
    }
    return Promise.resolve({ bytes: new Uint8Array(16), rows: 4, mn: null, ops: null });
  };
  backend.request('upgrade-region', 0, false, 'visible');
  backend.request('upgrade-region', 0, true, 'visible');
  resolveFirst({ bytes: new Uint8Array(16), rows: 4, mn: null, ops: null });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(upgradeCalls, [false, true], 'should retry once with wantAsm=true and stop');
  assert.equal(backend.inflight.size, 0);
});

test('4. panels-base.js has no broken no-arg cancelSearch() calls and guards showFunctionSummary & showStrings', () => {
  const src = fs.readFileSync(path.join(ROOT, 'js/panels-base.js'), 'utf8');
  assert.equal(
    /app\.backend\.cancelSearch\(\s*\)/.test(src),
    false,
    'panels-base.js must not contain any no-arg app.backend.cancelSearch() calls',
  );

  // Verify showFunctionSummary captures epoch and checks sheet.root.isConnected & epoch !== app.backend.gen
  const summaryStart = src.indexOf('export function showFunctionSummary(');
  const summaryEnd = src.indexOf('export function applySemantic(', summaryStart);
  const summarySrc = src.slice(summaryStart, summaryEnd);
  assert.match(summarySrc, /const epoch = app\.backend\.gen;/);
  assert.match(summarySrc, /if \(!sheet\.root\.isConnected \|\| epoch !== app\.backend\.gen\) return;/);

  // Verify showStrings tracks scanToken + activeRequest and cancels prior/onClose requests
  const stringsStart = src.indexOf('export function showStrings(');
  const stringsEnd = src.indexOf('function showXrefsLegacy(', stringsStart);
  const stringsSrc = src.slice(stringsStart, stringsEnd);
  assert.match(stringsSrc, /app\.backend\.cancelSearch\(activeRequest\)/);
  assert.match(stringsSrc, /if \(token !== scanToken \|\| active !== region \|\| !sheet\.root\.isConnected\) return;/);
});

test('5. CodeViewer.scrollByRows guards previousBoundary callback against navigation/region/disposal staleness', async () => {
  const makeViewer = () => {
    let resolveBoundary;
    const ensureCalls = [];
    const invalidateCalls = [];
    const viewer = Object.create(CodeViewer.prototype);
    viewer.totalRows = 10;
    viewer.variableRows = [{ address: 0x1000n }];
    viewer.variableNavigation = 1;
    viewer.region = { id: 'r1' };
    viewer.disposed = false;
    viewer.variableError = null;
    viewer.isVariableAsm = () => true;
    viewer.topRow = () => 0;
    viewer.invalidate = () => invalidateCalls.push(true);
    viewer.variableIndex = {
      previousBoundary: () => new Promise((r) => { resolveBoundary = r; }),
      ensurePage: (addr, opts) => { ensureCalls.push({ addr, opts }); return Promise.resolve(); },
    };
    return { viewer, resolve: (val) => resolveBoundary(val), ensureCalls, invalidateCalls };
  };

  // Case A: variableNavigation changes before previousBoundary settles -> stale, ignored
  {
    const { viewer, resolve, invalidateCalls } = makeViewer();
    viewer.scrollByRows(-1);
    viewer.variableNavigation = 2;
    resolve({ status: 'ambiguous' });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(viewer.variableError, null);
    assert.equal(invalidateCalls.length, 0);
  }

  // Case B: region switches before previousBoundary settles -> stale, ignored
  {
    const { viewer, resolve, invalidateCalls } = makeViewer();
    viewer.scrollByRows(-1);
    viewer.region = { id: 'r2' };
    resolve({ status: 'ambiguous' });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(viewer.variableError, null);
    assert.equal(invalidateCalls.length, 0);
  }

  // Case C: viewer disposed before previousBoundary settles -> stale, ignored
  {
    const { viewer, resolve, ensureCalls, invalidateCalls } = makeViewer();
    viewer.scrollByRows(-1);
    viewer.disposed = true;
    resolve({ status: 'proven', address: 0x0ffcn });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(ensureCalls.length, 0);
    assert.equal(invalidateCalls.length, 0);
  }

  // Case D: still current -> updates variableError and invalidates
  {
    const { viewer, resolve, invalidateCalls } = makeViewer();
    viewer.scrollByRows(-1);
    resolve({ status: 'ambiguous' });
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(viewer.variableError, { address: 0x1000n, status: 'ambiguous', bytes: null });
    assert.equal(invalidateCalls.length, 1);
  }
});

test('6. worker-legacy.js keys activeRequests/cancelledRequests by epoch:id and avoids redundant scanProgram .slice()', async () => {
  const src = fs.readFileSync(path.join(ROOT, 'js/worker-legacy.js'), 'utf8');

  // Verify epoch:id keying and no redundant .slice() in scanProgram
  assert.match(src, /requestKey\s*=\s*\(epoch,\s*id\)\s*=>\s*`\$\{epoch\}:\$\{id\}`/);
  assert.match(src, /const outCallFrom = nCalls === callFrom\.length \? callFrom : callFrom\.slice\(0, nCalls\);/);
  assert.match(src, /const outRefFrom = nRefs === refFrom\.length \? refFrom : refFrom\.slice\(0, nRefs\);/);
  assert.match(src, /const outKinds = kinds\.length <= words \? kinds : kinds\.slice\(0, words\);/);

  // Behavioral test of cross-epoch request deletion isolation by executing the onmessage logic in VM
  const posted = [];
  let releaseEpoch1;
  let releaseEpoch2;
  let epoch2SawCancelled = null;

  const sandbox = {
    console,
    Map, Set, Promise, Error, BigInt, Uint8Array, BigUint64Array, DataView, Math, Number, String, Array, Object,
    setTimeout, clearTimeout,
    importScripts: () => {},
    WORKER_BUDGET: { PROGRAM_INDEX_BYTES: 96 * 1024 * 1024, FUNCTION_AUX_SLOTS: 1000, withinProgramBudget: () => true },
    self: {
      location: { href: 'http://localhost/js/worker-legacy.js' },
      postMessage: (msg) => posted.push(msg),
    },
  };
  vm.createContext(sandbox);

  // Extract lines 58-128 (state, onmessage, cancelled, post, errText) and hook handle()
  const lines = src.split('\n');
  const startIdx = lines.findIndex((l) => l.startsWith('let file = null;'));
  const endIdx = lines.findIndex((l) => l.startsWith('async function handle(msg)'));
  const snippet = lines.slice(startIdx, endIdx).join('\n') + `
    async function handle(msg) {
      if (msg.t === 'open') return { ok: true };
      if (msg.t === 'slow' && msg.epoch === 1) {
        await new Promise((r) => { globalThis.__release1 = r; });
        return { epoch: 1 };
      }
      if (msg.t === 'slow' && msg.epoch === 2) {
        await new Promise((r) => { globalThis.__release2 = r; });
        return { epoch: 2, wasCancelled: cancelled(msg.id, msg.epoch) };
      }
      return {};
    }
  `;
  vm.runInContext(snippet, sandbox);

  // Open epoch 1
  await sandbox.self.onmessage({ data: { t: 'open', id: 100, epoch: 1 } });
  // Start request id=1 in epoch 1 (does not finish yet)
  const p1 = sandbox.self.onmessage({ data: { t: 'slow', id: 1, epoch: 1 } });
  await new Promise((r) => setTimeout(r, 5));

  // Open epoch 2 and start request id=1 in epoch 2
  await sandbox.self.onmessage({ data: { t: 'open', id: 101, epoch: 2 } });
  const p2 = sandbox.self.onmessage({ data: { t: 'slow', id: 1, epoch: 2 } });
  await new Promise((r) => setTimeout(r, 5));

  // Cancel epoch 2 request id=1
  await sandbox.self.onmessage({ data: { t: 'cancel', requestId: 1, epoch: 2 } });

  // Now epoch 1 request id=1 finishes -> its finally MUST NOT delete epoch 2's cancelled flag!
  sandbox.__release1();
  await p1;

  // Now let epoch 2 request id=1 check cancelled(1, 2)
  sandbox.__release2();
  await p2;

  const msg2 = posted.find((m) => m.t === 'ok' && m.id === 1 && m.epoch === 2);
  assert.ok(msg2, 'epoch 2 response should be posted');
  assert.equal(msg2.result.wasCancelled, true, 'epoch 1 finally must not wipe epoch 2 cancelledRequests entry');
});

test('7. PlatformPluginRegistry.invoke removes per-invocation child budget scope in finally', async () => {
  const registry = new PlatformPluginRegistry();
  registry.registerAnalyzer( 'ok-plugin', {
    analyze(ctx) {
      ctx.resourceBudget.consume('workUnits', 5);
      return { done: true };
    },
  });
  registry.registerAnalyzer( 'fail-plugin', {
    analyze() {
      throw new Error('boom');
    },
  });

  const budget = new ResourceBudget({ workUnits: 1000 });
  assert.equal(budget.children.size, 0);

  for (let i = 0; i < 5; i++) {
    const res = await registry.invoke('analyzer', 'ok-plugin', 'analyze', { resourceBudget: budget });
    assert.equal(res.ok, true);
  }
  assert.equal(budget.children.size, 0, 'successful invocations must not leak child scopes');
  assert.equal(budget.used.workUnits, 25, 'parent budget totals must still be charged');

  const failRes = await registry.invoke('analyzer', 'fail-plugin', 'analyze', { resourceBudget: budget });
  assert.equal(failRes.ok, false);
  assert.equal(budget.children.size, 0, 'failed invocations must not leak child scopes');

  const ac = new AbortController();
  ac.abort('already-aborted');
  const abortRes = await registry.invoke('analyzer', 'ok-plugin', 'analyze', { resourceBudget: budget }, { signal: ac.signal });
  assert.equal(abortRes.ok, false);
  assert.equal(budget.children.size, 0, 'aborted invocations must not leak child scopes');
});

test('8. ScopedAnalysisWork does not schedule a setTimeout timer when constructed with an already-aborted signal', () => {
  const before = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;

  const ac = new AbortController();
  ac.abort('already-aborted');
  const work1 = new ScopedAnalysisWork({ signal: ac.signal, limits: { deadlineMs: 60000 } });
  assert.equal(work1.signal.aborted, true);

  const parentAc = new AbortController();
  parentAc.abort('parent-aborted');
  const parentBudget = new ResourceBudget({ workUnits: 100 }, { signal: parentAc.signal });
  const work2 = new ScopedAnalysisWork({ parentBudget, limits: { deadlineMs: 60000 } });
  assert.equal(work2.signal.aborted, true);

  const after = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
  assert.equal(after, before, 'must not leak referenced Timeout handles for already-aborted scopes');

  // Clean up parent child reference (even though no timer was created)
  work1.dispose();
  work2.dispose();
});
