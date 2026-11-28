import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OP as LEGACY_OP } from '../js/ir.js';
import { propagateExactLegacyConstants } from '../js/ir-core.js';
import {
  pinpointFunction,
  DEFAULT_PER_FUNCTION_BUDGET_MS,
  PER_FUNCTION_BUDGET_EXCEEDED_REASON,
} from '../js/pinpoint.js';
import { compileGoal } from '../js/goalc.js';
import { makePinpointAnalyzer } from '../js/ui/pinpoint-runtime.js';

test('propagateExactLegacyConstants memoizes 60-level diamond DAG (< 50ms) with exact constants and preserved observations', () => {
  const levels = 60;
  const values = [];

  const v0 = { id: 'v0', bits: 64, const: null, def: null };
  v0.def = { id: 'i0', op: LEGACY_OP.CONST, sub: null, dst: v0, args: [], extra: { value: 1n } };
  values.push(v0);

  for (let i = 1; i <= levels; i++) {
    const prev = values[i - 1];
    const vi = { id: `v${i}`, bits: 64, const: null, def: null };
    vi.def = {
      id: `i${i}`,
      op: LEGACY_OP.BIN,
      sub: 'add',
      dst: vi,
      args: [{ value: prev }, { value: prev }],
      extra: {},
    };
    values.push(vi);
  }

  // Reverse order ensures v60 is evaluated first while v0..v59 all still have const === null.
  // Without memoization, exactLegacyConstant(v60) would require 2^60 recursive calls.
  const projected = { values: values.slice().reverse() };
  const t0 = performance.now();
  const observer = propagateExactLegacyConstants(projected);
  const elapsedMs = performance.now() - t0;

  assert.ok(elapsedMs < 50, `60-level diamond DAG took ${elapsedMs.toFixed(2)}ms (expected < 50ms)`);
  assert.equal(values[0].const, 1n);
  assert.equal(values[30].const, 1n << 30n);
  assert.equal(values[levels].const, 1n << BigInt(levels));
  assert.equal(observer.records.length, levels + 1);

  const topRecord = observer.records.find((r) => r.output === values[levels]);
  assert.ok(topRecord, 'top diamond value must have an observation record');
  assert.equal(topRecord.inputs.length, levels + 1, 'top record must capture all 61 unique DAG dependencies');

  const midRecord = observer.records.find((r) => r.output === values[30]);
  assert.ok(midRecord, 'memo-hit mid value must still have an observation record');
  assert.equal(midRecord.inputs.length, 31, 'memo-hit mid record must preserve all 31 transitive read dependencies');
});

