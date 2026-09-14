/**
 * Issue #6302 regression: `createAnalysisSurface()` must not overwrite an
 * explicitly-declared `memorySsaBinding` identity with the current surface
 * values. A stale binding identity must survive to `prepareMemoryBoundary()`
 * and fail closed as `memoryssa-stale-snapshot` (publication blocked), while
 * missing identity fields still fall back to the current values.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

test('#6302 stale binding snapshotId is not overwritten and fails closed', async () => {
  const { createAnalysisSurface } = await import('../js/analysis/index.js');
  const { buildFixture } = await import('./phase7/corpus/fixtures.mjs');

  const built = buildFixture('stack-disjoint');
  assert.equal(built.memorySsa.snapshotId, undefined, 'builder leaves snapshot-unbound artifacts untagged');
  assert.ok(built.memorySsa.functionId, 'fixture has a functionId');

  const staleBinding = {
    memorySsa: built.memorySsa,
    snapshotId: 'S-old',
    functionId: built.ir.functionId,
    semanticIrVersion: built.ir.contractVersion,
    memorySsaBuildVersion: built.memorySsa.buildVersion,
    completeness: 'complete',
  };

  const surface = createAnalysisSurface({
    ir: built.ir,
    cfg: built.cfg,
    ssa: built.ssa,
    memorySsa: built.memorySsa,
    snapshotId: 'S-new',
    options: { memorySsaBinding: staleBinding },
  });

  const run = surface.pointsTo();
  assert.ok(run, 'points-to run produced');
  assert.equal(run.recovery?.bindingState, 'stale', 'binding must be reported stale, not silently rebound');
  assert.equal(run.recovery?.bindingReason, 'memoryssa-stale-snapshot');
  assert.equal(run.recovery?.publicationAllowed, false, 'stale evidence must not be published');
});

test('#6302 current binding snapshotId still publishes through the surface', async () => {
  const { createAnalysisSurface } = await import('../js/analysis/index.js');
  const { buildFixture } = await import('./phase7/corpus/fixtures.mjs');

  const built = buildFixture('stack-disjoint');
  const currentBinding = {
    memorySsa: built.memorySsa,
    snapshotId: 'S-new',
    functionId: built.ir.functionId,
    semanticIrVersion: built.ir.contractVersion,
    memorySsaBuildVersion: built.memorySsa.buildVersion,
    completeness: 'complete',
  };

  const surface = createAnalysisSurface({
    ir: built.ir,
    cfg: built.cfg,
    ssa: built.ssa,
    memorySsa: built.memorySsa,
    snapshotId: 'S-new',
    options: { memorySsaBinding: currentBinding },
  });

  const run = surface.pointsTo();
  assert.ok(run, 'points-to run produced');
  assert.equal(run.recovery?.bindingState, 'current');
  assert.equal(run.recovery?.publicationAllowed, true);
});

test('#6302 binding without explicit snapshotId keeps fallback semantics', async () => {
  const { createAnalysisSurface } = await import('../js/analysis/index.js');
  const { buildFixture } = await import('./phase7/corpus/fixtures.mjs');

  const built = buildFixture('stack-disjoint');
  const surface = createAnalysisSurface({
    ir: built.ir,
    cfg: built.cfg,
    ssa: built.ssa,
    memorySsa: built.memorySsa,
    snapshotId: 'S-new',
    options: { memorySsaBinding: { completeness: 'complete' } },
  });

  const run = surface.pointsTo();
  assert.ok(run, 'points-to run produced');
  assert.equal(run.recovery?.bindingState, 'current');
  assert.equal(run.recovery?.publicationAllowed, true);
});

test('#6302 stale binding functionId survives surface construction', async () => {
  const { createAnalysisSurface } = await import('../js/analysis/index.js');
  const { buildFixture } = await import('./phase7/corpus/fixtures.mjs');

  const built = buildFixture('stack-disjoint');
  const staleFunctionBinding = {
    memorySsa: built.memorySsa,
    snapshotId: 'S-new',
    functionId: 'some-other-function',
    semanticIrVersion: built.ir.contractVersion,
    memorySsaBuildVersion: built.memorySsa.buildVersion,
    completeness: 'complete',
  };

  const surface = createAnalysisSurface({
    ir: built.ir,
    cfg: built.cfg,
    ssa: built.ssa,
    memorySsa: built.memorySsa,
    snapshotId: 'S-new',
    options: { memorySsaBinding: staleFunctionBinding },
  });

  const run = surface.pointsTo();
  assert.ok(run, 'points-to run produced');
  assert.equal(run.recovery?.bindingState, 'stale');
  assert.equal(run.recovery?.bindingReason, 'memoryssa-stale-function');
  assert.equal(run.recovery?.publicationAllowed, false);
});

test('#6302 stale binding semanticIrVersion / buildVersion are detected, not overwritten', async () => {
  const { createAnalysisSurface } = await import('../js/analysis/index.js');
  const { buildFixture } = await import('./phase7/corpus/fixtures.mjs');

  const built = buildFixture('stack-disjoint');

  const staleIr = createAnalysisSurface({
    ir: built.ir,
    cfg: built.cfg,
    ssa: built.ssa,
    memorySsa: built.memorySsa,
    snapshotId: 'S-new',
    options: {
      memorySsaBinding: {
        memorySsa: built.memorySsa,
        snapshotId: 'S-new',
        functionId: built.ir.functionId,
        semanticIrVersion: '0.0.0-other',
        memorySsaBuildVersion: built.memorySsa.buildVersion,
        completeness: 'complete',
      },
    },
  });
  const runIr = staleIr.pointsTo();
  assert.equal(runIr.recovery?.bindingState, 'stale');
  assert.equal(runIr.recovery?.bindingReason, 'semantic-ir-version-mismatch');
  assert.equal(runIr.recovery?.publicationAllowed, false);

  const staleBuild = createAnalysisSurface({
    ir: built.ir,
    cfg: built.cfg,
    ssa: built.ssa,
    memorySsa: built.memorySsa,
    snapshotId: 'S-new',
    options: {
      memorySsaBinding: {
        memorySsa: built.memorySsa,
        snapshotId: 'S-new',
        functionId: built.ir.functionId,
        semanticIrVersion: built.ir.contractVersion,
        memorySsaBuildVersion: '0.0.0-oldbuild',
        completeness: 'complete',
      },
    },
  });
  const runBuild = staleBuild.pointsTo();
  assert.equal(runBuild.recovery?.bindingState, 'stale');
  assert.equal(runBuild.recovery?.bindingReason, 'memoryssa-build-mismatch');
  assert.equal(runBuild.recovery?.publicationAllowed, false);
});

test('#6302 binding-declared partial completeness is not upgraded to complete', async () => {
  const { createAnalysisSurface } = await import('../js/analysis/index.js');
  const { buildFixture } = await import('./phase7/corpus/fixtures.mjs');

  const built = buildFixture('stack-disjoint');
  const surface = createAnalysisSurface({
    ir: built.ir,
    cfg: built.cfg,
    ssa: built.ssa,
    memorySsa: built.memorySsa,
    snapshotId: 'S-new',
    options: {
      memorySsaBinding: {
        snapshotId: 'S-new',
        functionId: built.ir.functionId,
        semanticIrVersion: built.ir.contractVersion,
        memorySsaBuildVersion: built.memorySsa.buildVersion,
        completeness: 'partial',
      },
    },
  });

  const run = surface.pointsTo();
  assert.ok(run, 'points-to run produced');
  assert.equal(run.recovery?.bindingState, 'unsupported');
  assert.equal(run.recovery?.bindingReason, 'memoryssa-incomplete');
  assert.equal(run.recovery?.publicationAllowed, false);
});
