import assert from 'node:assert/strict';
import test from 'node:test';

import { callArgumentIndices, knownCallPrototype, normalizeExternalSymbol } from '../../../js/decompiler/call-prototypes.js';

test('#4143 thunk/import prefixes stacking C underscore decoration normalize', () => {
  assert.equal(normalizeExternalSymbol('j__puts'), 'puts');
  assert.equal(normalizeExternalSymbol('imp__printf'), 'printf');
  assert.equal(normalizeExternalSymbol('j_imp__snprintf'), 'snprintf');
  assert.equal(normalizeExternalSymbol('__imp_puts'), 'puts');
  const proto = knownCallPrototype('j__puts');
  assert.deepEqual(
    { name: proto?.name, arity: proto?.arity, variadic: proto?.variadic },
    { name: 'puts', arity: 1, variadic: false },
  );
  assert.deepEqual(knownCallPrototype('imp__printf'), { name: 'printf', arity: 1, variadic: true, confidence: 0.95 });
  assert.deepEqual(callArgumentIndices({ name: 'j__puts' }), [0]);
});

test('#4143 single-decoration and undecorated names keep their normalization', () => {
  for (const [input, expected] of [
    ['_puts', 'puts'],
    ['j_puts', 'puts'],
    ['imp_printf', 'printf'],
    ['puts', 'puts'],
    ['foo', 'foo'],
    ['puts@plt', 'puts'],
  ]) {
    assert.equal(normalizeExternalSymbol(input), expected, `${input} → ${expected}`);
  }
});