test('pinpointFunction enforces perFunctionBudgetMs, marks slow candidate unverified, yields cooperatively, and verifies next candidate', async () => {
  assert.equal(DEFAULT_PER_FUNCTION_BUDGET_MS, 1500);
  const goal = compileGoal('暗号化').goal;
  const symbols = { symbolCount: 0, functionCount: 100, addrs: [], names: [], renames: new Map(), nameAt: () => '' };
  const program = {
    functionsReferencing: () => [],
    calleesOf: () => [],
    callersOf: () => [],
    callCountOf: () => 2,
    functionRange: (a) => ({ start: BigInt(a), end: BigInt(a) + 0x40n }),
    statsOf: () => ({ total: 10, numeric: 2, store: 1, cmp: 1, covered: true }),
  };

  const ranked = [
    { addr: 0x2000n, name: null, score: 50, reasons: [{ code: 'crypto-const', points: 32, kind: 'fact' }], strings: [] },
    { addr: 0x3000n, name: null, score: 45, reasons: [{ code: 'crypto-const', points: 32, kind: 'fact' }], strings: [] },
  ];

  const attempted = [];
  let slowCancelled = false;
  let eventLoopTickedBetweenFunctions = false;

  const analyze = (addr, _end, options) => {
    attempted.push(addr);
    if (addr === 0x2000n) {
      let timer = null;
      const promise = new Promise((resolve) => {
        timer = setTimeout(() => resolve({ instructions: [] }), 5000);
        options?.signal?.addEventListener('abort', () => {
          slowCancelled = true;
          clearTimeout(timer);
          resolve(null);
        }, { once: true });
      });
      promise.cancel = () => {
        slowCancelled = true;
        clearTimeout(timer);
      };
      setTimeout(() => { eventLoopTickedBetweenFunctions = true; }, 0);
      return promise;
    }
    return Promise.resolve({
      instructions: [
        { address: 0x3000n, mnemonic: 'ldrb', operands: 'w8, [x0, x2]' },
        { address: 0x3004n, mnemonic: 'eor', operands: 'w8, w8, w3' },
        { address: 0x3008n, mnemonic: 'strb', operands: 'w8, [x0, x2]' },
        { address: 0x300cn, mnemonic: 'add', operands: 'x2, x2, #1' },
        { address: 0x3010n, mnemonic: 'cmp', operands: 'x2, x1' },
        { address: 0x3014n, mnemonic: 'b.lt', operands: '0x3000' },
        { address: 0x3018n, mnemonic: 'ret', operands: '' },
      ],
    });
  };

  const t0 = performance.now();
  const result = await pinpointFunction({
    goal,
    ranked,
    symbols,
    program,
    deep: true,
    perFunctionBudgetMs: 40,
    analyze,
  });
  const elapsedMs = performance.now() - t0;

  assert.ok(elapsedMs < 1000, `pinpointFunction should not wait 5000ms for slow function; took ${elapsedMs.toFixed(1)}ms`);
  assert.deepEqual(attempted, [0x2000n, 0x3000n], 'must move cleanly to the next candidate after budget exceedance');
  assert.equal(slowCancelled, true, 'slow function signal/cancel must be triggered on budget timeout');
  assert.equal(eventLoopTickedBetweenFunctions, true, 'event loop must be allowed to tick between functions');

  const slowCand = result.candidates.find((c) => c.addr === 0x2000n);
  const fastCand = result.candidates.find((c) => c.addr === 0x3000n);
  assert.ok(slowCand, 'slow candidate remains in result list');
  assert.equal(slowCand.verificationStatus, 'unverified');
  assert.equal(slowCand.unconfirmed, true);
  assert.equal(slowCand.statusLabel, '未確認');
  assert.equal(slowCand.unverifiedReason, PER_FUNCTION_BUDGET_EXCEEDED_REASON);

  assert.ok(Array.isArray(result.budgetExceeded) && result.budgetExceeded.length === 1);
  assert.equal(result.budgetExceeded[0].addr, 0x2000n);
  assert.equal(result.budgetExceeded[0].reason, PER_FUNCTION_BUDGET_EXCEEDED_REASON);
  assert.ok(result.missing.includes(PER_FUNCTION_BUDGET_EXCEEDED_REASON));

  assert.ok(fastCand, 'fast candidate remains in result list');
  assert.notEqual(fastCand.unconfirmed, true);
  assert.ok(
    fastCand.evidence.some((e) => e.code === 'fn-crypto-bitwise'),
    'next candidate after slow function must still be analyzed and verified',
  );
});

test('pinpointFunction stops promptly on AbortSignal during and between functions', async () => {
  const goal = compileGoal('暗号化').goal;
  const symbols = { symbolCount: 0, functionCount: 100, addrs: [], names: [], renames: new Map(), nameAt: () => '' };
  const program = {
    functionsReferencing: () => [],
    calleesOf: () => [],
    callersOf: () => [],
    callCountOf: () => 2,
    functionRange: (a) => ({ start: BigInt(a), end: BigInt(a) + 0x40n }),
    statsOf: () => ({ total: 10, numeric: 2, store: 1, cmp: 1, covered: true }),
  };

  const ranked = [
    { addr: 0x4000n, name: null, score: 50, reasons: [{ code: 'crypto-const', points: 32, kind: 'fact' }], strings: [] },
    { addr: 0x5000n, name: null, score: 48, reasons: [{ code: 'crypto-const', points: 32, kind: 'fact' }], strings: [] },
    { addr: 0x6000n, name: null, score: 46, reasons: [{ code: 'crypto-const', points: 32, kind: 'fact' }], strings: [] },
  ];

  // Case 1: Abort mid-analysis of candidate 1
  {
    const controller = new AbortController();
    const attempted = [];
    const t0 = performance.now();
    await pinpointFunction({
      goal,
      ranked,
      symbols,
      program,
      deep: true,
      perFunctionBudgetMs: 5000,
      signal: controller.signal,
      analyze: (addr, _end, options) => {
        attempted.push(addr);
        setTimeout(() => controller.abort('user-stop'), 20);
        return new Promise((resolve) => {
          const timer = setTimeout(() => resolve({ instructions: [] }), 5000);
          options?.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve(null);
          }, { once: true });
        });
      },
    });
    const elapsedMs = performance.now() - t0;
    assert.ok(elapsedMs < 500, `AbortSignal must stop pinpoint promptly; took ${elapsedMs.toFixed(1)}ms`);
    assert.deepEqual(attempted, [0x4000n], 'must not analyze subsequent candidates after abort');
  }

  // Case 2: Abort immediately between candidate 1 and candidate 2
  {
    const controller = new AbortController();
    const attempted = [];
    const t0 = performance.now();
    await pinpointFunction({
      goal,
      ranked,
      symbols,
      program,
      deep: true,
      perFunctionBudgetMs: 5000,
      signal: controller.signal,
      analyze: async (addr) => {
        attempted.push(addr);
        controller.abort('stop-between-functions');
        return { instructions: [] };
      },
    });
    const elapsedMs = performance.now() - t0;
    assert.ok(elapsedMs < 200, `AbortSignal between functions must stop promptly; took ${elapsedMs.toFixed(1)}ms`);
    assert.deepEqual(attempted, [0x4000n], 'must stop immediately between functions without starting candidate 2');
  }
});

