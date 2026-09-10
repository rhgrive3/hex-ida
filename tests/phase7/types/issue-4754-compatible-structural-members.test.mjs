import assert from 'node:assert/strict';
import test from 'node:test';

import { claimsConflict, createTypeClaim } from '../../../js/analysis/types/constraints.js';
import { TypeConstraintGraph } from '../../../js/analysis/types/graph.js';

const int32 = Object.freeze({ kind:'integer', widthBits:32, signed:true });
const ptr64 = Object.freeze({ kind:'pointer', widthBits:64 });

function member(offset, sizeBytes, memberType, extra = {}) {
  return { offset, sizeBytes, memberType, ...extra };
}

function aggregate(entityId, members, extra = {}) {
  return createTypeClaim({
    layer:'structural',
    entityId,
    descriptor:{ kind:'struct', members, ...extra },
  });
}

function solveWith(left, right) {
  const graph = new TypeConstraintGraph({ snapshotId:'issue-4754' });
  graph.addHardConstraint({ kind:'debug-type', origin:'debug-matched', claim:left });
  graph.addHardConstraint({ kind:'structural-field', origin:'binary-evidence', claim:right });
  return graph.solveEntity(left.entityId).layers.structural;
}

test('#4754 disjoint aggregate member subsets are compatible and merge', () => {
  const left = aggregate('S', [member(0, 4, int32, { fieldName:'a' })]);
  const right = aggregate('S', [member(8, 8, ptr64, { fieldName:'b' })]);

  assert.equal(claimsConflict(left, right), false);
  const structural = solveWith(left, right);
  assert.equal(structural.contradictions.length, 0);
  assert.equal(structural.confidence, 'certain');
  assert.deepEqual(
    structural.selected.descriptor.members.map(({ offset, sizeBytes, fieldName }) => ({ offset, sizeBytes, fieldName })),
    [
      { offset:0, sizeBytes:4, fieldName:'a' },
      { offset:8, sizeBytes:8, fieldName:'b' },
    ],
  );
});

test('#4754 equal members at the same offset dedupe without contradiction', () => {
  const common = member(0, 4, int32, { fieldName:'value' });
  const left = aggregate('D', [common]);
  const right = aggregate('D', [{ ...common }]);

  assert.equal(claimsConflict(left, right), false);
  const structural = solveWith(left, right);
  assert.equal(structural.contradictions.length, 0);
  assert.equal(structural.selected.descriptor.members.length, 1);
});

test('#4754 incompatible members at the same offset still contradict', () => {
  const left = aggregate('C', [member(0, 4, int32)]);
  const right = aggregate('C', [member(0, 4, { kind:'float', widthBits:32 })]);

  assert.equal(claimsConflict(left, right), true);
  const structural = solveWith(left, right);
  assert.equal(structural.contradictions.length, 1);
  assert.equal(structural.selected, null);
});

test('#4754 partially overlapping incompatible members still contradict', () => {
  const left = aggregate('O', [member(0, 8, { kind:'integer', widthBits:64 })]);
  const right = aggregate('O', [member(4, 8, { kind:'float', widthBits:64 })]);

  assert.equal(claimsConflict(left, right), true);
});

test('#4754 member ordering alone does not create a contradiction', () => {
  const a = member(0, 4, int32, { fieldName:'a' });
  const b = member(8, 8, ptr64, { fieldName:'b' });
  const left = aggregate('R', [a, b]);
  const right = aggregate('R', [{ ...b }, { ...a }]);

  assert.equal(claimsConflict(left, right), false);
  const structural = solveWith(left, right);
  assert.equal(structural.contradictions.length, 0);
  assert.equal(structural.confidence, 'certain');
  assert.deepEqual(structural.selected.descriptor.members.map((entry) => entry.offset), [0, 8]);
});

test('#4754 aggregate-level size disagreement remains a contradiction', () => {
  const left = aggregate('Z', [member(0, 4, int32)], { sizeBytes:8, alignBytes:4 });
  const right = aggregate('Z', [member(0, 4, int32)], { sizeBytes:16, alignBytes:4 });

  assert.equal(claimsConflict(left, right), true);
});

test('#4754 unknown member extents do not weaken fail-closed conflict handling', () => {
  const left = aggregate('U', [{ offset:0, memberType:int32 }]);
  const right = aggregate('U', [{ offset:8, memberType:int32 }]);

  assert.equal(claimsConflict(left, right), true);
});

test('#4754 same-offset compatible partial member metadata merges into one certain fact', () => {
  const left = aggregate('P', [member(0, 4, int32)]);
  const right = aggregate('P', [member(0, 4, int32, { fieldName:'value' })]);

  assert.equal(claimsConflict(left, right), false);
  const structural = solveWith(left, right);
  assert.equal(structural.contradictions.length, 0);
  assert.equal(structural.confidence, 'certain');
  assert.equal(structural.selected.descriptor.members.length, 1);
  assert.deepEqual(
    structural.selected.descriptor.members[0],
    { offset:0, sizeBytes:4, memberType:int32, fieldName:'value' },
  );
});
