import assert from 'node:assert/strict';
import {
  SEMANTIC_IR_CONTRACT_VERSION,
  SEMANTIC_IR_SCHEMA_VERSION,
} from '../../js/semantics/ir/common.js';
import { createSemanticIrFunction } from '../../js/semantics/ir/function.js';

const valid = Object.freeze({
  functionId: 'function-3604',
  entryBlockId: 'entry',
  blocks: [{ id: 'entry', nodeIds: [] }],
  values: [],
  nodes: [],
  origin: { instructionIds: ['instruction-3604'] },
});

const create = (overrides = {}) => createSemanticIrFunction({ ...valid, ...overrides });

assert.equal(create().schemaVersion, SEMANTIC_IR_SCHEMA_VERSION);
assert.equal(create().contractVersion, SEMANTIC_IR_CONTRACT_VERSION);
assert.equal(create({ schemaVersion: null }).schemaVersion, SEMANTIC_IR_SCHEMA_VERSION);
assert.equal(create({ contractVersion: null }).contractVersion, SEMANTIC_IR_CONTRACT_VERSION);
assert.equal(create({ schemaVersion: 2 }).schemaVersion, SEMANTIC_IR_SCHEMA_VERSION);
assert.equal(create({ contractVersion: '2.0.0' }).contractVersion, SEMANTIC_IR_CONTRACT_VERSION);

for (const schemaVersion of [['2'], '2', true, 2n, new Number(2), 3]) {
  assert.throws(
    () => create({ schemaVersion }),
    /semantic-ir-schema-version-mismatch/,
  );
}

for (const contractVersion of [['2.0.0'], 2, true, new String('2.0.0'), '3.0.0']) {
  assert.throws(
    () => create({ contractVersion }),
    /semantic-ir-contract-version-mismatch/,
  );
}

let coercionCalls = 0;
const coercibleSchemaVersion = {
  valueOf() { coercionCalls += 1; return 2; },
  toString() { coercionCalls += 1; return '2'; },
};
assert.throws(
  () => create({ schemaVersion: coercibleSchemaVersion }),
  /semantic-ir-schema-version-mismatch/,
);
assert.equal(coercionCalls, 0);

const coercibleContractVersion = {
  valueOf() { coercionCalls += 1; return '2.0.0'; },
  toString() { coercionCalls += 1; return '2.0.0'; },
};
assert.throws(
  () => create({ contractVersion: coercibleContractVersion }),
  /semantic-ir-contract-version-mismatch/,
);
assert.equal(coercionCalls, 0);

console.log('issue 3604 semantic IR function version type boundary: PASS');
