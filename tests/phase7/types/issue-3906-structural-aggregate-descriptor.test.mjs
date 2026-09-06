import assert from 'node:assert/strict';
import test from 'node:test';

import { TypeConstraintGraph } from '../../../js/analysis/types/graph.js';

function addField(graph, entityId, { offset, sizeBytes = 4, fieldName, memberType = { kind: 'integer', widthBits: 32 } }) {
  graph.addHardConstraint({
    kind: 'structural-field',
    origin: 'binary-evidence',
    claim: {
      layer: 'structural',
      entityId,
      descriptor: { offset, sizeBytes, fieldName, memberType },
    },
  });
}

function descriptorOf(graph, entityId) {
  const structural = graph.solveEntity(entityId).layers.structural;
  assert.equal(structural.contradictions.length, 0);
  assert.equal(structural.confidence, 'certain');
  assert.ok(structural.selected);
  return structural.selected.descriptor;
}

test('structural field merge keeps member-only metadata off the aggregate root', () => {
  const graph = new TypeConstraintGraph({ snapshotId: 'issue-3906-fields' });
  addField(graph, 'S', { offset: 0, fieldName: 'a' });
  addField(graph, 'S', { offset: 4, fieldName: 'b' });

  const descriptor = descriptorOf(graph, 'S');
  assert.equal(descriptor.kind, 'struct');
  assert.equal(descriptor.sizeBytes, 8);
  assert.equal(descriptor.totalSizeBytes, 8);
  assert.equal(Object.hasOwn(descriptor, 'offset'), false);
  assert.equal(Object.hasOwn(descriptor, 'fieldName'), false);
  assert.equal(Object.hasOwn(descriptor, 'memberType'), false);
  assert.deepEqual(
    descriptor.members.map((member) => ({ offset: member.offset, fieldName: member.fieldName })),
    [{ offset: 0, fieldName: 'a' }, { offset: 4, fieldName: 'b' }],
  );
});

test('aggregate identity does not depend on which field was inserted first', () => {
  const forward = new TypeConstraintGraph({ snapshotId: 'issue-3906-order-forward' });
  addField(forward, 'S', { offset: 0, fieldName: 'a' });
  addField(forward, 'S', { offset: 4, fieldName: 'b' });

  const reverse = new TypeConstraintGraph({ snapshotId: 'issue-3906-order-reverse' });
  addField(reverse, 'S', { offset: 4, fieldName: 'b' });
  addField(reverse, 'S', { offset: 0, fieldName: 'a' });

  assert.deepEqual(descriptorOf(reverse, 'S'), descriptorOf(forward, 'S'));
});

test('explicit aggregate size and alignment remain authoritative with field claims', () => {
  const graph = new TypeConstraintGraph({ snapshotId: 'issue-3906-explicit' });
  graph.addHardConstraint({
    kind: 'nested-aggregate',
    origin: 'binary-evidence',
    claim: {
      layer: 'structural',
      entityId: 'S',
      descriptor: { kind: 'struct', sizeBytes: 16, alignBytes: 8 },
    },
  });
  addField(graph, 'S', { offset: 0, fieldName: 'a' });

  const descriptor = descriptorOf(graph, 'S');
  assert.equal(descriptor.sizeBytes, 16);
  assert.equal(descriptor.totalSizeBytes, 16);
  assert.equal(descriptor.alignBytes, 8);
  assert.equal(Object.hasOwn(descriptor, 'offset'), false);
});

test('recursive member metadata remains on the member while aggregate recursion metadata is preserved', () => {
  const graph = new TypeConstraintGraph({ snapshotId: 'issue-3906-recursive' });
  addField(graph, 'Node', {
    offset: 0,
    sizeBytes: 8,
    fieldName: 'next',
    memberType: { kind: 'pointer', targetEntityId: 'Node' },
  });

  const descriptor = descriptorOf(graph, 'Node');
  assert.equal(descriptor.isRecursive, true);
  assert.equal(descriptor.recursiveIdentity, 'Node');
  assert.equal(Object.hasOwn(descriptor, 'offset'), false);
  assert.equal(Object.hasOwn(descriptor, 'memberType'), false);
  assert.equal(descriptor.members[0].isRecursive, true);
  assert.equal(descriptor.members[0].memberType.isRecursive, true);
  assert.equal(descriptor.members[0].memberType.targetEntityId, 'Node');
});
