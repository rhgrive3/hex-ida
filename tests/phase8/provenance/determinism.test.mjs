import assert from 'node:assert/strict';
import test from 'node:test';

import { applyPhase8Projection } from '../../../js/decompiler/phase8/projection.js';
import { analysis, expr, inductionFact, resultWith, source } from './fixture.js';

function canonicalEvidenceOf(input) {
  const evidence = {
    rows:new Set(),
    addresses:new Set(),
    ir:new Set(),
    ssa:new Set(),
  };
  const seen = new Set();
  const addSource = (value) => {
    if (!value || typeof value !== 'object') return;
    for (const row of value.rows ?? []) evidence.rows.add(String(row));
    for (const address of value.addresses ?? []) evidence.addresses.add(String(address));
    for (const ir of value.ir ?? []) evidence.ir.add(String(ir));
    for (const def of value.ssaDefs ?? []) evidence.ssa.add(`def:${def}`);
    for (const use of value.ssaUses ?? []) evidence.ssa.add(`use:${use}`);
  };
  const walk = (value) => {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    addSource(value.source);
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === 'source') continue;
      walk(child);
    }
  };
  walk(input.cAst);
  walk(input.semanticAst);
  return evidence;
}

function assertOriginsAreCanonical(origin, canonical, label) {
  for (const row of origin?.rows ?? []) {
    assert.ok(canonical.rows.has(String(row)), `${label} row ${row} must come from immutable input evidence`);
  }
  for (const address of origin?.addresses ?? []) {
    assert.ok(canonical.addresses.has(String(address)), `${label} address ${address} must come from immutable input evidence`);
  }
  for (const ir of origin?.ir ?? []) {
    assert.ok(canonical.ir.has(String(ir)), `${label} ir ${ir} must come from immutable input evidence`);
  }
  for (const def of origin?.ssaDefs ?? []) {
    assert.ok(canonical.ssa.has(`def:${def}`), `${label} SSA def ${def} must come from immutable input evidence`);
  }
  for (const use of origin?.ssaUses ?? []) {
    assert.ok(canonical.ssa.has(`use:${use}`), `${label} SSA use ${use} must come from immutable input evidence`);
  }
  for (const ref of origin?.ssaRefs ?? []) {
    assert.ok(canonical.ssa.has(ref), `${label} SSA ref ${ref} must come from immutable input evidence`);
  }
}

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

test('P8-PROV provenance references only immutable pre-projection evidence (no minted identities)', () => {
  const value = expr.variable('a1', 64, true, source(1));
  const wide = expr.unary('trunc', value, 32, false, source(2));
  const narrow = expr.unary('trunc', wide, 8, false, source(3));
  const input = resultWith(narrow);
  const canonical = canonicalEvidenceOf(input);
  const result = applyPhase8Projection(input, analysis());

  for (const [index, record] of result.renderProvenance.ledger.entries()) {
    assertOriginsAreCanonical(record.origin, canonical, `ledger[${index}]`);
  }
  for (const entity of Object.values(result.renderProvenance.entities)) {
    assertOriginsAreCanonical(entity.origins, canonical, entity.entityKey);
  }
});