test('makePinpointAnalyzer perFunctionBudgetMs abort propagates error.reason to pinpointFunction budgetExceeded metadata', async () => {
  const goal = compileGoal('暗号化').goal;
  const symbols = {
    symbolCount: 0,
    functionCount: 100,
    addrs: [],
    names: [],
    renames: new Map(),
    nameAt: () => '',
    functionWindowBound: (addr) => BigInt(addr) + 0x40n,
  };
  const program = {
    functionsReferencing: () => [],
    calleesOf: () => [],
    callersOf: () => [],
    callCountOf: () => 2,
    functionRange: (a) => ({ start: BigInt(a), end: BigInt(a) + 0x40n }),
    statsOf: () => ({ total: 10, numeric: 2, store: 1, cmp: 1, covered: true }),
  };

  const region = { id: 'text', vmAddr: 0x1000n, size: 0x4000n };
  const app = {
    store: new Map([
      ['canDisassemble', true],
      ['architecture', 'arm64'],
      ['capability', { architecture: 'arm64', fixedInstructionSize: 4 }],
    ]),
    backend: {},
    symbols,
    executableRegionFor: () => region,
  };

  let runtimeAbortReason = null;
  const customAnalyze = (_backend, _owner, startRow, _endRow, _syms, _hint, options) => {
    const addr = region.vmAddr + BigInt(startRow) * 4n;
    if (addr === 0x2000n) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve({ model: { instructions: [] } }), 5000);
        options?.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          runtimeAbortReason = options.signal.reason;
          const err = new Error('Aborted');
          err.name = 'AbortError';
          reject(err);
        }, { once: true });
      });
    }
    return Promise.resolve({
      model: {
        instructions: [
          { address: 0x3000n, mnemonic: 'ldrb', operands: 'w8, [x0, x2]' },
          { address: 0x3004n, mnemonic: 'eor', operands: 'w8, w8, w3' },
          { address: 0x3008n, mnemonic: 'strb', operands: 'w8, [x0, x2]' },
          { address: 0x300cn, mnemonic: 'add', operands: 'x2, x2, #1' },
          { address: 0x3010n, mnemonic: 'cmp', operands: 'x2, x1' },
          { address: 0x3014n, mnemonic: 'b.lt', operands: '0x3000' },
          { address: 0x3018n, mnemonic: 'ret', operands: '' },
        ],
      },
    });
  };

  const runtimeAnalyzer = makePinpointAnalyzer(app, region, null, customAnalyze);
  assert.ok(runtimeAnalyzer, 'makePinpointAnalyzer must return an analyzer function');

  const ranked = [
    { addr: 0x2000n, name: null, score: 50, reasons: [{ code: 'crypto-const', points: 32, kind: 'fact' }], strings: [] },
    { addr: 0x3000n, name: null, score: 45, reasons: [{ code: 'crypto-const', points: 32, kind: 'fact' }], strings: [] },
  ];

  // Give makePinpointAnalyzer a tighter budget (25ms) than pinpointFunction's outer guard (500ms)
  // so makePinpointAnalyzer's OWN budgetTimer fires first.
  const result = await pinpointFunction({
    goal,
    ranked,
    symbols,
    program,
    deep: true,
    perFunctionBudgetMs: 500,
    analyze: (addr, end, opts) => runtimeAnalyzer(addr, end, { ...opts, perFunctionBudgetMs: 25 }),
  });

  assert.equal(runtimeAbortReason, PER_FUNCTION_BUDGET_EXCEEDED_REASON);
  assert.ok(Array.isArray(result.budgetExceeded) && result.budgetExceeded.length === 1);
  assert.equal(result.budgetExceeded[0].addr, 0x2000n);
  assert.equal(result.budgetExceeded[0].reason, PER_FUNCTION_BUDGET_EXCEEDED_REASON);

  const slowCand = result.candidates.find((c) => c.addr === 0x2000n);
  assert.ok(slowCand);
  assert.equal(slowCand.verificationStatus, 'unverified');
  assert.equal(slowCand.unconfirmed, true);
  assert.equal(slowCand.unverifiedReason, PER_FUNCTION_BUDGET_EXCEEDED_REASON);

  const fastCand = result.candidates.find((c) => c.addr === 0x3000n);
  assert.ok(fastCand);
  assert.notEqual(fastCand.unconfirmed, true);
  assert.ok(fastCand.evidence.some((e) => e.code === 'fn-crypto-bitwise'));
});

