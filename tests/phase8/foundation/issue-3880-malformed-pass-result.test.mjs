import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PHASE8_CONTRACT_VERSION,
  createPassDescriptor,
  isCanonicalPassResult,
  createPassResult,
  unchangedResult,
} from '../../../js/decompiler/phase8/contract.js';
import { createAnalysisState, runPassTransaction } from '../../../js/decompiler/phase8/transaction.js';

const PASS_ID = 'issue-3880-malformed-pass-result';

function descriptor(produces = []) {
  return createPassDescriptor({
    id: PASS_ID,
    version: '1',
    stage: 'scalar-optimization',
    produces,
  });
}

function malformedPass(value, ownDescriptor = descriptor()) {
  return {
    descriptor: ownDescriptor,
    run() { return value; },
  };
}

function assertMalformedRefused(value) {
  const state = createAnalysisState({});
  const before = state.snapshot();
  let outcome;

  assert.doesNotThrow(() => {
    outcome = runPassTransaction(state, malformedPass(value));
  });
  assert.equal(outcome.committed, false);
  assert.equal(outcome.result, null);
  assert.equal(outcome.stopReason, `malformed-result:${PASS_ID}`);
  assert.deepEqual(outcome.staged, []);
  assert.deepEqual(outcome.invalidated, []);
  assert.deepEqual(state.snapshot(), before);
}

test('null, primitives, arrays and empty objects are refused without escaping the transaction', async (t) => {
  for (const [name, value] of [
    ['null', null],
    ['undefined', undefined],
    ['boolean', true],
    ['number', 1],
    ['string', 'x'],
    ['array', []],
    ['empty object', {}],
  ]) {
    await t.test(name, () => assertMalformedRefused(value));
  }
});

test('contract and required result fields must have their canonical outer shape', async (t) => {
  const ownDescriptor = descriptor();
  const canonical = unchangedResult(ownDescriptor);
  const malformed = [
    ['stale contract', { ...canonical, contractVersion: PHASE8_CONTRACT_VERSION - 1 }],
    ['missing pass id', { ...canonical, passId: null }],
    ['non-boolean changed', { ...canonical, changed: 'false' }],
    ['produced null', { ...canonical, produced: null }],
    ['invalidated object', { ...canonical, invalidated: {} }],
    ['transforms null', { ...canonical, transforms: null }],
    ['diagnostics object', { ...canonical, diagnostics: {} }],
    ['preserved null', { ...canonical, preserved: null }],
    ['unknown status', { ...canonical, status: 'bogus' }],
    ['unknown completeness', { ...canonical, completeness: 'bogus' }],
    ['unknown stage', { ...canonical, stage: 'bogus' }],
    ['hostile produced element', { ...canonical, produced: [{ toString() { throw new Error('hostile'); } }] }],
    ['hostile invalidated element', { ...canonical, invalidated: [{ toString() { throw new Error('hostile'); } }] }],
    ['unknown analysis in produced', { ...canonical, produced: ['not-an-analysis-key'] }],
    ['malformed diagnostics element', { ...canonical, diagnostics: [{ severity: 'error', code: 'err', message: 123 }] }],
    ['malformed transforms element', { ...canonical, transforms: [{ kind: 'x', proof: 'y', targets: [123] }] }],
    ['status changed contradiction', { ...canonical, status: 'unchanged', changed: true }],
  ];

  for (const [name, value] of malformed) {
    await t.test(name, () => assertMalformedRefused(value));
  }
});

test('throwing result accessors are contained by the malformed-result boundary', () => {
  const value = {};
  Object.defineProperty(value, 'contractVersion', {
    get() { throw new Error('hostile getter'); },
  });
  assertMalformedRefused(value);
});

