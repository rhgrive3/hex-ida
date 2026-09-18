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
      semantic:{ op:'store', expression:expr.variable('a1', 64, false, source(index + 1, index + 1)), location:{ text:`v${index}` } },
    });
  }
  const expression = expr.variable('a1', 64, false, source(1, 1));
  const base = resultWith(expression);
  return {
    ...base,
    cAst:{ ...base.cAst, body:[...body, ...base.cAst.body] },
  };
}

function abortAfter(limit) {
  let polls = 0;
  return {
    shouldAbort() {
      polls += 1;
      return polls > limit;
    },
    polls:() => polls,
  };
}

test('P8-PROV cancellation during a large build returns an explicit incomplete state', () => {
  const projected = applyPhase8Projection(pathologicallyLargeResult(), analysis());
  assert.ok(projected.lines.length > 200, 'fixture must actually retain the large body');
  const abort = abortAfter(8);
  const map = buildRenderProvenance({
    result:projected,
    snapshotId:projected.renderProvenance.snapshotId,
    shouldAbort:abort.shouldAbort,
  });
  assert.ok(abort.polls() > 8, 'cancellation must occur after traversal has begun');
  assert.equal(map.completeness, 'incomplete');
  assert.ok(map.reasons.includes('cancelled'));
  assert.equal(map.budget.truncated, false, 'cancellation is its own conservative state, not truncation');
  assert.equal(Object.keys(map.entities).length, 0, 'cancelled construction must not publish a partial authority map');
});

test('P8-PROV cancellation during large-map validation stops the traversal', () => {
  const projected = applyPhase8Projection(pathologicallyLargeResult(), analysis());
  const abort = abortAfter(8);
  const validation = validateRenderProvenance(projected.renderProvenance, {
    snapshotId:projected.renderProvenance.snapshotId,
    shouldAbort:abort.shouldAbort,
  });
  assert.ok(abort.polls() > 8, 'validation cancellation must occur after entity traversal has begun');
  assert.equal(validation.state, 'incomplete');
  assert.ok(validation.reasons.includes('cancelled'));
  assert.deepEqual(validation.entityStates, [], 'cancelled validation must not publish a prefix as validated authority');
  assert.equal(validation.entityStatesTruncated, Object.keys(projected.renderProvenance.entities).length);
});
