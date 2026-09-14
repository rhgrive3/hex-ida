import assert from 'node:assert/strict';
import test from 'node:test';

import { evidence, fuse } from '../js/evidence.js';

function priorOf(opts) {
  return fuse([], opts).prior;
}

test('#3821 numeric counts build the arithmetic denominator', () => {
  assert.equal(priorOf({ candidates: 2, absent: 40 }), 1 / 42);
  assert.equal(priorOf({ candidates: 3, absent: 7 }), 1 / 10);
  assert.equal(priorOf({}), 1 / 240);
});

test('#3821 numeric-string candidates are not concatenated into the denominator', () => {
  const stringy = priorOf({ candidates: '2', absent: 3 });
  assert.notEqual(stringy, 1 / 23, "'2' + 3 must not become '23'");
  assert.equal(stringy, 1 / 203);
});

test('#3821 numeric-string absent is not concatenated into the denominator', () => {
  const stringy = priorOf({ candidates: 5, absent: '40' });
  assert.notEqual(stringy, 1 / 540, "5 + '40' must not become '540'");
  assert.equal(stringy, 1 / 45);
});

test('#3821 structured counts fail closed to the default denominator', () => {
  for (const candidates of [['2'], ['200'], { valueOf: () => 3 }, true, 2n]) {
    for (const absent of [['3'], [], {}, false, Infinity, NaN, -5]) {
      const result = fuse([], { candidates, absent });
      assert.ok(Number.isFinite(result.prior), `prior must stay finite for ${String(candidates)}/${String(absent)}`);
      assert.notEqual(result.prior, 1 / 23);
    }
  }
  assert.equal(priorOf({ candidates: ['2'], absent: ['3'] }), 1 / 240);
  assert.equal(priorOf({ candidates: true, absent: false }), 1 / 240);
});

test('#3821 negative and non-finite counts fail closed to the default denominator', () => {
  assert.equal(priorOf({ candidates: -5, absent: 40 }), 1 / 240);
  assert.equal(priorOf({ candidates: 5, absent: -40 }), 1 / 45);
  assert.equal(priorOf({ candidates: Number.POSITIVE_INFINITY, absent: 40 }), 1 / 240);
  assert.equal(priorOf({ candidates: 5, absent: Number.NaN }), 1 / 45);
});

test('#3821 explicit prior keeps its existing behaviour', () => {
  const explicit = fuse([], { candidates: 2, absent: 40, prior: 0.25 });
  assert.equal(explicit.prior, 0.25);
  assert.equal(explicit.logOdds, Math.log(0.25 / 0.75));
});

test('#3821 count normalisation leaves LR and family fusion untouched', () => {
  const item = evidence('fn-numeric', 1, null, 20);
  const numeric = fuse([item], { candidates: 2, absent: 40 });
  const stringy = fuse([item], { candidates: '2', absent: 40 });
  assert.equal(numeric.items.length, 1);
  assert.equal(numeric.verified, stringy.verified);
  assert.equal(numeric.independentGroups, stringy.independentGroups);
  assert.equal(numeric.logOdds - Math.log(1 / 42 / (1 - 1 / 42)), stringy.logOdds - Math.log(1 / 240 / (1 - 1 / 240)));
});
