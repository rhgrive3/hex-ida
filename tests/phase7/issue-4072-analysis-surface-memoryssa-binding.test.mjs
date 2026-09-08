import test from 'node:test';
import assert from 'node:assert/strict';

import { createAnalysisSurface } from '../../js/analysis/index.js';
import { analyzeLocalPointsTo } from '../../js/analysis/pointsto/local.js';
import { buildFixture } from './corpus/fixtures.mjs';

const SNAPSHOT_ID = 'snapshot_issue_4072';

function fixture() {
  return buildFixture('stack-identical');
}

function loadUse(built) {
  const use = built.memorySsa.uses.find((item) => item.sourceEntityId === 'node_ld');
  assert.ok(use, 'fixture must expose a load use');
  return use;
}

function surfaceFor(built, { memorySsa = built.memorySsa, memorySsaBinding = null } = {}) {
  return createAnalysisSurface({
    ir: built.ir,
    cfg: built.cfg,
    ssa: built.ssa,
    memorySsa,
    snapshotId: SNAPSHOT_ID,
    resolveRegion: built.resolveRegion,
    options: memorySsaBinding == null ? {} : { memorySsaBinding },
  });
}

function assertDependencyMismatch(surface, use) {
  // #4072 covers the two public MemorySSA query endpoints that previously
  // bypassed the artifact-identity gate. The caller also checks the A2
  // alias/points-to boundary against the same mismatch matrix below.
  const definition = surface.reachingMemoryDef(use);
  assert.equal(definition.definition, null);
  assert.equal(definition.status.completeness, 'unsupported');
  assert.equal(definition.status.stopReason, 'dependency-mismatch');

  const path = surface.explainMemoryPath(use);
  assert.equal(path.path, null);
  assert.equal(path.status.completeness, 'unsupported');
  assert.equal(path.status.stopReason, 'dependency-mismatch');
}

function assertBothBoundariesReject(built, { memorySsa = built.memorySsa, memorySsaBinding = null } = {}) {
  const surface = surfaceFor(built, { memorySsa, memorySsaBinding });
  assertDependencyMismatch(surface, loadUse(built));

  const result = analyzeLocalPointsTo(built.ir, built.cfg, built.ssa, {
    snapshotId: SNAPSHOT_ID,
    memorySsa,
    ...(memorySsaBinding == null ? {} : { memorySsaBinding }),
  });
  assert.notEqual(result.recovery.bindingState, 'current');
  assert.equal(result.recovery.publicationAllowed, false);
  assert.deepEqual(result.recovery.recoveredValueIds, []);
}

test('issue-4072: a MemorySSA artifact from another snapshot is rejected before public queries', () => {
  const built = fixture();
  const stale = { ...built.memorySsa, snapshotId: 'snapshot_old' };
  assertBothBoundariesReject(built, { memorySsa: stale });
});

test('issue-4072: a MemorySSA artifact from another function is rejected', () => {
  const built = fixture();
  const stale = { ...built.memorySsa, functionId: 'function_other' };
  assertBothBoundariesReject(built, { memorySsa: stale });
});

test('issue-4072: MemorySSA contract and build version mismatches are rejected', () => {
  const built = fixture();
  assertBothBoundariesReject(built, {
    memorySsa: { ...built.memorySsa, contractVersion: 'memoryssa-contract-stale' },
  });
  assertBothBoundariesReject(built, {
    memorySsa: { ...built.memorySsa, buildVersion: 'memoryssa-build-stale' },
  });
});

test('issue-4072: explicit stale binding identity is not laundered by the current surface', () => {
  const built = fixture();
  for (const memorySsaBinding of [
    { snapshotId: 'snapshot_old' },
    { functionId: 'function_other' },
    { semanticIrVersion: 'semantic-ir-stale' },
    { memorySsaBuildVersion: 'memoryssa-build-stale' },
  ]) {
    assertBothBoundariesReject(built, { memorySsaBinding });
  }
  assertBothBoundariesReject(built, { memorySsaBinding: { completeness: 'partial' } });
});

test('issue-4072: memorySsaSnapshotId-only callers preserve the resolved current binding', () => {
  const built = fixture();
  const result = analyzeLocalPointsTo(built.ir, built.cfg, built.ssa, {
    memorySsa: built.memorySsa,
    memorySsaSnapshotId: SNAPSHOT_ID,
  });

  assert.equal(result.recovery.bindingState, 'current');
  assert.equal(result.recovery.publicationAllowed, true);
});

test('issue-4072: current canonical MemorySSA keeps complete public answers', () => {
  const built = fixture();
  const use = loadUse(built);
  const surface = surfaceFor(built);

  assert.equal(surface.pointsTo().status.completeness, 'complete');

  const definition = surface.reachingMemoryDef(use);
  assert.ok(definition.definition);
  assert.equal(definition.status.completeness, 'complete');
  assert.equal(definition.status.stopReason, null);

  const path = surface.explainMemoryPath(use);
  assert.ok(path.path);
  assert.equal(path.status.completeness, 'complete');
  assert.equal(path.status.stopReason, null);
});

test('issue-4072: snapshotless artifacts cannot let a stale binding certify itself', () => {
  const built = fixture();
  const { snapshotId: _snapshotId, ...memorySsa } = built.memorySsa;
  for (const context of [{ memorySsaSnapshotId: SNAPSHOT_ID }, {}]) {
    const result = analyzeLocalPointsTo(built.ir, built.cfg, built.ssa, {
      ...context,
      memorySsa,
      memorySsaBinding: { snapshotId: 'snapshot_old', completeness: 'complete' },
    });
    assert.notEqual(result.recovery.bindingState, 'current');
    assert.equal(result.recovery.publicationAllowed, false);
    assert.deepEqual(result.recovery.recoveredValueIds, []);
  }
});

test('issue-4072: snapshot identity must remain a primitive string at both boundaries', () => {
  const built = fixture();
  const { snapshotId: _snapshotId, ...memorySsa } = built.memorySsa;
  for (const snapshotId of [[SNAPSHOT_ID], { id: SNAPSHOT_ID }, 42]) {
    assertBothBoundariesReject(built, { memorySsa, memorySsaBinding: { snapshotId } });
    const result = analyzeLocalPointsTo(built.ir, built.cfg, built.ssa, {
      memorySsa,
      memorySsaSnapshotId: snapshotId,
      memorySsaBinding: { snapshotId, completeness: 'complete' },
    });
    assert.notEqual(result.recovery.bindingState, 'current');
    assert.equal(result.recovery.publicationAllowed, false);
    assert.deepEqual(result.recovery.recoveredValueIds, []);
  }
});
