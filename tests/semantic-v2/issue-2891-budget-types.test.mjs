import assert from 'node:assert/strict';
import { createSemanticSsaContract } from '../../js/semantics/ssa/contract.js';
import { validateSemanticSsa } from '../../js/semantics/ssa/validate.js';

const base = Object.freeze({
  contractVersion:'2.0.0',
  functionId:'fn-budget',
  definitions:[],
  uses:[],
});

const malformed = [
  '1',
  ['1'],
  true,
  { valueOf() { return 1; } },
];

for (const key of ['maxDefinitions', 'maxUses', 'maxLinks']) {
  for (const value of malformed) {
    assert.throws(
      () => createSemanticSsaContract(base, { budget:{ [key]:value } }),
      new RegExp(`semantic-ssa-invalid-budget-${key}`),
      `${key} must reject implicit numeric coercion`,
    );
  }
  assert.doesNotThrow(() => createSemanticSsaContract(base, { budget:{ [key]:1 } }));
}

for (const value of malformed) {
  assert.throws(
    () => validateSemanticSsa({}, {}, {}, { budget:{ maxWorkItems:value } }),
    /semantic-ssa-invalid-budget-maxWorkItems/,
    'maxWorkItems must reject implicit numeric coercion',
  );
}

for (const value of [0, -1, 1.5, NaN, Infinity]) {
  assert.throws(
    () => createSemanticSsaContract(base, { budget:{ maxDefinitions:value } }),
    /semantic-ssa-invalid-budget-maxDefinitions/,
  );
}

assert.doesNotThrow(() => createSemanticSsaContract(base));
console.log('issue-2891 semantic SSA budget types: PASS');
