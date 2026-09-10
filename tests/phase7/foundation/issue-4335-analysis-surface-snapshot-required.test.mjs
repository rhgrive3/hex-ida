import assert from 'node:assert/strict';
import test from 'node:test';
import { createAnalysisSurface } from '../../../js/analysis/index.js';
import { buildFixture } from '../corpus/fixtures.mjs';

function fixtureArgs() {
  const built = buildFixture('stack-disjoint');
  return {
    ir: built.ir,
    cfg: built.cfg,
    ssa: built.ssa,
    memorySsa: built.memorySsa,
    resolveRegion: built.resolveRegion,
  };
}

test('#4335 canonical AnalysisSurface rejects a missing or non-canonical snapshot identity', () => {
  const args = fixtureArgs();
  const invalid = [
    undefined,
    null,
    '',
    '   ',
    7,
    true,
    ['snapshot-4335'],
    new String('snapshot-4335'),
  ];

  for (const snapshotId of invalid) {
    const input = snapshotId === undefined ? args : { ...args, snapshotId };
    assert.throws(
      () => createAnalysisSurface(input),
      (error) => error instanceof TypeError && error.message === 'phase7-analysis-snapshot-required',
      `snapshotId ${String(snapshotId)} must fail closed`,
    );
  }
});

test('#4335 never coerces a structured snapshot identity into authority', () => {
  const poison = {
    toString() { throw new Error('snapshot identity coercion must not run'); },
    valueOf() { throw new Error('snapshot identity coercion must not run'); },
  };
  assert.throws(
    () => createAnalysisSurface({ ...fixtureArgs(), snapshotId: poison }),
    (error) => error instanceof TypeError && error.message === 'phase7-analysis-snapshot-required',
  );
});

test('#4335 trims the required snapshot once and propagates one canonical identity to all surface-owned results', () => {
  const args = fixtureArgs();
  const surface = createAnalysisSurface({
    ...args,
    snapshotId: '  snapshot-4335  ',
    options: { memorySsaBinding: { completeness: 'complete' } },
  });

  assert.equal(surface.snapshotId, 'snapshot-4335');
  const pointsTo = surface.pointsTo();
  assert.equal(pointsTo.status.snapshotId, 'snapshot-4335');
  assert.equal(pointsTo.recovery?.bindingState, 'current');
  assert.equal(surface.functionSummary().status.snapshotId, 'snapshot-4335');
  assert.equal(surface.functionSummary().summary.status.snapshotId, 'snapshot-4335');
  assert.equal(surface.escape().status.snapshotId, 'snapshot-4335');
  assert.equal(surface.types().snapshotId, 'snapshot-4335');
});

test('#4335 distinct explicit snapshot identities remain distinct at the public boundary', () => {
  const args = fixtureArgs();
  const a = createAnalysisSurface({ ...args, snapshotId: 'snapshot-4335-A' });
  const b = createAnalysisSurface({ ...args, snapshotId: 'snapshot-4335-B' });

  assert.notEqual(a.snapshotId, b.snapshotId);
  assert.equal(a.snapshotId, 'snapshot-4335-A');
  assert.equal(b.snapshotId, 'snapshot-4335-B');
});
