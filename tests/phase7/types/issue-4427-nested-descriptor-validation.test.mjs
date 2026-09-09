import assert from 'node:assert/strict';
import test from 'node:test';

import { createTypeClaim } from '../../../js/analysis/types/constraints.js';
import { TypeConstraintGraph } from '../../../js/analysis/types/graph.js';

const integer32 = Object.freeze({ kind: 'integer', name: 'int32', widthBits: 32 });

function structuralClaim(descriptor) {
  return {
    layer: 'structural',
    entityId: 'issue-4427-entity',
    descriptor,
  };
}

function createNestedClaim(nested) {
  return createTypeClaim(structuralClaim({
    offset: 0,
    sizeBytes: 32,
    memberType: nested,
  }));
}

test('#4427 rejects invalid numeric facts at every nested type depth', () => {
  const cases = [
    [{ kind: 'array', strideBytes: -4, length: 2, elementType: integer32 }, 'structural-stride-invalid'],
    [{ kind: 'array', strideBytes: 0, length: 2, elementType: integer32 }, 'structural-stride-invalid'],
    [{ kind: 'array', strideBytes: 4, length: -1, elementType: integer32 }, 'structural-length-invalid'],
    [{ kind: 'array', strideBytes: 4, length: 2, elementType: { kind: 'integer', sizeBytes: 0 } }, 'structural-size-invalid'],
    [{ kind: 'pointer', pointeeType: { kind: 'integer', alignBytes: -8 } }, 'structural-align-invalid'],
    [{
      kind: 'struct',
      members: [{ offset: -1, sizeBytes: 4, memberType: integer32 }],
    }, 'structural-offset-invalid'],
    [{
      kind: 'struct',
      members: [{ offset: 0, sizeBytes: 4, memberType: {
        kind: 'array',
        strideBytes: 4,
        length: 2,
        elementType: { kind: 'struct', members: [{ offset: 0, sizeBytes: -1 }] },
      } }],
    }, 'structural-size-invalid'],
  ];

  for (const [nested, error] of cases) {
    assert.throws(() => createNestedClaim(nested), new RegExp(error));
  }
});

test('#4427 rejects invalid nested hard evidence before it can become certain', () => {
  const graph = new TypeConstraintGraph({ snapshotId: 'issue-4427-snapshot' });
  assert.throws(() => graph.addHardConstraint({
    kind: 'debug-type',
    origin: 'debug-matched',
    claim: structuralClaim({
      offset: 0,
      sizeBytes: 8,
      memberType: {
        kind: 'array',
        strideBytes: 8,
        length: 2,
        elementType: { kind: 'integer', widthBits: 32, length: -1 },
      },
    }),
  }), /structural-length-invalid/);
  assert.deepEqual(graph.entityIds(), []);
});

test('#4427 rejects cyclic nested descriptor objects before recursive validation', () => {
  const nested = { kind: 'array', strideBytes: 8, length: 1 };
  nested.elementType = nested;
  assert.throws(() => createNestedClaim(nested), /type-claim-descriptor-cycle/);
});

test('#4427 preserves valid recursive nested descriptors and numeric spellings', () => {
  const graph = new TypeConstraintGraph({ snapshotId: 'issue-4427-valid-snapshot' });
  graph.addHardConstraint({
    kind: 'debug-type',
    origin: 'debug-matched',
    claim: structuralClaim({
      offset: '0',
      sizeBytes: '32',
      alignBytes: '8',
      memberType: {
        kind: 'struct',
        members: [{
          offset: '0',
          sizeBytes: '16',
          alignBytes: '8',
          memberType: {
            kind: 'array',
            strideBytes: '8',
            length: '2',
            elementType: {
              kind: 'pointer',
              targetEntityId: 'issue-4427-entity',
              pointeeType: { kind: 'integer', widthBits: '64' },
            },
          },
        }],
      },
    }),
  });

  const result = graph.solveEntity('issue-4427-entity');
  assert.equal(result.status.completeness, 'complete');
  assert.equal(result.layers.structural.confidence, 'certain');
  assert.equal(result.layers.structural.selected.descriptor.members[0].memberType.kind, 'struct');
  assert.equal(
    result.layers.structural.selected.descriptor.members[0].memberType.members[0].memberType.length,
    '2',
  );
  assert.equal(
    result.layers.structural.selected.descriptor.members[0].memberType.members[0].memberType.elementType.targetEntityId,
    'issue-4427-entity',
  );
});