import { CHUNK_ROWS } from '../js/backend.js';
import { handlePinpointWorkerMessage } from '../js/analysis/pinpoint-worker.js';

function createArm64CryptoBackend(region) {
  const insns = [
    { mn: 'ldrb', ops: 'w8, [x0, x2]' },
    { mn: 'eor', ops: 'w8, w8, w3' },
    { mn: 'strb', ops: 'w8, [x0, x2]' },
    { mn: 'add', ops: 'x2, x2, #1' },
    { mn: 'cmp', ops: 'x2, x1' },
    { mn: 'b.lt', ops: '0x3000' },
    { mn: 'ret', ops: '' },
  ];
  return {
    async fetchChunk(_regionId, chunkIdx) {
      const base = chunkIdx * CHUNK_ROWS;
      const mn = new Array(CHUNK_ROWS).fill('');
      const ops = new Array(CHUNK_ROWS).fill('');
      const bytes = new Uint8Array(CHUNK_ROWS * 4);
      const fillAt = (fnAddr) => {
        const startRow = Number((fnAddr - region.vmAddr) / 4n);
        for (let i = 0; i < insns.length; i++) {
          const row = startRow + i;
          if (row >= base && row < base + CHUNK_ROWS) {
            mn[row - base] = insns[i].mn;
            ops[row - base] = insns[i].ops.replace('0x3000', '0x' + fnAddr.toString(16));
          }
        }
      };
      fillAt(0x2000n);
      fillAt(0x3000n);
      return { mn, ops, bytes };
    },
  };
}

function createPinpointFixture(region, backend) {
  const symbols = {
    gen: 1,
    symbolCount: 0,
    functionCount: 100,
    addrs: [],
    names: [],
    renames: new Map(),
    nameAt: (a) => (a === 0x3000n ? 'xor_crypt' : ''),
    label: () => null,
    functionWindowBound: (addr) => BigInt(addr) + 0x1cn,
  };
  const program = {
    functionsReferencing: () => [],
    calleesOf: () => [],
    callersOf: () => [],
    callCountOf: () => 2,
    functionRange: (a) => ({ start: BigInt(a), end: BigInt(a) + 0x1cn }),
    statsOf: () => ({ total: 7, numeric: 2, store: 1, cmp: 1, covered: true }),
  };
  const app = {
    store: new Map([
      ['canDisassemble', true],
      ['architecture', 'arm64'],
      ['capability', { architecture: 'arm64', fixedInstructionSize: 4 }],
    ]),
    backend,
    symbols,
    executableRegionFor: () => region,
  };
  return { symbols, program, app };
}