test('staged work is discarded when the pass returns a malformed result', () => {
  const state = createAnalysisState({});
  const before = state.snapshot();
  const ownDescriptor = descriptor(['ranges']);
  const pass = {
    descriptor: ownDescriptor,
    run(_context, _budget, staging) {
      staging.stage('ranges', Object.freeze({ min: 0, max: 1, completeness: 'complete' }));
      return null;
    },
  };

  let outcome;
  assert.doesNotThrow(() => {
    outcome = runPassTransaction(state, pass);
  });
  assert.equal(outcome.committed, false);
  assert.equal(outcome.stopReason, `malformed-result:${PASS_ID}`);
  assert.deepEqual(outcome.staged, []);
  assert.deepEqual(outcome.invalidated, []);
  assert.deepEqual(state.snapshot(), before);
  assert.equal(state.version('ranges'), 0);
  assert.equal(state.get('ranges'), null);
});

test('pass throws keep the existing failed result semantics', () => {
  const state = createAnalysisState({});
  const ownDescriptor = descriptor();
  const pass = {
    descriptor: ownDescriptor,
    run() { throw new Error('boom'); },
  };

  const outcome = runPassTransaction(state, pass);
  assert.equal(outcome.committed, false);
  assert.equal(outcome.stopReason, 'failed:boom');
});

test('canonical pass results still commit normally', () => {
  const state = createAnalysisState({});
  const ownDescriptor = descriptor(['ranges']);
  const value = Object.freeze({ min: -1, max: 4, completeness: 'complete' });
  const pass = {
    descriptor: ownDescriptor,
    run(_context, _budget, staging) {
      staging.stage('ranges', value);
      return createPassResult({
        descriptor: ownDescriptor,
        status: 'changed',
        completeness: 'complete',
        produced: ['ranges'],
      });
    },
  };

  const outcome = runPassTransaction(state, pass);
  assert.equal(outcome.committed, true);
  assert.equal(outcome.stopReason, null);
  assert.equal(state.version('ranges'), 1);
  assert.equal(state.get('ranges'), value);
});

test('staged work is discarded and transaction does not throw when pass returns a hostile element in produced', () => {
  const state = createAnalysisState({});
  const before = state.snapshot();
  const ownDescriptor = descriptor(['ranges']);
  const canonical = unchangedResult(ownDescriptor);
  const pass = {
    descriptor: ownDescriptor,
    run(_context, _budget, staging) {
      staging.stage('ranges', Object.freeze({ min: 0, max: 1, completeness: 'complete' }));
      return {
        ...canonical,
        produced: [{ toString() { throw new Error('hostile'); } }],
      };
    },
  };

  let outcome;
  assert.doesNotThrow(() => {
    outcome = runPassTransaction(state, pass);
  });
  assert.equal(outcome.committed, false);
  assert.equal(outcome.stopReason, `malformed-result:${PASS_ID}`);
  assert.deepEqual(outcome.staged, []);
  assert.deepEqual(outcome.invalidated, []);
  assert.deepEqual(state.snapshot(), before);
  assert.equal(state.version('ranges'), 0);
  assert.equal(state.get('ranges'), null);
});

test('stateful produced accessor cannot validate one value and drift before commit', () => {
  const state = createAnalysisState({});
  const before = state.snapshot();
  const ownDescriptor = descriptor(['ranges']);
  const canonical = createPassResult({
    descriptor: ownDescriptor,
    status: 'changed',
    completeness: 'complete',
    produced: ['ranges'],
    transforms: [{
      kind: 'test-transform',
      targets: ['node:1'],
      proof: 'issue-3880-stateful-produced',
    }],
  });
  let reads = 0;
  const hostile = { ...canonical };
  Object.defineProperty(hostile, 'produced', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return reads <= 4 ? ['ranges'] : null;
    },
  });

  const pass = {
    descriptor: ownDescriptor,
    run(_context, _budget, staging) {
      staging.stage('ranges', Object.freeze({ min: 0, max: 1, completeness: 'complete' }));
      return hostile;
    },
  };

  let outcome;
  assert.doesNotThrow(() => {
    outcome = runPassTransaction(state, pass);
  });
  assert.equal(outcome.committed, false);
  assert.equal(outcome.result, null);
  assert.equal(outcome.stopReason, `malformed-result:${PASS_ID}`);
  assert.equal(reads, 0, 'accessor-backed result fields must be rejected without invocation');
  assert.deepEqual(outcome.staged, []);
  assert.deepEqual(outcome.invalidated, []);
  assert.deepEqual(state.snapshot(), before);
  assert.equal(state.version('ranges'), 0);
  assert.equal(state.get('ranges'), null);
});


