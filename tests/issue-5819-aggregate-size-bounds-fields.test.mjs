import assert from 'node:assert/strict';
import { TypeConstraintGraph } from '../js/analysis/types/graph.js';

// Issue #5819: a hard aggregate size N and a hard field extent
// [offset, offset+size) with offset+size > N are a hard contradiction. The
// old pipeline treated them as compatible and silently grew the struct to the
// field extent, publishing a `certain` result that overwrote authoritative
// binary evidence.

function graphWith(aggregateSize, fieldOffset, fieldSize) {
  const graph = new TypeConstraintGraph({ snapshotId: 's' });
  graph.addHardConstraint({
    kind: 'nested-aggregate',
    origin: 'binary-evidence',
    evidenceIds: ['aggregate-size'],
    claim: {
      layer: 'structural',
      entityId: 'S',
      descriptor: { kind: 'struct', sizeBytes: aggregateSize, alignBytes: 4 },
    },
  });
  graph.addHardConstraint({
    kind: 'structural-field',
    origin: 'binary-evidence',
    evidenceIds: ['field'],
    claim: {
      layer: 'structural',
      entityId: 'S',
      descriptor: {
        offset: fieldOffset,
        sizeBytes: fieldSize,
        memberType: { kind: 'integer', widthBits: 32 },
      },
    },
  });
  return graph.solveEntity('S');
}

// Field [8,12) vs aggregate size 8: contradiction, never a grown certain struct.
{
  const result = graphWith(8n, 8, 4);
  assert.ok(result.contradictions.length >= 1, 'out-of-bounds hard field must be recorded as a contradiction');
  assert.notEqual(result.layers.structural.confidence, 'certain', 'contradictory hard facts must not be certain');
  if (result.layers.structural.selected) {
    assert.equal(
      Number(result.layers.structural.selected.descriptor.sizeBytes),
      8,
      'the authoritative aggregate size must not be silently expanded',
    );
  }
}

// A field that fits stays compatible: [4,8) inside size 8.
{
  const result = graphWith(8n, 4, 4);
  assert.equal(result.contradictions.length, 0, 'in-bounds field is not a contradiction');
  assert.equal(result.layers.structural.confidence, 'certain');
  assert.equal(Number(result.layers.structural.selected.descriptor.sizeBytes), 8,
    'explicit hard size stays authoritative when fields fit');
}

// Aggregate without explicit size still derives its size from extents.
{
  const graph = new TypeConstraintGraph({ snapshotId: 's' });
  graph.addHardConstraint({
    kind: 'structural-field',
    origin: 'binary-evidence',
    evidenceIds: ['field'],
    claim: {
      layer: 'structural',
      entityId: 'T',
      descriptor: { offset: 4, sizeBytes: 4, memberType: { kind: 'integer', widthBits: 32 } },
    },
  });
  const result = graph.solveEntity('T');
  assert.equal(result.layers.structural.confidence, 'certain');
  assert.equal(Number(result.layers.structural.selected.descriptor.sizeBytes), 8);
}

console.log('issue-5819 hard aggregate size bounds field extents: ok');
