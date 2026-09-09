import assert from 'node:assert/strict';
import test from 'node:test';

import { createAnalysisSurface } from '../../../js/analysis/index.js';
import { mergeAnalysisStatus } from '../../../js/analysis/status.js';
import { buildFixture } from '../corpus/fixtures.mjs';

function surfaceFor(snapshotId) {
  const built = buildFixture('stack-disjoint');
  return {
    built,
    surface: createAnalysisSurface({
      ir: built.ir,
      cfg: built.cfg,
      ssa: built.ssa,
      memorySsa: built.memorySsa,
      snapshotId,
      resolveRegion: built.resolveRegion,
      options: built.rootDescriptors == null
        ? {}
        : { canonicalOptions: { rootDescriptors: built.rootDescriptors } },
    }),
  };
}

test('#4335 canonical AnalysisSurface requires an explicit primitive non-empty snapshot id', () => {
  const built = buildFixture('stack-disjoint');
  const base = {
    ir: built.ir,
    cfg: built.cfg,
    ssa: built.ssa,
    memorySsa: built.memorySsa,
    resolveRegion: built.resolveRegion,
  };

  for (const snapshotId of [undefined, null, '', '   ', ['snapshot-A'], { toString: () => 'snapshot-A' }]) {
    const input = snapshotId === undefined ? base : { ...base, snapshotId };
    assert.throws(
      () => createAnalysisSurface(input),
      (error) => error instanceof TypeError && error.message === 'phase7-analysis-snapshot-required',
      `snapshot ${String(snapshotId)} must fail closed`,
    );
  }

  assert.throws(
    () => createAnalysisSurface({ ...base, options: { snapshotId: 'forged-through-options' } }),
    (error) => error instanceof TypeError && error.message === 'phase7-analysis-snapshot-required',
    'tuning options must not synthesize the public surface snapshot identity',
  );
});

test('#4335 one canonical snapshot id propagates through every public Phase 7 result boundary', () => {
  const { built, surface } = surfaceFor('  snapshot-4335  ');
  assert.equal(surface.snapshotId, 'snapshot-4335');

  const alias = surface.alias(built.memorySsa.regions[0], built.memorySsa.regions[0]);
  assert.equal(alias.status.snapshotId, 'snapshot-4335');
  assert.equal(surface.pointsTo().status.snapshotId, 'snapshot-4335');
  assert.equal(surface.functionSummary().status.snapshotId, 'snapshot-4335');
  assert.equal(surface.memoryEffects().status.snapshotId, 'snapshot-4335');
  assert.equal(surface.escape().status.snapshotId, 'snapshot-4335');
  assert.equal(surface.explainType('entity_absent').status.snapshotId, 'snapshot-4335');

  const use = built.memorySsa.uses[0];
  if (use) assert.equal(surface.reachingMemoryDef(use).status.snapshotId, 'snapshot-4335');
});

test('#4335 unrelated AnalysisSurfaces cannot share a fabricated fallback snapshot authority', () => {
  const { surface: a } = surfaceFor('snapshot-A');
  const { surface: b } = surfaceFor('snapshot-B');
  const aStatus = a.memoryEffects().status;
  const bStatus = b.memoryEffects().status;

  assert.notEqual(aStatus.snapshotId, bStatus.snapshotId);
  assert.throws(
    () => mergeAnalysisStatus(aStatus, bStatus),
    /analysis-status-snapshot-mismatch/,
  );
});
