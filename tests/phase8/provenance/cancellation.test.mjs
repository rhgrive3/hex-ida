import assert from 'node:assert/strict';
import test from 'node:test';

import { buildRenderProvenance, validateRenderProvenance } from '../../../js/decompiler/phase8/render-provenance.js';
import { applyPhase8Projection } from '../../../js/decompiler/phase8/projection.js';
import { analysis, expr, resultWith, source } from './fixture.js';

function pathologicallyLargeResult() {
  const body = [];
  for (let index = 0; index < 256; index += 1) {
    body.push({
      kind:'stmt',
      indent:1,
      text:`v${index} = a1;`,
      source:source(index + 1, index + 1),
      semantic:{ op:'store', expression:expr.variable(`a1`, 64, false, source(index + 1, index + 1)), location:{ text:`v${index}` } },
    });
  }
  const expression = expr.variable('a1', 64, false, source(1, 1));
  return resultWith(expression);
}

test('P8-PROV cancellation during the build returns an explicit incomplete state', () => {
  const expression = expr.variable('a1', 64, false, source(1, 1));
  const result = applyPhase8Projection(resultWith(expression), analysis());
  const map = buildRenderProvenance({
    result,
    snapshotId:result.renderProvenance.snapshotId,
    shouldAbort:() => true,
  });
  assert.equal(map.completeness, 'incomplete');
  assert.ok(map.reasons.includes('cancelled'));
  assert.equal(map.budget.truncated, false, 'cancellation is its own conservative state, not truncation');
});

test('P8-PROV cancellation during validation returns an explicit incomplete state', () => {
  const expression = expr.variable('a1', 64, false, source(1, 1));
  const result = applyPhase8Projection(resultWith(expression), analysis());
  const validation = validateRenderProvenance(result.renderProvenance, {
    snapshotId:result.renderProvenance.snapshotId,
    shouldAbort:() => true,
  });
  assert.equal(validation.state, 'incomplete');
  assert.ok(validation.reasons.includes('cancelled'));
});
