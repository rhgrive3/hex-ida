import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveStep } from '../../../js/decompiler/phase8/induction.js';
import { bitvector } from '../../../js/decompiler/phase8/bitvector.js';
import { singletonFact } from '../../../js/decompiler/phase8/range.js';
import { fixture } from '../helpers/ir-fixtures.mjs';

/*
 * The downstream consumer receives the immutable product fact, not a private
 * range calculation.  The synthetic canonical result intentionally omits the
 * compatibility `constants` map so this regression cannot pass by accidentally
 * using the old projection.
 */
function stepFixture() {
  const f = fixture('c2-02-downstream-step');
  f.block(0);
  const counter = f.opaque(32);
  const amount = f.opaque(32);
  const update = f.binary('add', counter, amount, 32);
  return { counter, amount, update };
}

test('induction consumes an exact canonical scalar fact without a duplicate analysis', () => {
  const { counter, amount, update } = stepFixture();
  const canonical = {
    completeness: 'complete',
    facts: new Map([[amount.id, singletonFact(bitvector(7n, 32), { valueId: amount.id })]]),
    constants: new Map(),
  };
  const resolved = resolveStep(update, counter, { rangeFacts: canonical });
  assert.equal(resolved.step, 7n);
  assert.equal(resolved.reason, null);
});

test('induction refuses singleton-looking partial canonical facts', () => {
  const { counter, amount, update } = stepFixture();
  const partialFact = singletonFact(bitvector(7n, 32), { valueId: amount.id, status: 'partial' });
  const canonical = { completeness: 'partial', facts: new Map([[amount.id, partialFact]]), constants: new Map() };
  const resolved = resolveStep(update, counter, { rangeFacts: canonical });
  assert.equal(resolved.step, null);
  assert.equal(resolved.reason, 'the step is a variable value');
});