test('pinpoint worker happy path: executes real pinpoint-worker.js off-thread over structuredClone and returns exact IR model', async () => {
  const region = { id: 'text', vmAddr: 0x1000n, size: 0x4000n };
  const backend = createArm64CryptoBackend(region);
  const { symbols, program, app } = createPinpointFixture(region, backend);

  const workerEvents = [];
  class MockRealPinpointWorker {
    constructor(url, opts) {
      this.url = String(url);
      this.opts = opts;
      this.terminated = false;
      this.listeners = new Map();
      workerEvents.push({ type: 'spawn', url: this.url, opts });
    }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(fn);
    }
    postMessage(msg) {
      const clonedIn = structuredClone(msg);
      workerEvents.push({ type: 'postMessage', id: clonedIn.id, addr: clonedIn.addr });
      Promise.resolve().then(async () => {
        const res = await handlePinpointWorkerMessage(clonedIn);
        if (this.terminated) return;
        const clonedOut = structuredClone(res);
        for (const fn of this.listeners.get('message') || []) fn({ data: clonedOut });
      });
    }
    terminate() {
      this.terminated = true;
      workerEvents.push({ type: 'terminate' });
    }
  }

  const analyzer = makePinpointAnalyzer(app, region, null, undefined, {
    WorkerCtor: MockRealPinpointWorker,
  });
  assert.ok(analyzer);

  const model = await analyzer(0x3000n, 0x301cn, { perFunctionBudgetMs: 1500 });
  assert.ok(model, 'worker must return semantic model');
  assert.equal(model.name, 'xor_crypt');
  assert.equal(model.instructions.length, 7);
  assert.equal(typeof model.blockOfRow, 'function', 'blockOfRow must be re-hydrated after structured clone');

  const goal = compileGoal('暗号化').goal;
  const result = await pinpointFunction({
    goal,
    ranked: [
      { addr: 0x3000n, name: 'xor_crypt', score: 45, reasons: [{ code: 'crypto-const', points: 32, kind: 'fact' }], strings: [] },
    ],
    symbols,
    program,
    deep: true,
    perFunctionBudgetMs: 1500,
    analyze: analyzer,
  });

  const cand = result.candidates.find((c) => c.addr === 0x3000n);
  assert.ok(cand);
  assert.notEqual(cand.unconfirmed, true);
  assert.ok(cand.evidence.some((e) => e.code === 'fn-crypto-bitwise'));
  assert.equal(workerEvents.filter((e) => e.type === 'spawn').length, 1, 'worker should be reused across sequential calls');

  analyzer.dispose();
  assert.equal(workerEvents.filter((e) => e.type === 'terminate').length, 1, 'dispose() must terminate idle worker');
});

test('pinpoint worker hard timeout: perFunctionBudgetMs calls worker.terminate(), marks unverified, and spawns fresh worker for next candidate', async () => {
  const region = { id: 'text', vmAddr: 0x1000n, size: 0x4000n };
  const backend = createArm64CryptoBackend(region);
  const { symbols, program, app } = createPinpointFixture(region, backend);

  const spawnedWorkers = [];
  class HangingThenHealthyWorker {
    constructor(url, opts) {
      this.index = spawnedWorkers.length + 1;
      this.url = String(url);
      this.opts = opts;
      this.terminated = false;
      this.terminateCount = 0;
      this.listeners = new Map();
      spawnedWorkers.push(this);
    }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(fn);
    }
    postMessage(msg) {
      const clonedIn = structuredClone(msg);
      if (clonedIn.addr === 0x2000n) {
        // Simulate an infinite synchronous hang in the worker — never posts back.
        return;
      }
      Promise.resolve().then(async () => {
        const res = await handlePinpointWorkerMessage(clonedIn);
        if (this.terminated) return;
        const clonedOut = structuredClone(res);
        for (const fn of this.listeners.get('message') || []) fn({ data: clonedOut });
      });
    }
    terminate() {
      this.terminated = true;
      this.terminateCount++;
    }
  }

  const analyzer = makePinpointAnalyzer(app, region, null, undefined, {
    WorkerCtor: HangingThenHealthyWorker,
  });
  const goal = compileGoal('暗号化').goal;
  const ranked = [
    { addr: 0x2000n, name: null, score: 50, reasons: [{ code: 'crypto-const', points: 32, kind: 'fact' }], strings: [] },
    { addr: 0x3000n, name: 'xor_crypt', score: 45, reasons: [{ code: 'crypto-const', points: 32, kind: 'fact' }], strings: [] },
  ];

  const t0 = performance.now();
  const result = await pinpointFunction({
    goal,
    ranked,
    symbols,
    program,
    deep: true,
    perFunctionBudgetMs: 500,
    analyze: (addr, end, opts) => analyzer(addr, end, { ...opts, perFunctionBudgetMs: 30 }),
  });
  const elapsedMs = performance.now() - t0;

  assert.ok(elapsedMs < 1000, `hard worker timeout must fire promptly; took ${elapsedMs.toFixed(1)}ms`);
  assert.equal(spawnedWorkers.length, 2, 'fresh worker must be spawned for candidate 2 after candidate 1 hard termination');
  assert.equal(spawnedWorkers[0].terminated, true, 'first worker MUST be hard-terminated on budget expiry');
  assert.equal(spawnedWorkers[0].terminateCount, 1);
  assert.equal(spawnedWorkers[1].terminated, false, 'second worker should remain alive until dispose()');

  assert.ok(Array.isArray(result.budgetExceeded) && result.budgetExceeded.length === 1);
  assert.equal(result.budgetExceeded[0].addr, 0x2000n);
  assert.equal(result.budgetExceeded[0].reason, PER_FUNCTION_BUDGET_EXCEEDED_REASON);

  const slowCand = result.candidates.find((c) => c.addr === 0x2000n);
  assert.ok(slowCand);
  assert.equal(slowCand.verificationStatus, 'unverified');
  assert.equal(slowCand.unconfirmed, true);
  assert.equal(slowCand.statusLabel, '未確認');
  assert.equal(slowCand.unverifiedReason, PER_FUNCTION_BUDGET_EXCEEDED_REASON);

  const fastCand = result.candidates.find((c) => c.addr === 0x3000n);
  assert.ok(fastCand);
  assert.notEqual(fastCand.unconfirmed, true);
  assert.ok(fastCand.evidence.some((e) => e.code === 'fn-crypto-bitwise'));

  analyzer.dispose();
  assert.equal(spawnedWorkers[1].terminated, true);
});

