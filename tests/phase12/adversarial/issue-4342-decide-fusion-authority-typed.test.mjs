// Regression for #4342: decide() must not promote structured or non-canonical
// fusion metadata through truthiness or numeric coercion.
import assert from 'node:assert/strict';
import test from 'node:test';
import { decide, VERDICT } from '../../../js/evidence.js';

function candidate(fusion) {
  return { fusion: {
    items: [
      { applied: 1, family: 'name' },
      { applied: 1, family: 'usage' },
      { applied: 1, family: 'naming' },
    ],
    ...fusion,
  } };
}

test('#4342 structured authority fields never confirm', () => {
  const result = decide([candidate({
    logOdds: ['20'], probability: ['0.999'], verified: [], identifying: ['1'],
  })]);
  assert.notEqual(result.verdict, VERDICT.CONFIRMED);
});

test('#4342 canonical primitive authorities preserve confirmation', () => {
  const result = decide([candidate({ logOdds: 20, probability: 0.999, verified: true, identifying: 1 })]);
  assert.equal(result.verdict, VERDICT.CONFIRMED);
});

test('#4342 verified accepts canonical positive count but rejects coercion', () => {
  assert.equal(decide([candidate({ logOdds: 20, probability: 0.999, verified: 1, identifying: 1 })]).verdict, VERDICT.CONFIRMED);
  for (const verified of ['true', [], ['1'], { valueOf: () => 1 }, 1n, NaN, -1, 0]) {
    assert.notEqual(decide([candidate({ logOdds: 20, probability: 0.999, verified, identifying: 1 })]).verdict, VERDICT.CONFIRMED);
  }
});

test('#4342 probability and identifying require finite primitive numbers', () => {
  for (const probability of [NaN, Infinity, -Infinity, -0.1, 1.1, '0.999', 1n, []]) {
    assert.notEqual(decide([candidate({ logOdds: 20, probability, verified: true, identifying: 1 })]).verdict, VERDICT.CONFIRMED);
  }
  for (const identifying of [NaN, Infinity, -1, '1', 1n, []]) {
    assert.notEqual(decide([candidate({ logOdds: 20, probability: 0.999, verified: true, identifying })]).verdict, VERDICT.CONFIRMED);
  }
});

test('#4342 malformed logOdds on either candidate fails closed', () => {
  const top = candidate({ logOdds: 20, probability: 0.999, verified: true, identifying: 1 });
  const malformedRunner = candidate({ logOdds: NaN, probability: 0.999, verified: true, identifying: 1 });
  const result = decide([top, malformedRunner]);
  assert.notEqual(result.verdict, VERDICT.CONFIRMED);
  assert.equal(result.margin, -Infinity);
});

test('#4342 unrelated canonical fuse verdicts remain unchanged', () => {
  const result = decide([candidate({ logOdds: 20, probability: 0.999, verified: true, identifying: 1 })]);
  assert.deepEqual(result.missing, []);
  assert.equal(result.verdict, VERDICT.CONFIRMED);
});

console.log('issue #4342 typed fusion authority regressions PASS');

