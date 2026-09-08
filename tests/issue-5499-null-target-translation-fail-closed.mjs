import assert from 'node:assert/strict';
import test from 'node:test';

import { translateSemanticIR } from '../js/symbolic/translate/semantic-ir.js';

test('#5499 a null target must fail closed as unsupported, not exact', () => {
  const out = translateSemanticIR(null);
  assert.equal(out.status, 'unsupported');
  assert.equal(out.expression, null);
  assert.equal(out.completeness.translation, 'unsupported');
  assert.ok(out.unsupportedEntities.some((entity) => entity.reason === 'missing-translation-target'));
  assert.ok(out.semanticUnknowns >= 1);
});

test('#5499 an object without translatable discriminators fails closed too', () => {
  const out = translateSemanticIR({});
  assert.equal(out.status, 'unsupported');
  assert.equal(out.expression, null);
  assert.equal(out.completeness.translation, 'unsupported');
  assert.ok(out.unsupportedEntities.some((entity) => entity.reason === 'missing-translation-target'));
});

test('#5499 translatable targets keep their exact contract', () => {
  const exact = translateSemanticIR({ id: 'a0', kind: 'arg', reg: 'x0', index: 0 }, { bitWidth: 64 });
  assert.equal(exact.status, 'exact');
  assert.ok(exact.expression);
  assert.equal(exact.completeness.translation, 'complete');

  const constTarget = translateSemanticIR({ const: 42n }, { bitWidth: 64 });
  assert.equal(constTarget.status, 'exact');
  assert.ok(constTarget.expression);

  const instruction = translateSemanticIR({ op: 'add', id: 'i1', operands: [], const: 1n }, { bitWidth: 64 });
  assert.ok(instruction.expression || instruction.unsupportedEntities.length > 0);
});