test('pinpoint worker caller AbortSignal immediately calls worker.terminate() and stops promptly', async () => {
  const region = { id: 'text', vmAddr: 0x1000n, size: 0x4000n };
  const backend = createArm64CryptoBackend(region);
  const { app } = createPinpointFixture(region, backend);

  let terminated = 0;
  class HangingWorker {
    addEventListener() {}
    postMessage() {}
    terminate() { terminated++; }
  }

  const controller = new AbortController();
  const analyzer = makePinpointAnalyzer(app, region, null, undefined, {
    WorkerCtor: HangingWorker,
  });

  setTimeout(() => controller.abort('user-cancelled'), 20);
  const t0 = performance.now();
  await assert.rejects(
    () => analyzer(0x2000n, 0x201cn, { signal: controller.signal, perFunctionBudgetMs: 5000 }),
    (err) => err?.name === 'AbortError' && err?.reason === 'user-cancelled',
  );
  const elapsedMs = performance.now() - t0;

  assert.ok(elapsedMs < 500, `AbortSignal must terminate worker promptly; took ${elapsedMs.toFixed(1)}ms`);
  assert.equal(terminated, 1, 'AbortSignal must immediately call worker.terminate()');
  analyzer.dispose();
});

test('pinpoint worker fallback: gracefully falls back to in-thread analyzeFunctionCached when Worker throws on construction or postMessage', async () => {
  const region = { id: 'text', vmAddr: 0x1000n, size: 0x4000n };
  const backend = createArm64CryptoBackend(region);
  const { app } = createPinpointFixture(region, backend);

  // Case 1: Worker constructor throws (e.g. CSP/blob restriction)
  class CspBlockedWorker {
    constructor() {
      throw new Error('SecurityError: Blocked by CSP');
    }
  }
  const analyzerCsp = makePinpointAnalyzer(app, region, null, undefined, {
    WorkerCtor: CspBlockedWorker,
  });
  const modelCsp = await analyzerCsp(0x3000n, 0x301cn, { perFunctionBudgetMs: 1500 });
  assert.ok(modelCsp, 'must fall back to in-thread analyzeFunctionCached when Worker constructor throws');
  assert.equal(modelCsp.name, 'xor_crypt');
  assert.equal(modelCsp.instructions.length, 7);
  analyzerCsp.dispose();

  // Case 2: Worker postMessage throws DataCloneError
  class UncloneableWorker {
    addEventListener() {}
    postMessage() {
      throw new Error('DataCloneError: could not be cloned');
    }
    terminate() {}
  }
  const analyzerClone = makePinpointAnalyzer(app, region, null, undefined, {
    WorkerCtor: UncloneableWorker,
  });
  const modelClone = await analyzerClone(0x3000n, 0x301cn, { perFunctionBudgetMs: 1500 });
  assert.ok(modelClone, 'must fall back to in-thread analyzeFunctionCached when postMessage throws');
  assert.equal(modelClone.name, 'xor_crypt');
  assert.equal(modelClone.instructions.length, 7);
  analyzerClone.dispose();

  // Case 3: Worker unavailable (useWorker: false / no globalThis.Worker)
  const analyzerNoWorker = makePinpointAnalyzer(app, region, null, undefined, {
    useWorker: false,
  });
  const modelNoWorker = await analyzerNoWorker(0x3000n, 0x301cn, { perFunctionBudgetMs: 1500 });
  assert.ok(modelNoWorker, 'must work seamlessly when Worker is unavailable');
  assert.equal(modelNoWorker.name, 'xor_crypt');
  assert.equal(modelNoWorker.instructions.length, 7);
});

