import assert from 'node:assert/strict';

import { createIntrinsicEffectSummary, createMachineOperation } from '../../js/semantics/effects/index.js';

const ACCESS = Object.freeze({
  space: 'memory',
  addressExpr: { kind:'bitvector', widthBits:64, value:'4096' },
  widthBits: 8,
  endian: 'little',
});

function summary(memoryRead, memoryWrite = { scope:'none' }) {
  return {
    inputs: [],
    outputs: [],
    registersRead: [],
    registersWritten: [],
    memoryRead,
    memoryWrite,
    controlEffects: [],
    determinism: 'deterministic',
    symbolicDetail: 'summary-only',
  };
}

// #4494: raw memory-access cardinality is bounded before any nested access
// normalization takes place.
const atDefaultLimit = createIntrinsicEffectSummary(summary({
  scope: 'accesses',
  accesses: Array.from({ length:4096 }, () => ACCESS),
}));
assert.equal(atDefaultLimit.memoryRead.accesses.length, 4096);

assert.throws(
  () => createIntrinsicEffectSummary(summary({
    scope: 'accesses',
    accesses: Array.from({ length:4097 }, () => ACCESS),
  })),
  /machine-effects-budget-exceeded-maxIntrinsicMemoryAccesses/,
);

const tightBudget = { budget:{ maxIntrinsicMemoryAccesses:1 } };
assert.doesNotThrow(() => createIntrinsicEffectSummary(summary({
  scope: 'accesses',
  accesses: [ACCESS],
}, { scope:'accesses', accesses:[ACCESS] }), tightBudget));
const operation = createMachineOperation({
  kind: 'intrinsic',
  intrinsicId: 'audit.bounded-memory',
  effectSummary: summary({ scope:'accesses', accesses:[ACCESS] }, { scope:'accesses', accesses:[ACCESS] }),
}, tightBudget);
assert.equal(operation.effectSummary.memoryRead.accesses.length, 1);
assert.equal(operation.effectSummary.memoryWrite.accesses.length, 1);

// The bounded intrinsic path must retain ordering only when atomicity is
// proven; the raw-list budget must still apply before nested normalization.
const orderedAccess = Object.freeze({ ...ACCESS, atomic:true, ordering:'acquire' });
const orderedSummary = createIntrinsicEffectSummary(summary(
  { scope:'accesses', accesses:[orderedAccess] },
  { scope:'accesses', accesses:[orderedAccess] },
), tightBudget);
assert.equal(orderedSummary.memoryRead.accesses[0].atomic, true);
assert.equal(orderedSummary.memoryRead.accesses[0].ordering, 'acquire');
assert.equal(orderedSummary.memoryWrite.accesses[0].atomic, true);
assert.equal(orderedSummary.memoryWrite.accesses[0].ordering, 'acquire');

const orderedOperation = createMachineOperation({
  kind: 'intrinsic',
  intrinsicId: 'audit.bounded-ordered-memory',
  effectSummary: summary(
    { scope:'accesses', accesses:[orderedAccess] },
    { scope:'accesses', accesses:[orderedAccess] },
  ),
}, tightBudget);
assert.equal(orderedOperation.effectSummary.memoryRead.accesses[0].ordering, 'acquire');
assert.equal(orderedOperation.effectSummary.memoryWrite.accesses[0].ordering, 'acquire');

const unprovenOrderedAccess = { ...ACCESS, ordering:'acquire' };
assert.throws(
  () => createIntrinsicEffectSummary(summary(
    { scope:'accesses', accesses:[unprovenOrderedAccess] },
    { scope:'accesses', accesses:[unprovenOrderedAccess] },
  ), tightBudget),
  /machine-effects-ordering-requires-atomic-access/,
);
assert.throws(
  () => createIntrinsicEffectSummary(summary(
    { scope:'none' },
    { scope:'accesses', accesses:[unprovenOrderedAccess] },
  ), tightBudget),
  /machine-effects-ordering-requires-atomic-access/,
);
assert.throws(
  () => createIntrinsicEffectSummary(summary({
    scope: 'accesses',
    accesses: [ACCESS, ACCESS],
  }), tightBudget),
  /machine-effects-budget-exceeded-maxIntrinsicMemoryAccesses/,
);
assert.throws(
  () => createIntrinsicEffectSummary(summary({ scope:'none' }, {
    scope: 'accesses',
    accesses: [ACCESS, ACCESS],
  }), tightBudget),
  /machine-effects-budget-exceeded-maxIntrinsicMemoryAccesses/,
);

// A limit failure must win before an over-limit invalid element is visited.
const invalidAccess = { ...ACCESS, widthBits:0 };
assert.throws(
  () => createIntrinsicEffectSummary(summary({
    scope: 'accesses',
    accesses: [ACCESS, invalidAccess],
  }), tightBudget),
  /machine-effects-budget-exceeded-maxIntrinsicMemoryAccesses/,
);

for (const scope of ['none', 'all', 'unknown']) {
  const memory = scope === 'all' ? { scope, spaces:['memory'] } : { scope };
  const normalized = createIntrinsicEffectSummary(summary(memory, memory));
  assert.equal(normalized.memoryRead.scope, scope);
  assert.equal(normalized.memoryWrite.scope, scope);
}

console.log('issue-4494 intrinsic memory access budget: PASS');
