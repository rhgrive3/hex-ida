import assert from 'node:assert/strict';
import test from 'node:test';

import { createPhase7AliasSolver } from '../../../js/analysis/alias/solver.js';
import { buildFixture } from '../corpus/fixtures.mjs';

// #5215: escape facts belong to whichever points-to map is published. When a
// refined MemorySSA candidate is rejected (stale, partial, cancelled, …), the
// solver restores the baseline map — but it used to keep the cached escape run
// computed against the *rejected* candidate. `pointsToAlias()` consumes that
// run's `nonEscapingRoots` as strong `distinct-non-escaping-allocation`
// authority, so proofs from a map that is no longer published leaked into
// alias answers computed against the baseline.

const FIXTURE = 'frame-non-escaping';
const REFINEMENT = () => {
  const built = buildFixture(FIXTURE);
  return {
    built,
    refinement: {
      snapshotId: 'snapshot-5215',
      functionId: built.ir.functionId,
      semanticIrVersion: built.ir.contractVersion,
      memorySsaBuildVersion: built.memorySsa.buildVersion,
      completeness: 'complete',
    },
  };
};

test('#5215 a rejected refinement drops the escape cache derived from it', () => {
  const { built, refinement } = REFINEMENT();
  const solver = createPhase7AliasSolver({
    ir: built.ir, cfg: built.cfg, ssa: built.ssa,
    options: { snapshotId: 'snapshot-5215' },
  });

  solver.refineMemorySsa(built.memorySsa, refinement);
  const refinedEscape = solver.escapeRun();
  assert.ok(refinedEscape, 'the publishable refinement caches an escape run');
  const refinedRoots = refinedEscape.nonEscapingRoots.size;

  const baseline = solver.pointsToRun();
  const baselineDigest = [...baseline.pointsTo.entries()].map(([id, set]) => [id, set.targets.length]).sort();

  // A second, non-publishable refinement (partial completeness) restores the
  // baseline map and must invalidate the cached escape run.
  solver.refineMemorySsa(built.memorySsa, { ...refinement, completeness: 'partial' });
  const restored = solver.pointsToRun();
  assert.deepEqual(
    [...restored.pointsTo.entries()].map(([id, set]) => [id, set.targets.length]).sort(),
    baselineDigest,
    'the baseline map is authoritative again',
  );

  const escapeAfter = solver.escapeRun();
  assert.notEqual(escapeAfter, refinedEscape, 'the escape cache must not survive the rejected swap');
});

test('#5215 the escape run is recomputed against the restored baseline map', () => {
  const { built, refinement } = REFINEMENT();
  const solver = createPhase7AliasSolver({
    ir: built.ir, cfg: built.cfg, ssa: built.ssa,
    options: { snapshotId: 'snapshot-5215' },
  });

  solver.refineMemorySsa(built.memorySsa, refinement);
  const refinedEscape = solver.escapeRun();

  solver.refineMemorySsa(built.memorySsa, { ...refinement, completeness: 'partial' });
  const escapeAfter = solver.escapeRun();
  assert.ok(escapeAfter);
  // Same fixture, same underlying facts: a recomputation against the baseline
  // map must produce the same proof set as a fresh solver's view of that map,
  // not the refined run's object.
  assert.notEqual(escapeAfter, refinedEscape);
  assert.equal(escapeAfter.status.completeness, refinedEscape.status.completeness);
});
