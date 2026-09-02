import assert from 'node:assert/strict';
import test from 'node:test';

import { applyPhase8Projection } from '../../../js/decompiler/phase8/projection.js';
import { analysis, expr, resultWith, source } from './fixture.js';

function largeChainResult(depth) {
  let expression = expr.variable('a1', 64, true, source(1));
  let bits = 64;
  for (let index = 0; index < depth; index += 1) {
    bits = Math.floor(bits / 2);
    expression = expr.unary('trunc', expression, bits, false, source(index + 2, index + 2));
  }
  return resultWith(expression);
}

test('P8-PROV the ledger budget truncates explicitly and never silently', () => {
  const result = applyPhase8Projection(largeChainResult(24), analysis(), {
    renderProvenanceBudget:{ maxTransformRecords:4 },
  });
  const provenance = result.renderProvenance;
  assert.ok(provenance.ledger.length <= 4, 'ledger must respect the cap');
  assert.equal(provenance.budget.truncated, true, 'overflow must be explicit');
  assert.ok(provenance.budget.truncatedScopes.includes('ledger'));
  assert.ok(provenance.reasons.includes('truncated'));
  assert.equal(provenance.completeness, 'incomplete');
  assert.ok(provenance.transformCount > provenance.ledger.length, 'truncated records are counted, not lost silently');

  const validation = { reasons:provenance.reasons };
  assert.ok(validation.reasons.includes('truncated'));
});

test('P8-PROV the per-entity origin budget truncates explicitly', () => {
  const result = applyPhase8Projection(largeChainResult(24), analysis(), {
    renderProvenanceBudget:{ maxOriginsPerEntity:2 },
  });
  const provenance = result.renderProvenance;
  assert.equal(provenance.budget.truncated, true);
  assert.ok(provenance.budget.truncatedScopes.includes('origins'));
  for (const entity of Object.values(provenance.entities)) {
    assert.ok(entity.origins.rows.length <= 2, 'per-entity rows must respect the cap');
    if (entity.origins.rows.length === 2) {
      assert.equal(entity.complete, false, 'a truncated origin set must not claim completeness');
      assert.ok(entity.reasons.includes('truncated'));
    }
  }
});
