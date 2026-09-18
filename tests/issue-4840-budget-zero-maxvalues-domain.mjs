import assert from 'node:assert/strict';
import {
  createVMEffectBudgetTracker,
  createVMEffectBundle,
  createVMEffectFunction,
} from '../js/managed/shared/vm-effects.js';
import { lowerVMEffectsToSemanticIr } from '../js/managed/shared/bridge-v2.js';
import { budgetLimit } from '../js/semantics/ir/common.js';
import { createSemanticIrFunction } from '../js/semantics/ir/index.js';

const zeroBudget = { budget: { maxValues: 0 } };
const methodId = 'managed-method:m';

function emptyFunction() {
  return createVMEffectFunction({
    methodId,
    frontendId: 'wasm',
    bundles: [],
    aggregateCompleteness: 'exact',
  }, zeroBudget);
}

function producingFunction() {
  const bundle = createVMEffectBundle({
    frontendId: 'wasm',
    methodId,
    operationId: 'op:m:0',
    bytecodeOffset: 0,
    mnemonic: 'nop',
    producedValues: [{}],
    completeness: 'exact',
  });
  return createVMEffectFunction({
    methodId,
    frontendId: 'wasm',
    bundles: [bundle],
    aggregateCompleteness: 'exact',
  });
}

const origin = { instructionIds: ['issue-4840-instruction'] };
const entryValue = {
  id: 'address',
  kind: 'entry',
  machineType: { kind: 'address', widthBits: 64, addressSpace: 'memory' },
  origin,
};
function irFunction() {
  return {
    schemaVersion: 2,
    contractVersion: '2.0.0',
    functionId: 'function-4840',
    entryBlockId: 'entry',
    blocks: [{ id: 'entry', nodeIds: ['node'], origin }],
    values: [entryValue],
    nodes: [{
      id: 'node',
      kind: 'call',
      blockId: 'entry',
      inputs: ['address'],
      outputs: [],
      call: {
        targetValueIds: [],
        targetEntityIds: [],
        arguments: [],
        returns: [],
        stateReads: [],
        stateWrites: [],
        memoryRead: { scope: 'none' },
        memoryWrite: { scope: 'none' },
        controlEffects: [],
        determinism: 'deterministic',
        noreturn: false,
        mayThrow: false,
        summarySource: 'issue-4840',
        completeness: 'complete',
        unknownEffects: null,
      },
      origin,
    }],
    completeness: 'complete',
    unknowns: [],
    origin,
  };
}

// 1. VMEffects contract: maxValues:0 is a legal explicit deny-all budget.
const vmZero = emptyFunction();
assert.equal(vmZero.bundles.length, 0);
assert.equal(createVMEffectBudgetTracker(zeroBudget).limits.maxValues, 0);
assert.equal(
  budgetLimit({ budget: { maxValues: 0 } }, 'maxValues'),
  0,
  'Semantic IR must accept the same zero budget domain as VMEffects',
);

// 2. The public bridge lowers a no-value function under the same options.
const loweredZero = lowerVMEffectsToSemanticIr(vmZero, zeroBudget);
assert.equal(loweredZero.semanticIr.values.length, 0);
assert.equal(loweredZero.semanticIr.functionId, methodId);

// 3. Zero is deny-all, not invalid: one generated value reports exceeded.
assert.throws(
  () => createVMEffectBudgetTracker(zeroBudget).chargeValues(1),
  /vm-effect-resource-limit-values/,
);
assert.throws(
  () => createVMEffectFunction({
    methodId,
    frontendId: 'wasm',
    bundles: [createVMEffectBundle({
      frontendId: 'wasm',
      methodId,
      operationId: 'op:m:1',
      bytecodeOffset: 0,
      completeness: 'exact',
      producedValues: [{}],
    })],
    aggregateCompleteness: 'exact',
  }, zeroBudget),
  /vm-effect-resource-limit-values/,
);
assert.throws(
  () => createSemanticIrFunction(irFunction(), zeroBudget),
  /semantic-ir-budget-exceeded-maxValues/,
);
assert.throws(
  () => lowerVMEffectsToSemanticIr(producingFunction(), zeroBudget),
  /semantic-ir-budget-exceeded-maxValues/,
);

// 4. Fail-closed domains stay aligned: negative/fractional limits are rejected
//    by both layers with their typed invalid-budget code.
assert.throws(
  () => createVMEffectBudgetTracker({ budget: { maxValues: -1 } }),
  /vm-effect-invalid-budget-maxValues/,
);
for (const invalid of [-1, 1.5, -0.5]) {
  assert.throws(
    () => createVMEffectBudgetTracker({ budget: { maxValues: invalid } }),
    /vm-effect-invalid-budget-maxValues/,
    `VMEffects maxValues=${String(invalid)}`,
  );
}
for (const invalid of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '0', '1', [1]]) {
  assert.throws(
    () => budgetLimit({ budget: { maxValues: invalid } }, 'maxValues'),
    /semantic-ir-invalid-budget-maxValues/,
    `Semantic IR maxValues=${String(invalid)}`,
  );
}

// 5. Positive maxValues behavior is unchanged on both sides of the bridge.
assert.equal(budgetLimit({ budget: { maxValues: 1 } }, 'maxValues'), 1);
assert.equal(budgetLimit({ budget: {} }, 'maxValues'), 262144);
const loweredPositive = lowerVMEffectsToSemanticIr(producingFunction(), { budget: { maxValues: 1 } });
assert.equal(loweredPositive.semanticIr.values.length, 1);
assert.throws(
  () => createSemanticIrFunction({
    ...irFunction(),
    values: [entryValue, { ...entryValue, id: 'address-2' }],
  }, { budget: { maxValues: 1 } }),
  /semantic-ir-budget-exceeded-maxValues/,
);

console.log('issue-4840 managed bridge budget zero maxValues domain: ok');
