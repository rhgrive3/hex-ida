import assert from 'node:assert/strict';
import test from 'node:test';

import { applyPhase8Projection } from '../../../js/decompiler/phase8/projection.js';
import { analysis, expr, resultWith, source } from './fixture.js';

test('P8-PROV ledger records auditable removal state for every transform', () => {
  const value = expr.variable('a1', 64, true, source(1));
  const wide = expr.unary('trunc', value, 32, false, source(2));
  const narrow = expr.unary('trunc', wide, 8, false, source(3));
  const signed = expr.unary('sext', narrow, 32, true, source(4));
  const result = applyPhase8Projection(resultWith(signed), analysis());

  const provenance = result.renderProvenance;
  assert.ok(provenance.ledger.length >= 1, 'the collapse rewrite must be in the ledger');
  for (const record of provenance.ledger) {
    assert.ok(Array.isArray(record.producedRefs), 'removal auditability requires produced entity refs');
    assert.ok(Array.isArray(record.removedRefs), 'removal auditability requires removed entity refs');
    assert.equal(record.version, 1);
  }

  const collapse = provenance.ledger.find((record) => record.kind === 'exact-view-collapse');
  assert.ok(collapse, 'the collapse record must be present');
  assert.ok(collapse.producedRefs.length >= 1, 'the merged expression must name its produced rendered entity');
  assert.deepEqual(collapse.removedRefs, [], 'current Phase 8 rewrites rewrite in place and remove nothing');
});