test('pinpoint worker FIFO serialization: concurrent call #1 timeout terminates only worker #1 while queued sibling call #2 completes on fresh worker', async () => {
  const region = { id: 'text', vmAddr: 0x1000n, size: 0x4000n };
  const backend = createArm64CryptoBackend(region);
  const { app } = createPinpointFixture(region, backend);

  const spawnedWorkers = [];
  class SerializedHangThenHealthyWorker {
    constructor(url, opts) {
      this.index = spawnedWorkers.length + 1;
      this.url = String(url);
      this.opts = opts;
      this.terminated = false;
      this.receivedAddrs = [];
      this.listeners = new Map();
      spawnedWorkers.push(this);
    }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(fn);
    }
    postMessage(msg) {
      const clonedIn = structuredClone(msg);
      this.receivedAddrs.push(clonedIn.addr);
      if (clonedIn.addr === 0x2000n) {
        // Hang indefinitely on call #1 until hard-terminated by budget timeout.
        return;
      }
      Promise.resolve().then(async () => {
        const res = await handlePinpointWorkerMessage(clonedIn);
        if (this.terminated) return;
        const clonedOut = structuredClone(res);
        for (const fn of this.listeners.get('message') || []) fn({ data: clonedOut });
      });
    }
    terminate() {
      this.terminated = true;
    }
  }

  const analyzer = makePinpointAnalyzer(app, region, null, undefined, {
    WorkerCtor: SerializedHangThenHealthyWorker,
  });
  assert.ok(analyzer);

  const [res1, res2] = await Promise.allSettled([
    analyzer(0x2000n, 0x201cn, { perFunctionBudgetMs: 35, yieldBetweenFunctions: false }),
    analyzer(0x3000n, 0x301cn, { perFunctionBudgetMs: 1500, yieldBetweenFunctions: false }),
  ]);

  assert.equal(res1.status, 'rejected', 'hanging call #1 must reject on perFunctionBudgetMs');
  assert.equal(res1.reason?.name, 'AbortError');
  assert.equal(res1.reason?.reason, PER_FUNCTION_BUDGET_EXCEEDED_REASON);

  assert.equal(res2.status, 'fulfilled', 'queued sibling call #2 must complete cleanly on a fresh worker');
  assert.ok(res2.value, 'sibling call #2 must return semantic model');
  assert.equal(res2.value.name, 'xor_crypt');
  assert.equal(res2.value.instructions.length, 7);

  assert.equal(spawnedWorkers.length, 2, 'must spawn a fresh worker for queued call #2 after worker #1 is terminated');
  assert.deepEqual(spawnedWorkers[0].receivedAddrs, [0x2000n], 'FIFO queue must not dispatch call #2 to worker #1 while call #1 is active');
  assert.equal(spawnedWorkers[0].terminated, true, 'worker #1 must be terminated when call #1 times out');
  assert.deepEqual(spawnedWorkers[1].receivedAddrs, [0x3000n], 'fresh worker #2 must receive queued call #2');
  assert.equal(spawnedWorkers[1].terminated, false, 'worker #2 should remain alive until dispose()');

  analyzer.dispose();
  assert.equal(spawnedWorkers[1].terminated, true);
});

