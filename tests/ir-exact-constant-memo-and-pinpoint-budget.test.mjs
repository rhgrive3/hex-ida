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