test('shared result graphs are bounded and rejected as malformed', () => {
  let node = {};
  for (let depth = 0; depth < 40; depth += 1) node = { a: node, b: node };
  assertMalformedRefused({ ...unchangedResult(descriptor()), extra: node });
});

test('nested functions and unknown transform fields cannot escape the owned result snapshot', () => {
  const ownDescriptor = descriptor(['ranges']);
  const candidates = [
    {
      ...unchangedResult(ownDescriptor),
      diagnostics: [{ severity: 'info', code: 'function', message: () => 'not-data', reason: null }],
    },
    {
      ...createPassResult({
        descriptor: ownDescriptor,
        status: 'changed',
        completeness: 'complete',
        produced: ['ranges'],
      }),
      // The hostile transform must be assigned after canonicalization: the
      // constructor intentionally drops unknown fields such as `details`.
      transforms: [{ kind: 'transform', proof: 'nested-function', targets: ['node'], details: { hook() {} } }],
    },
  ];

  for (const candidate of candidates) assertMalformedRefused(candidate);
});

test('shared diagnostic DAGs are memoized while permitted result graphs stay bounded', () => {
  const shared = Object.freeze({ severity: 'info', code: 'shared-dag', message: 'bounded', reason: null });
  const candidate = {
    ...unchangedResult(descriptor()),
    diagnostics: [shared, shared],
  };

  assert.equal(isCanonicalPassResult(candidate), true);
});

test('oversized permitted diagnostic graphs are refused by property and edge budgets', () => {
  const ownDescriptor = descriptor(['ranges']);
  const diagnostics = [];
  for (let index = 0; index < 10_001; index += 1) {
    diagnostics.push({ severity: 'info', code: `node-${index}`, message: 'bounded' });
  }
  assertMalformedRefused(createPassResult({
    descriptor: ownDescriptor,
    status: 'changed',
    completeness: 'complete',
    produced: ['ranges'],
    diagnostics,
  }));
});

test('large unknown top-level properties are rejected before recursive copying', () => {
  const candidate = { ...unchangedResult(descriptor()) };
  for (let index = 0; index < 12_000; index += 1) candidate[`unknown${index}`] = index;
  let reads = 0;
  Object.defineProperty(candidate, 'tripwire', {
    enumerable: true,
    get() {
      reads += 1;
      throw new Error('nested unknown property was copied');
    },
  });

  assertMalformedRefused(candidate);
  assert.equal(reads, 0, 'top-level allowlisting must precede recursive cloning');
});

test('small unknown top-level properties are rejected before recursive copying', () => {
  const candidate = { ...unchangedResult(descriptor()), unknown: 1 };
  let reads = 0;
  Object.defineProperty(candidate, 'tripwire', {
    enumerable: true,
    get() {
      reads += 1;
      throw new Error('nested unknown property was copied');
    },
  });

  assertMalformedRefused(candidate);
  assert.equal(reads, 0, 'top-level allowlisting must precede recursive cloning');
});

test('array length is bounded before own-key enumeration', () => {
  const target = [];
  Object.defineProperty(target, 'length', { value: 10_001 });
  let enumerated = 0;
  const hostile = new Proxy(target, {
    ownKeys() {
      enumerated += 1;
      throw new Error('array keys were enumerated before the length budget');
    },
  });

  assertMalformedRefused({
    ...unchangedResult(descriptor()),
    diagnostics: [hostile],
  });
  assert.equal(enumerated, 0, 'array length must be checked before Reflect.ownKeys');
});

test('the public validator rejects accessor-backed fields without invoking them', () => {
  const candidate = { ...unchangedResult(descriptor()) };
  let reads = 0;
  Object.defineProperty(candidate, 'contractVersion', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return PHASE8_CONTRACT_VERSION;
    },
  });

  assert.equal(isCanonicalPassResult(candidate), false);
  assert.equal(reads, 0);
});
