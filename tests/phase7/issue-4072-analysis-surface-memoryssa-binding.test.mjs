import test from 'node:test';
import assert from 'node:assert/strict';

import { createAnalysisSurface } from '../../js/analysis/index.js';
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
  const definition = surface.reachingMemoryDef(use);
  assert.equal(definition.definition, null);
  assert.equal(definition.status.completeness, 'unsupported');
  assert.equal(definition.status.stopReason, 'dependency-mismatch');

  const path = surface.explainMemoryPath(use);
  assert.equal(path.path, null);
  assert.equal(path.status.completeness, 'unsupported');
  assert.equal(path.status.stopReason, 'dependency-mismatch');
}

test('issue-4072: a MemorySSA artifact from another snapshot is rejected before public queries', () => {
  const built = fixture();
  const stale = { ...built.memorySsa, snapshotId: 'snapshot_old' };
  assertDependencyMismatch(surfaceFor(built, { memorySsa: stale }), loadUse(built));
});

test('issue-4072: a MemorySSA artifact from another function is rejected', () => {
  const built = fixture();
  const stale = { ...built.memorySsa, functionId: 'function_other' };
  assertDependencyMismatch(surfaceFor(built, { memorySsa: stale }), loadUse(built));
});

test('issue-4072: MemorySSA contract and build version mismatches are rejected', () => {
  const built = fixture();
  const use = loadUse(built);
  assertDependencyMismatch(surfaceFor(built, {
    memorySsa: { ...built.memorySsa, contractVersion: 'memoryssa-contract-stale' },
  }), use);
  assertDependencyMismatch(surfaceFor(built, {
    memorySsa: { ...built.memorySsa, buildVersion: 'memoryssa-build-stale' },
  }), use);
});

test('issue-4072: explicit stale binding identity is not laundered by the current surface', () => {
  const built = fixture();
  const use = loadUse(built);
  for (const memorySsaBinding of [
    { snapshotId: 'snapshot_old' },
    { functionId: 'function_other' },
    { semanticIrVersion: 'semantic-ir-stale' },
    { memorySsaBuildVersion: 'memoryssa-build-stale' },
  ]) {
    assertDependencyMismatch(surfaceFor(built, { memorySsaBinding }), use);
  }
});

test('issue-4072: current canonical MemorySSA keeps complete public answers', () => {
  const built = fixture();
  const use = loadUse(built);
  const surface = surfaceFor(built);

  const definition = surface.reachingMemoryDef(use);
  assert.ok(definition.definition);
  assert.equal(definition.status.completeness, 'complete');
  assert.equal(definition.status.stopReason, null);

  const path = surface.explainMemoryPath(use);
  assert.ok(path.path);
  assert.equal(path.status.completeness, 'complete');
  assert.equal(path.status.stopReason, null);
});