test('pinpoint worker queued abort, abortable collectWorkerRows, and parentSignal listener cleanup on dispose', async () => {
  const region = { id: 'text', vmAddr: 0x1000n, size: 0x4000n };

  // Case 1: Aborting a queued entry does not terminate the active worker.
  {
    const backend = createArm64CryptoBackend(region);
    const { app } = createPinpointFixture(region, backend);
    const spawnedWorkers = [];
    let releaseFirst = null;
    class DeferredFirstWorker {
      constructor() {
        this.terminated = false;
        this.receivedAddrs = [];
        this.listeners = new Map();
        spawnedWorkers.push(this);
      }
      addEventListener(type, fn) {
        if (!this.listeners.has(type)) this.listeners.set(type, new Set());
        this.listeners.get(type).add(fn);
      }
      postMessage(msg) {
        const clonedIn = structuredClone(msg);
        this.receivedAddrs.push(clonedIn.addr);
        const finish = async () => {
          const res = await handlePinpointWorkerMessage(clonedIn);
          if (this.terminated) return;
          const clonedOut = structuredClone(res);
          for (const fn of this.listeners.get('message') || []) fn({ data: clonedOut });
        };
        if (clonedIn.addr === 0x3000n && !releaseFirst) {
          releaseFirst = finish;
          return;
        }
        Promise.resolve().then(finish);
      }
      terminate() {
        this.terminated = true;
      }
    }

    const queuedAbort = new AbortController();
    const analyzer = makePinpointAnalyzer(app, region, null, undefined, {
      WorkerCtor: DeferredFirstWorker,
    });
    const p1 = analyzer(0x3000n, 0x301cn, { perFunctionBudgetMs: 1500, yieldBetweenFunctions: false });
    const p2 = analyzer(0x2000n, 0x201cn, { signal: queuedAbort.signal, perFunctionBudgetMs: 1500, yieldBetweenFunctions: false });
    await new Promise((r) => setTimeout(r, 10));
    queuedAbort.abort('queued-cancelled');

    await assert.rejects(() => p2, (err) => err?.name === 'AbortError' && err?.reason === 'queued-cancelled');
    assert.equal(spawnedWorkers.length, 1);
    assert.equal(spawnedWorkers[0].terminated, false, 'aborting a queued entry must NOT terminate the active worker');
    assert.deepEqual(spawnedWorkers[0].receivedAddrs, [0x3000n]);

    releaseFirst();
    const model1 = await p1;
    assert.equal(model1?.name, 'xor_crypt');
    analyzer.dispose();
  }

  // Case 2: collectWorkerRows aborts promptly and invokes fetchChunk.cancel()
  {
    let cancelCalls = 0;
    const hangingBackend = {
      fetchChunk() {
        const promise = new Promise(() => {});
        promise.cancel = () => { cancelCalls++; };
        return promise;
      },
    };
    const { app } = createPinpointFixture(region, hangingBackend);
    class NoopWorker {
      addEventListener() {}
      postMessage() {}
      terminate() {}
    }
    const controller = new AbortController();
    const analyzer = makePinpointAnalyzer(app, region, null, undefined, { WorkerCtor: NoopWorker });
    setTimeout(() => controller.abort('fetch-aborted'), 15);
    const t0 = performance.now();
    await assert.rejects(
      () => analyzer(0x3000n, 0x301cn, { signal: controller.signal, perFunctionBudgetMs: 5000 }),
      (err) => err?.name === 'AbortError' && err?.reason === 'fetch-aborted',
    );
    assert.ok(performance.now() - t0 < 500, 'collectWorkerRows must reject immediately on abort');
    assert.equal(cancelCalls, 1, 'collectWorkerRows must invoke request.cancel() on abort');
    analyzer.dispose();
  }

  // Case 3: analyzer.dispose() removes parentSignal abort listener
  {
    const backend = createArm64CryptoBackend(region);
    const { app } = createPinpointFixture(region, backend);
    const added = [];
    const removed = [];
    const parentSignal = {
      aborted: false,
      reason: undefined,
      addEventListener(type, fn) { added.push([type, fn]); },
      removeEventListener(type, fn) { removed.push([type, fn]); },
    };
    class NoopWorker {
      addEventListener() {}
      postMessage() {}
      terminate() {}
    }
    const analyzer = makePinpointAnalyzer(app, region, parentSignal, undefined, { WorkerCtor: NoopWorker });
    assert.equal(added.length, 1);
    assert.equal(added[0][0], 'abort');
    analyzer.dispose();
    assert.equal(removed.length, 1);
    assert.equal(removed[0][0], 'abort');
    assert.equal(removed[0][1], added[0][1], 'dispose() must remove the exact registered onParentAbort listener');
  }
});
