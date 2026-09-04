import assert from 'node:assert/strict';
import test from 'node:test';

import { TypeConstraintGraph } from '../../../js/analysis/types/graph.js';

function addField(graph, entityId, { offset, sizeBytes, name }) {
  graph.addHardConstraint({
    kind: 'structural-field',
    origin: 'binary-evidence',
    claim: {
      layer: 'structural',
      entityId,
      descriptor: {
        offset,
        sizeBytes,
        name,
        memberType: { kind: 'integer', widthBits: 8 },
      },
    },
  });
}

test('adjacent fields above Number.MAX_SAFE_INTEGER remain distinct during hard-claim merge', () => {
  const graph = new TypeConstraintGraph({ snapshotId: 'issue-3469-adjacent' });
  addField(graph, 'HugeStruct', {
    offset: 9007199254740992n,
    sizeBytes: 1n,
    name: 'a',
  });
  addField(graph, 'HugeStruct', {
    offset: 9007199254740993n,
    sizeBytes: 1n,
    name: 'b',
  });

  const structural = graph.solveEntity('HugeStruct').layers.structural;
  assert.equal(structural.contradictions.length, 0);
  assert.equal(structural.confidence, 'certain');
  assert.ok(structural.selected);
  assert.deepEqual(
    structural.selected.descriptor.members.map((member) => member.offset),
    [9007199254740992n, 9007199254740993n],
  );
  assert.equal(structural.selected.descriptor.totalSizeBytes, '9007199254740994');
  assert.equal(structural.selected.descriptor.alignBytes, 1);
});

test('huge offset, size, and alignment arithmetic stays exact through rounding', () => {
  const graph = new TypeConstraintGraph({ snapshotId: 'issue-3469-rounding' });
  addField(graph, 'OddHugeStruct', {
    offset: '9007199254740993',
    sizeBytes: '2',
    name: 'wide',
  });

  const structural = graph.solveEntity('OddHugeStruct').layers.structural;
  assert.equal(structural.contradictions.length, 0);
  assert.equal(structural.confidence, 'certain');
  assert.ok(structural.selected);
  assert.equal(structural.selected.descriptor.members[0].offset, '9007199254740993');
  assert.equal(structural.selected.descriptor.totalSizeBytes, '9007199254740996');
  assert.equal(structural.selected.descriptor.alignBytes, 2);
});

test('ordinary safe structural layouts retain numeric aggregate outputs', () => {
  const graph = new TypeConstraintGraph({ snapshotId: 'issue-3469-safe-range' });
  addField(graph, 'SmallStruct', { offset: 0, sizeBytes: 4, name: 'a' });
  addField(graph, 'SmallStruct', { offset: 8, sizeBytes: 4, name: 'b' });

  const structural = graph.solveEntity('SmallStruct').layers.structural;
  assert.equal(structural.contradictions.length, 0);
  assert.equal(structural.confidence, 'certain');
  assert.ok(structural.selected);
  assert.deepEqual(structural.selected.descriptor.members.map((member) => member.offset), [0, 8]);
  assert.equal(structural.selected.descriptor.totalSizeBytes, 12);
  assert.equal(structural.selected.descriptor.alignBytes, 4);
});
