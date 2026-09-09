import assert from 'node:assert/strict';
import test from 'node:test';

import { applyPhase8Projection } from '../../../js/decompiler/phase8/projection.js';
import { analysis, expr, resultWith, source, sourceOf } from './fixture.js';

test('P8-PROV ledger records carry kind, proof, targets, origins, produced and version', () => {
  const value = expr.variable('a1', 64, true, source(1, 1));
  const wide = expr.unary('trunc', value, 32, false, source(1, 2));
  const narrow = expr.unary('trunc', wide, 8, false, source(1, 3));
  const result = applyPhase8Projection(resultWith(narrow), analysis());

  const collapse = result.renderProvenance.ledger.find((record) => record.kind === 'exact-view-collapse');
  assert.ok(collapse, 'collapse rewrite must be recorded');
  assert.ok(typeof collapse.proof === 'string' && collapse.proof.length > 0, 'proof is required');
  assert.ok(Array.isArray(collapse.targets) && collapse.targets.length > 0, 'targets are required');
  assert.ok(collapse.origin.rows.length > 0, 'consumed origins are required');
  assert.ok(collapse.producedRefs.length > 0, 'produced entity refs are required');
  assert.equal(collapse.version, 1);
});

test('P8-PROV a merged expression record lists consumed origins and the produced entity', () => {
  const value = expr.variable('a1', 64, true, source(1, 1));
  const wide = expr.unary('trunc', value, 32, false, source(1, 2));
  const narrow = expr.unary('trunc', wide, 8, false, source(1, 3));
  const result = applyPhase8Projection(resultWith(narrow), analysis());

  const provenance = result.renderProvenance;
  const collapse = provenance.ledger.find((record) => record.kind === 'exact-view-collapse');
  assert.deepEqual(collapse.origin.rows, [1, 2, 3], 'all consumed origins of the merged chain are listed');
  assert.equal(collapse.producedRefs.length, 1, 'one produced entity');

  const entity = Object.values(provenance.entities).find((candidate) => candidate.entityKey === collapse.producedRefs[0])
    ?? Object.values(provenance.entities).find((candidate) => candidate.recordRefs.includes(provenance.ledger.indexOf(collapse)));
  assert.ok(entity, 'produced ref must resolve to the rendered entity carrying the merge');
  assert.ok(entity.origins.rows.includes(1) && entity.origins.rows.includes(3));
});

test('P8-PROV address-only rewrite records target the canonical address entity', () => {
  const addressOnly = sourceOf({ address:0x4444n, evidence:[{ reason:'address-only-rewrite' }] });
  const value = expr.variable('a1', 64, true, addressOnly);
  const wide = expr.unary('trunc', value, 32, false, addressOnly);
  const narrow = expr.unary('trunc', wide, 8, false, addressOnly);
  const result = applyPhase8Projection(resultWith(narrow), analysis());

  const collapse = result.renderProvenance.ledger.find((record) => record.kind === 'exact-view-collapse');
  assert.ok(collapse, 'address-only collapse rewrite must be recorded');
  // Public ledger addresses use the canonical serializable decimal form.
  assert.deepEqual(collapse.origin.addresses, ['17476']);
  assert.deepEqual(collapse.targets, ['addr:17476']);
  assert.ok(!collapse.targets.some((target) => target.startsWith('proof:')), 'canonical address must not be replaced by proof fallback');
  assert.ok(collapse.producedRefs.length > 0, 'address-only rewrite must remain linked to the rendered entity');
});

test('P8-PROV SSA-use-only rewrite records target the canonical SSA-use entity', () => {
  const ssaUseOnly = sourceOf({ ssaUse:'ssa-use-only', evidence:[{ reason:'ssa-use-only-rewrite' }] });
  const value = expr.variable('a1', 64, true, ssaUseOnly);
  const wide = expr.unary('trunc', value, 32, false, ssaUseOnly);
  const narrow = expr.unary('trunc', wide, 8, false, ssaUseOnly);
  const result = applyPhase8Projection(resultWith(narrow), analysis());

  const collapse = result.renderProvenance.ledger.find((record) => record.kind === 'exact-view-collapse');
  assert.ok(collapse, 'SSA-use-only collapse rewrite must be recorded');
  assert.deepEqual(collapse.origin.ssaUses, ['ssa-use-only']);
  assert.deepEqual(collapse.targets, ['ssa:use:ssa-use-only']);
  assert.ok(!collapse.targets.some((target) => target.startsWith('proof:')), 'canonical SSA use must not be replaced by proof fallback');
  assert.ok(collapse.producedRefs.length > 0, 'SSA-use-only rewrite must remain linked to the rendered entity');
});
