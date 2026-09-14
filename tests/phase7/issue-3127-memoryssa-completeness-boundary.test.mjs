import test from 'node:test';
import assert from 'node:assert/strict';

import { createAnalysisSurface } from '../../js/analysis/index.js';
import { buildFixture } from './corpus/fixtures.mjs';

function surfaceFor(fixtureId, options = {}) {
  const built = buildFixture(fixtureId);
  return { built, surface: createAnalysisSurface({
    ir: built.ir, cfg: built.cfg, ssa: built.ssa, memorySsa: built.memorySsa,
    snapshotId: 'snapshot_issue_3127', resolveRegion: built.resolveRegion, options,
  }) };
}

function loadUse(built) {
  const use = built.memorySsa.uses.find((item) => item.sourceEntityId === 'node_ld');
  assert.ok(use, 'fixture must expose a load use');
  return use;
}

test('issue-3127: an incomplete MemorySSA binding must not be published as complete', () => {
  const { built, surface } = surfaceFor('stack-identical', { memorySsaBinding: { completeness: 'partial' } });
  const use = loadUse(built);
  const def = surface.reachingMemoryDef(use);
  assert.equal(def.definition, null, 'incomplete MemorySSA must not answer reachingMemoryDef');
  assert.equal(def.status.completeness, 'unsupported');
  assert.equal(def.status.stopReason, 'dependency-mismatch');
  const path = surface.explainMemoryPath(use);
  assert.equal(path.path, null, 'incomplete MemorySSA must not answer explainMemoryPath');
  assert.equal(path.status.completeness, 'unsupported');
});

test('issue-3127: the boundary prefers the binding-declared completeness over the legacy option', () => {
  const { built, surface } = surfaceFor('stack-identical', { memorySsaBinding: { completeness: 'partial' }, memorySsaCompleteness: 'complete' });
  const def = surface.reachingMemoryDef(loadUse(built));
  assert.equal(def.definition, null);
  assert.equal(def.status.stopReason, 'dependency-mismatch', 'binding completeness wins over the legacy option');
});

test('issue-3127: an explicit complete binding keeps the reaching-memory answers available', () => {
  const { built, surface } = surfaceFor('stack-identical', { memorySsaBinding: { completeness: 'complete' } });
  const def = surface.reachingMemoryDef(loadUse(built));
  assert.ok(def.definition, 'a complete binding must still answer reachingMemoryDef');
  assert.equal(def.status.completeness, 'complete');
});

test('issue-3127: a missing MemorySSA keeps the dependency-missing answer', () => {
  const surface = createAnalysisSurface({
    ir: { functionId: 'fn_test', contractVersion: 1 },
    cfg: null, ssa: null, memorySsa: null,
    snapshotId: 'snapshot_issue_3127',
  });
  const def = surface.reachingMemoryDef('use_1');
  assert.equal(def.definition, null);
  assert.equal(def.status.completeness, 'unsupported');
  assert.equal(def.status.stopReason, 'dependency-missing');
});
