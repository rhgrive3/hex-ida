// Issue #5260 regression: FieldIndex.findFields()/findClasses() coerced the
// result limit through Number(), so Array/string/boolean inputs became real
// coverage limits (Number(['1']) === 1, Number(true) === 1) and fractional
// values were adopted as "0.5 results" style caps. A count authority must be
// a primitive positive safe integer.
import assert from 'node:assert/strict';
import test from 'node:test';

import { FieldIndex } from '../js/fields.js';

function index() {
  return new FieldIndex({ classes: [
    { name: 'Player', instanceSize: 64, ivars: [
      { name: '_hp', offset: 8, size: 8 },
      { name: '_mp', offset: 16, size: 8 },
      { name: '_exp', offset: 24, size: 8 },
    ] },
    { name: 'Enemy', instanceSize: 64, ivars: [
      { name: '_hp', offset: 8, size: 8 },
    ] },
  ] });
}

test('#5260 structured and fractional limits are rejected, not coerced', () => {
  const fi = index();
  for (const bad of [['1'], true, false, 0.5, 1.5, '2', NaN, Infinity, -1]) {
    assert.throws(() => fi.findFields(/hp|mp|exp/, bad), TypeError, `findFields limit ${String(bad)} must be rejected`);
    assert.throws(() => fi.findClasses(/Player|Enemy/, bad), TypeError, `findClasses limit ${String(bad)} must be rejected`);
  }
});

test('#5260 omitted and positive-integer limits keep the exact prior behavior', () => {
  const fi = index();
  assert.equal(fi.findFields(/hp|mp|exp/).length, 4, 'omitted limit keeps the default');
  assert.equal(fi.findFields(/hp|mp|exp/, 1).length, 1);
  assert.equal(fi.findFields(/hp|mp|exp/, 2).length, 2);
  assert.equal(fi.findClasses(/Player|Enemy/).length, 2);
  assert.equal(fi.findClasses(/Player|Enemy/, 1).length, 1);
});
