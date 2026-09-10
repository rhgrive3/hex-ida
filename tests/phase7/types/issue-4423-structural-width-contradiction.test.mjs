import assert from 'node:assert/strict';
import test from 'node:test';

import { claimsConflict } from '../../../js/analysis/types/constraints.js';
import { TypeConstraintGraph } from '../../../js/analysis/types/graph.js';

const memberType = Object.freeze({ kind:'integer', name:'int32', widthBits:32 });

function field(sizeBytes, extra = {}) {
  return {
    layer:'structural',
    entityId:'issue-4423-struct',
    descriptor:{ offset:0, sizeBytes, memberType, ...extra },
  };
}

function graphFor(...claims) {
  const graph = new TypeConstraintGraph({ snapshotId:'issue-4423-snapshot' });
  for (const claim of claims) graph.addHardConstraint({
    kind:'debug-type',
    origin:'debug-matched',
    claim,
  });
  return graph;
}

test('#4423 same offset and member type with different field widths records a contradiction', () => {
  const result = graphFor(field(4), field(8)).solveEntity('issue-4423-struct');
  const structural = result.layers.structural;

  assert.equal(structural.contradictions.length, 1);
  assert.equal(structural.selected, null);
  assert.equal(structural.confidence, 'unknown');
  assert.equal(result.status.completeness, 'complete');
  assert.match(structural.contradictions[0].detail, /debug-type vs debug-type/);
  assert.deepEqual(
    structural.contradictions[0].left.claim.descriptor.memberType,
    memberType,
  );
  assert.deepEqual(
    structural.contradictions[0].right.claim.descriptor.memberType,
    memberType,
  );
});
test('#4423 equal layout facts remain compatible across primitive numeric spellings', () => {
  const left = field(4, { alignBytes:4, fieldName:'value' });
  const right = field('4', { alignBytes:'4', fieldName:'value' });
  assert.equal(claimsConflict(
    { ...left, key:'left' },
    { ...right, key:'right' },
  ), false);
  const structural = graphFor(left, right).solveEntity('issue-4423-struct').layers.structural;
  assert.equal(structural.contradictions.length, 0);
  assert.equal(structural.confidence, 'certain');
});

test('#4423 disjoint fields coexist while incompatible overlapping members still conflict', () => {
  const disjoint = graphFor(
    { ...field(4), descriptor:{ ...field(4).descriptor, offset:0 } },
    { ...field(8), descriptor:{ ...field(8).descriptor, offset:8 } },
  ).solveEntity('issue-4423-struct').layers.structural;
  assert.equal(disjoint.contradictions.length, 0);

  const incompatible = graphFor(
    field(8, { memberType:{ kind:'integer', name:'int64', widthBits:64 } }),
    field(8, { memberType:{ kind:'float', name:'double', widthBits:64 } }),
  ).solveEntity('issue-4423-struct').layers.structural;
  assert.equal(incompatible.contradictions.length, 1);
  assert.equal(incompatible.selected, null);
});
