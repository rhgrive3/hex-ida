import test from 'node:test';
import assert from 'node:assert/strict';
import { deterministicChoice, g28Eligible, requestBody, validateResponse } from './collect.mjs';

test('frozen lexical comparator selects the score winner and keeps baseline on a tie', () => {
  assert.equal(deterministicChoice({ query: 'video timer', candidates: [
    { fieldName: '_timer', className: 'A' }, { fieldName: '_videoTimer', className: 'B' },
  ] }), 1);
  assert.equal(deterministicChoice({ query: 'timer', candidates: [
    { fieldName: '_timer', className: 'A' }, { fieldName: '_timer', className: 'B' },
  ] }), 0);
  assert.equal(deterministicChoice({ query: 'timer', candidates: [] }), null);
});

test('G28 evaluation composition uses only observable mode, verdict, lattice and lexical index', () => {
  assert.equal(g28Eligible('partial', 'confirmed', 2, 0), true);
  assert.equal(g28Eligible('partial', 'likely', 1, 0), true);
  assert.equal(g28Eligible('partial', 'ambiguous', 2, 0), false);
  assert.equal(g28Eligible('exact', 'confirmed', 2, 0), false);
  assert.equal(g28Eligible('partial', 'confirmed', 2, 1), false);
  assert.equal(g28Eligible('partial', 'confirmed', 0, null), false);
});

test('label-only OpenJev body and fail-closed response validation match frozen contract', () => {
  const row = { query: 'remote asset URL', mode: 'partial', candidates: [
    { fieldName: '_remoteURL' }, { fieldName: '_assetURL' },
  ] };
  const body = requestBody(row);
  assert.equal(body.model, 'openjev');
  assert.deepEqual(body.questions.pick.criteria, { c0: '_remoteURL', c1: '_assetURL' });
  assert.equal(body.questions.pick.type, 'choice');
  assert.equal(body.questions.unique.type, 'noul');
  const valid = { model: 'openjev', answers: { pick: { type: 'choice', choice: 'c1',
    probabilities: { c1: 0.8 }, confidence: 0.7 }, unique: { type: 'noul', noul: 0.3 } } };
  assert.equal(validateResponse(valid, 2), null);
  assert.equal(validateResponse({ ...valid, model: 'different' }, 2), 'model-mismatch');
  assert.equal(validateResponse({ ...valid, answers: { ...valid.answers,
    pick: { ...valid.answers.pick, choice: 'c2' } } }, 2), 'invalid-candidate');
  assert.equal(validateResponse({ ...valid, answers: { ...valid.answers,
    unique: { type: 'noul', noul: 2 } } }, 2), 'malformed-unique');
});
