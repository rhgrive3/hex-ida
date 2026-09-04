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

const withVersionGetter = (property, getter) => {
  const input = { ...valid };
  Object.defineProperty(input, property, {
    enumerable: true,
    configurable: true,
    get: getter,
  });
  return input;
};

let schemaVersionReads = 0;
const driftingSchemaVersion = withVersionGetter('schemaVersion', () => {
  schemaVersionReads += 1;
  return schemaVersionReads === 1 ? ['2'] : SEMANTIC_IR_SCHEMA_VERSION;
});
assert.throws(
  () => createSemanticIrFunction(driftingSchemaVersion),
  /semantic-ir-schema-version-mismatch/,
);
assert.equal(schemaVersionReads, 1);

let canonicalSchemaVersionReads = 0;
const canonicalSchemaVersion = withVersionGetter('schemaVersion', () => {
  canonicalSchemaVersionReads += 1;
  return SEMANTIC_IR_SCHEMA_VERSION;
});
assert.equal(
  createSemanticIrFunction(canonicalSchemaVersion).schemaVersion,
  SEMANTIC_IR_SCHEMA_VERSION,
);
assert.equal(canonicalSchemaVersionReads, 1);

let contractVersionReads = 0;
const driftingContractVersion = new Proxy({ ...valid, contractVersion: null }, {
  get(target, property, receiver) {
    if (property === 'contractVersion') {
      contractVersionReads += 1;
      return contractVersionReads === 1 ? ['2.0.0'] : SEMANTIC_IR_CONTRACT_VERSION;
    }
    return Reflect.get(target, property, receiver);
  },
});
assert.throws(
  () => createSemanticIrFunction(driftingContractVersion),
  /semantic-ir-contract-version-mismatch/,
);
assert.equal(contractVersionReads, 1);

console.log('issue 3604 semantic IR function version type boundary: PASS');
