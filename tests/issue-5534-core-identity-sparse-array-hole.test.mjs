import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createEntityId,
  createEvidenceId,
  IDENTITY_SCHEMA_VERSION,
  lossyTypeWitness,
  stableStringify,
} from '../js/core/identity/index.js';

const entityBase = Object.freeze({ binaryId: 'bin-test', kind: 'sparse-array' });
const evidenceBase = Object.freeze({ binaryId: 'bin-test', kind: 'sparse-array' });

function idFor(factory, base, identity) {
  return factory({ ...base, identity });
}

test('#5534 sparse array holes carry an identity witness instead of aliasing null', () => {
  const sparse = new Array(1);
  const explicitNull = [null];

  // jsonSafe intentionally remains JSON-compatible; the type witness is the
  // compatibility-preserving discriminator for values that JSON collapses.
  assert.equal(stableStringify(sparse), stableStringify(explicitNull));
  assert.deepEqual(lossyTypeWitness(sparse), [['[0]', 'array-hole']]);
  assert.equal(lossyTypeWitness(explicitNull), null);

  for (const [label, factory, base] of [
    ['entity', createEntityId, entityBase],
    ['evidence', createEvidenceId, evidenceBase],
  ]) {
    assert.notEqual(
      idFor(factory, base, sparse),
      idFor(factory, base, explicitNull),
      `${label} sparse hole must not alias explicit null`,
    );
    assert.notEqual(
      idFor(factory, base, [, 1]),
      idFor(factory, base, [null, 1]),
      `${label} leading sparse hole must remain distinct`,
    );
    assert.notEqual(
      idFor(factory, base, { nested: [1, , 3] }),
      idFor(factory, base, { nested: [1, null, 3] }),
      `${label} nested sparse hole must remain distinct`,
    );
  }
});

test('#5534 existing lossy and dense identity contracts remain stable', () => {
  assert.deepEqual(lossyTypeWitness([undefined]), [['[0]', 'undefined']]);
  const undefinedEntityId = idFor(createEntityId, entityBase, [undefined]);
  const nullEntityId = idFor(createEntityId, entityBase, [null]);
  const holeEntityId = idFor(createEntityId, entityBase, new Array(1));
  assert.equal(
    new Set([undefinedEntityId, nullEntityId, holeEntityId]).size,
    3,
    'hole, explicit undefined, and explicit null must remain three distinct identities',
  );

  assert.equal(
    idFor(createEntityId, entityBase, [1, 2, 3]),
    'entity_1af31619790811f31e4ab65e6a1c5c96',
    'dense JSON-safe EntityId must not move',
  );
  assert.equal(
    idFor(createEvidenceId, evidenceBase, [1, 2, 3]),
    'evidence_c4d3c44a6395b0ec32ec9bcf9130f563',
    'dense JSON-safe EvidenceId must not move',
  );
  assert.equal(IDENTITY_SCHEMA_VERSION, 1, 'existing identity schema version remains valid for witness-only repair');
});

test('#5534 hole detection uses own-index presence, not inherited array values', () => {
  const sparse = new Array(1);
  const prototype = [];
  prototype[0] = null;
  Object.setPrototypeOf(sparse, prototype);

  assert.equal(Object.hasOwn(sparse, 0), false);
  assert.deepEqual(lossyTypeWitness(sparse), [['[0]', 'array-hole']]);
  assert.notEqual(
    idFor(createEntityId, entityBase, sparse),
    idFor(createEntityId, entityBase, [null]),
    'an inherited numeric property must not erase the own-property hole identity',
  );
});
