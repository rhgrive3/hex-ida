// Regression for #4840: VMEffects validates options.budget.maxValues as a
// non-negative integer (0 = deny-all is legal), while Semantic IR's
// budgetLimit() routed the same key through positiveInteger(), rejecting 0
// with `semantic-ir-invalid-budget-*`. The bridge forwards one shared
// options object across both boundaries, so a budget valid at the VMEffects
// boundary inverted to invalid at the bridge boundary. Semantic IR budget
// limits now share the non-negative domain; the shared positive-integer
// contract for non-budget fields stays strictly positive.
import assert from 'node:assert/strict';

import {
  createVMEffectBundle,
  createVMEffectFunction,
} from '../js/managed/shared/vm-effects.js';
import { lowerVMEffectsToSemanticIr } from '../js/managed/shared/bridge-v2.js';
import { budgetLimit, positiveInteger } from '../js/semantics/ir/common.js';
import { createSemanticMachineType } from '../js/semantics/ir/types.js';

const METHOD_ID = 'managed-method:m4840';
const ZERO_MAX_VALUES = { budget: { maxValues: 0 } };

function constBundle(offset, constant) {
  return createVMEffectBundle({
    frontendId: 'wasm',
    methodId: METHOD_ID,
    operationId: `op:${offset}`,
    bytecodeOffset: offset,
    opcode: 0x41,
    mnemonic: 'i32.const',
    producedValues: [{ bits: 32, constant }],
    completeness: 'exact',
  });
}

function vmFunction(bundles, options = {}) {
  return createVMEffectFunction({
    methodId: METHOD_ID,
    frontendId: 'wasm',
    bundles,
    aggregateCompleteness: 'exact',
  }, options);
}

assert.doesNotThrow(
  () => vmFunction([], ZERO_MAX_VALUES),
  'VMEffects must keep maxValues:0 valid',
);
assert.doesNotThrow(() => vmFunction([constBundle(0, 1)]));
assert.throws(
  () => vmFunction([constBundle(0, 1)], { budget: { maxValues: -1 } }),
  /vm-effect-invalid-budget-maxValues/,
);
assert.throws(
  () => vmFunction([constBundle(0, 1)], ZERO_MAX_VALUES),
  /vm-effect-resource-limit-values/,
);

for (const key of ['maxValues', 'maxNodes', 'maxBlocks', 'maxReferences']) {
  assert.equal(budgetLimit({ budget: { [key]: 0 } }, key), 0);
}
assert.equal(budgetLimit({ budget: { maxValues: 5 } }, 'maxValues'), 5);
for (const invalid of ['1', ['1'], true, 0n, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
  assert.throws(
    () => budgetLimit({ budget: { maxValues: invalid } }, 'maxValues'),
    /semantic-ir-invalid-budget-maxValues/,
  );
}

assert.equal(positiveInteger(1, 'kept-strictly-positive'), 1);
assert.throws(() => positiveInteger(0, 'kept-strictly-positive'), /kept-strictly-positive/);
assert.throws(
  () => createSemanticMachineType({ kind: 'bitvector', widthBits: 0 }),
  /semantic-ir-invalid-width/,
);

const emptyLowered = lowerVMEffectsToSemanticIr(vmFunction([]), ZERO_MAX_VALUES);
assert.equal(emptyLowered.semanticIr.values.length, 0);

assert.throws(
  () => lowerVMEffectsToSemanticIr(vmFunction([constBundle(0, 1)]), ZERO_MAX_VALUES),
  /semantic-ir-budget-exceeded-maxValues/,
);
assert.equal(
  lowerVMEffectsToSemanticIr(vmFunction([constBundle(0, 1)]), { budget: { maxValues: 1 } })
    .semanticIr.values.length,
  1,
);
assert.throws(
  () => lowerVMEffectsToSemanticIr(
    vmFunction([constBundle(0, 1), constBundle(2, 2)]),
    { budget: { maxValues: 1 } },
  ),
  /semantic-ir-budget-exceeded-maxValues/,
);

console.log('issue #4840 semantic IR budget zero domain: PASS');
