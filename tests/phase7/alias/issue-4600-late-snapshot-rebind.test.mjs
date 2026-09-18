import assert from 'node:assert/strict';
import test from 'node:test';

import { buildFixture, memoryAccessOf, regionOf } from '../corpus/fixtures.mjs';
import { createPhase7AliasSolver } from '../../../js/analysis/alias/solver.js';

// A solver created without a snapshot id adopts the MemorySSA binding's
// snapshot on a late `refineMemorySsa()`. When the staged candidate is not
// publishable the complete baseline stays authoritative — but a baseline that
// was computed before the rebind still carried the old snapshot identity, so
// the next A2 alias query deterministically failed the snapshot-mixing guard
// (#4600). A late rebind must recompute the baseline under the new identity.

test('a late snapshot rebind recomputes the fallback baseline under the new identity (#4600)', () => {
  const built = buildFixture('stack-disjoint');
  const solver = createPhase7AliasSolver({ ir: built.ir, cfg: built.cfg, ssa: built.ssa, options: {} });

  const baseline = solver.pointsToRun();
  assert.equal(baseline.status.snapshotId, 'snapshot-unbound');

  const staged = solver.refineMemorySsa({ uses: [], definitions: [], malformed: true }, {
    snapshotId: 'snapshot-B',
    completeness: 'partial',
  });
  assert.ok(staged, 'the unpublished candidate must fall back to the baseline');
  assert.equal(staged.status.snapshotId, 'snapshot-B',
    'the authoritative fallback must carry the rebound snapshot identity');

  const result = solver.alias(regionOf(built, 'node_st0'), regionOf(built, 'node_st8'), {
    leftAccess: memoryAccessOf(built, 'node_st0'),
    rightAccess: memoryAccessOf(built, 'node_st8'),
  });
  assert.equal(result.relation, 'no',
    'the A2 query must answer under the rebound snapshot instead of failing the snapshot-mixing guard');
});

test('a rebind to the same snapshot identity keeps the baseline answer (#4600)', () => {
  const built = buildFixture('stack-disjoint');
  const solver = createPhase7AliasSolver({ ir: built.ir, cfg: built.cfg, ssa: built.ssa, options: {} });
  const baseline = solver.pointsToRun();

  solver.refineMemorySsa({ uses: [], definitions: [], malformed: true }, {
    snapshotId: 'snapshot-unbound',
    completeness: 'partial',
  });
  const after = solver.pointsToRun();
  assert.equal(after.status.snapshotId, 'snapshot-unbound');
  assert.deepEqual(
    [...after.pointsTo.entries()].map(([id, set]) => [id, set.targets.map((t) => t.rootKey).sort()]),
    [...baseline.pointsTo.entries()].map(([id, set]) => [id, set.targets.map((t) => t.rootKey).sort()]),
    'no identity change must keep the baseline answer',
  );
});
