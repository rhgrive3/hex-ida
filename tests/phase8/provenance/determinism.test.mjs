import assert from 'node:assert/strict';
import test from 'node:test';

import { applyPhase8Projection } from '../../../js/decompiler/phase8/projection.js';
import { analysis, expr, inductionFact, resultWith, source } from './fixture.js';

test('P8-PROV identical inputs produce byte-identical provenance maps', () => {
  const value = expr.variable('a1', 64, true, source(1, 1));
  const wide = expr.unary('trunc', value, 32, false, source(2, 2));
  const narrow = expr.unary('trunc', wide, 8, false, source(3, 3));
  const temporary = expr.variable('v12', 64, false, source(12, 3));
  const condition = expr.compare('ne', temporary, expr.constant(0, 64, false, source(13, 3)), false, source(14, 3));
  const first = applyPhase8Projection(resultWith(narrow, { condition }), analysis(inductionFact()));
  const second = applyPhase8Projection(resultWith(narrow, { condition }), analysis(inductionFact()));

  const serialize = (value) => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? `${item}n` : item);
  assert.equal(serialize(first.renderProvenance), serialize(second.renderProvenance));
});

test('P8-PROV provenance references only existing canonical evidence (no minted identities)', () => {
  const value = expr.variable('a1', 64, true, source(1));
  const wide = expr.unary('trunc', value, 32, false, source(2));
  const narrow = expr.unary('trunc', wide, 8, false, source(3));
  const result = applyPhase8Projection(resultWith(narrow), analysis());

  const canonicalRows = new Set();
  const canonicalIr = new Set();
  const canonicalSsa = new Set();
  for (const line of result.lines) {
    for (const row of line.source?.rows ?? []) canonicalRows.add(String(row));
    for (const ir of line.source?.ir ?? []) canonicalIr.add(String(ir));
    for (const def of line.source?.ssaDefs ?? []) canonicalSsa.add(`def:${def}`);
    for (const use of line.source?.ssaUses ?? []) canonicalSsa.add(`use:${use}`);
  }
  for (const record of result.renderProvenance.ledger) {
    for (const row of record.origin?.rows ?? []) canonicalRows.add(String(row));
    for (const ir of record.origin?.ir ?? []) canonicalIr.add(String(ir));
    for (const def of record.origin?.ssaDefs ?? []) canonicalSsa.add(`def:${def}`);
    for (const use of record.origin?.ssaUses ?? []) canonicalSsa.add(`use:${use}`);
  }

  for (const entity of Object.values(result.renderProvenance.entities)) {
    for (const row of entity.origins.rows) assert.ok(canonicalRows.has(String(row)), `row ${row} must come from canonical evidence`);
    for (const ir of entity.origins.ir) assert.ok(canonicalIr.has(String(ir)), `ir ${ir} must come from canonical evidence`);
    for (const ref of entity.origins.ssaRefs) assert.ok(canonicalSsa.has(ref), `ssa ref ${ref} must come from canonical evidence`);
  }
});
