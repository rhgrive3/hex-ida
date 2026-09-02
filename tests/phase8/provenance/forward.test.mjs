import assert from 'node:assert/strict';
import test from 'node:test';

import { applyPhase8Projection } from '../../../js/decompiler/phase8/projection.js';
import { analysis, expr, inductionFact, resultWith, source } from './fixture.js';

function entityForLine(renderProvenance, lineIndex) {
  return Object.values(renderProvenance.entities).find((entity) => entity.lineIndex === lineIndex) ?? null;
}

test('P8-PROV a raw pass-through line resolves to its direct instruction rows', () => {
  const expression = expr.variable('a1', 64, false, source(1, 1));
  const result = applyPhase8Projection(resultWith(expression), analysis());

  const provenance = result.renderProvenance;
  assert.ok(provenance, 'projection must publish render provenance');
  assert.equal(provenance.version, 1);

  const entity = entityForLine(provenance, 0);
  assert.ok(entity, 'the return line must be a rendered entity');
  assert.equal(entity.complete, true, 'raw pass-through must be provenance-complete without synthetic records');
  assert.deepEqual(entity.origins.rows, [1, 4], 'node location row plus expression origin row, no synthetic origins');
  assert.deepEqual(entity.origins.addresses, ['4100', '4112'], String`rows 1 and 4 at 0x1000 + 4*row`);
  assert.deepEqual(entity.reasons, []);
  assert.deepEqual(entity.recordRefs, []);
  assert.equal(provenance.ledger.length, 0, 'no transform records may be invented for untouched lines');
  assert.equal(provenance.completeness, 'complete');
});

test('P8-PROV collapse and induction entities resolve through transform-record origins', () => {
  const value = expr.variable('a1', 64, true, source(1, 1));
  const wide = expr.unary('trunc', value, 32, false, source(2, 2));
  const narrow = expr.unary('trunc', wide, 8, false, source(3, 3));
  const signed = expr.unary('sext', narrow, 32, true, source(4, 4));
  const temporary = expr.variable('v12', 64, false, source(12, 3));
  const condition = expr.compare('ne', temporary, expr.constant(0, 64, false, source(13, 3)), false, source(14, 3));
  const result = applyPhase8Projection(resultWith(signed, { condition }), analysis(inductionFact()));

  const provenance = result.renderProvenance;
  const returnEntity = entityForLine(provenance, 1);
  const conditionEntity = entityForLine(provenance, 0);
  assert.ok(returnEntity, 'return line must map to an entity');
  assert.ok(conditionEntity, 'condition line must map to an entity');
  assert.equal(returnEntity.complete, true);
  for (const row of [1, 2, 3, 4]) {
    assert.ok(returnEntity.origins.rows.includes(row), `collapse chain must retain original row ${row}`);
  }

  const recordRefs = returnEntity.recordRefs;
  assert.ok(recordRefs.length >= 1, 'rewritten lines must reference their transform records');
  for (const index of recordRefs) {
    const record = provenance.ledger[index];
    assert.ok(record, 'record reference must resolve inside the ledger');
  }

  assert.ok(conditionEntity.origins.ssaRefs.includes('def:12'), 'induction entity must expose the SSA def origin');
  assert.ok(
    (provenance.reverse['ssa:def:12'] || []).includes(conditionEntity.entityKey),
    'reverse index must navigate from the SSA origin back to the rendered entity',
  );
  for (const row of [1, 2, 3, 4]) {
    assert.ok((provenance.reverse[`row:${row}`] || []).includes(returnEntity.entityKey),
      `reverse index must navigate row ${row} back to the collapsed entity`);
  }
});

test('P8-PROV a multi-rewrite chain reaches the original instruction rows', () => {
  const value = expr.variable('a1', 64, true, source(1, 1));
  const first = expr.unary('trunc', value, 32, false, source(2, 2));
  const second = expr.unary('trunc', first, 8, false, source(3, 3));
  const third = expr.unary('trunc', second, 4, false, source(4, 4));
  const result = applyPhase8Projection(resultWith(third), analysis());

  const provenance = result.renderProvenance;
  const collapseRecords = provenance.ledger.filter((record) => record.kind === 'exact-view-collapse');
  assert.ok(collapseRecords.length >= 2, 'both chain rewrites must be recorded');

  const entity = entityForLine(provenance, 0);
  assert.equal(entity.complete, true);
  assert.deepEqual(entity.origins.rows, [1, 2, 3, 4], 'final fragment must resolve through the whole chain to the original rows');
});
