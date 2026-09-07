import assert from 'node:assert/strict';
import test from 'node:test';

import { createAnalysisSurface } from '../js/analysis/index.js';
import { DwarfDebugInfoProvider } from '../js/analysis/debug/dwarf.js';
import { loadDwarfFixtures, dwarfImage } from '../tools/validation/phase7/lanes/debug.mjs';

const hard = (entityId, widthBits) => ({
  kind: 'access-width',
  origin: 'binary-evidence',
  claim: { layer: 'machine', entityId, descriptor: { widthBits, class: 'integer' } },
});

function surfaceWith(evidence, extra = {}) {
  return createAnalysisSurface({
    ir: { functionId: 'fn_types', contractVersion: 1 },
    cfg: null, ssa: null, memorySsa: null,
    snapshotId: 'snapshot_issue_6247',
    options: { canonicalTypeEvidence: evidence, ...extra },
  });
}

test('issue-6247: explainType answers a canonical hard constraint instead of evidence-missing', () => {
  const surface = surfaceWith({ hardConstraints: [hard('v0', 32)] });
  const result = surface.explainType('v0');
  assert.equal(result.status.completeness, 'complete');
  assert.equal(result.status.stopReason, null);
  assert.equal(result.layers.machine.confidence, 'certain');
  assert.equal(result.layers.machine.selected.descriptor.widthBits, 32);
});

test('issue-6247: soft evidence alone never reaches certainty', () => {
  const surface = surfaceWith({
    softEvidence: [{
      kind: 'use-shape',
      origin: 'heuristic',
      weight: 0.9,
      claim: { layer: 'machine', entityId: 'v1', descriptor: { widthBits: 64, class: 'integer' } },
    }],
  });
  const result = surface.explainType('v1');
  assert.equal(result.status.completeness, 'complete');
  assert.notEqual(result.layers.machine.confidence, 'certain');
});

test('issue-6247: contradictory canonical hard evidence does not fabricate a selected type', () => {
  const surface = surfaceWith({ hardConstraints: [hard('v2', 32), hard('v2', 64)] });
  const result = surface.explainType('v2');
  assert.equal(result.status.completeness, 'complete');
  assert.equal(result.layers.machine.contradictions.length, 1);
  assert.equal(result.layers.machine.selected, null);
  assert.notEqual(result.layers.machine.confidence, 'certain');
});

test('issue-6247: an entity without evidence stays unsupported/evidence-missing', () => {
  const surface = surfaceWith({ hardConstraints: [hard('v0', 32)] });
  const result = surface.explainType('entity_absent');
  assert.equal(result.status.completeness, 'unsupported');
  assert.equal(result.status.stopReason, 'evidence-missing');
});

test('issue-6247: a surface without canonical evidence keeps the legacy empty-graph answer', () => {
  const built = { ir: { functionId: 'fn_bare', contractVersion: 1 } };
  const surface = createAnalysisSurface({ ...built, snapshotId: 'snapshot_issue_6247_bare' });
  const result = surface.explainType('entity_absent');
  assert.equal(result.status.completeness, 'unsupported');
  assert.equal(result.status.stopReason, 'evidence-missing');
});

test('issue-6247: matched debug evidence reaches the surface type graph as hard constraints', () => {
  const fixtures = loadDwarfFixtures();
  const dwarf5 = fixtures.variants.find((variant) => variant.name === 'dwarf5');
  const provider = new DwarfDebugInfoProvider();
  const result = provider.probe(dwarfImage(dwarf5));
  const page = provider.types(result, {});
  const surface = surfaceWith({ debug: [{ result, page }] });
  const solved = surface.explainType('dwarf_die_201');
  assert.equal(solved.status.completeness, 'complete');
  assert.equal(solved.layers.nominal.confidence, 'certain');
  assert.equal(solved.layers.nominal.selected.descriptor.name, 'int32_t');
});

test('issue-6247: stale/mismatched debug evidence never becomes a hard constraint', () => {
  const fixtures = loadDwarfFixtures();
  const dwarf5 = fixtures.variants.find((variant) => variant.name === 'dwarf5');
  const provider = new DwarfDebugInfoProvider();
  const result = provider.probe(dwarfImage(dwarf5, { buildId: 'deadbeef'.repeat(5) }));
  assert.equal(result.identity.verdict, 'identity-mismatch');
  const page = provider.types(result, {});
  const surface = surfaceWith({ debug: [{ result, page }] });
  for (const record of page.records) {
    const solved = surface.explainType(record.entityId);
    if (!solved.layers.nominal) continue;
    assert.notEqual(solved.layers.nominal.confidence, 'certain',
      'mismatched debug evidence must not mint a certain type');
  }
});
