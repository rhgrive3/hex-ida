import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyDeobfuscationCandidate, isAdoptableCandidate, expr as E } from '../../../js/symbolic/index.js';
import { identity } from './fixtures.mjs';
const request = (before, after, extra = {}) => ({ candidateId: 'scoped', beforeValueId: 'before', afterValueId: 'after',
  before, after, identity, memoryObservables: [], effectObservables: [], ...extra });

test('a valid conditional proof cannot be consumed as unconditional equivalence', async () => {
  const x = E.createFreshSymbol(E.bvSort(3), 'conditional-input'), zero = E.createBv(3, 0n);
  const condition = E.createCompare('eq', x, zero), preconditions = [condition];
  const result = await verifyDeobfuscationCandidate(request(x, zero, { preconditions }));
  assert.equal(result.eligible, true, result.reason);
  assert.equal(isAdoptableCandidate(result), false);
  assert.equal(isAdoptableCandidate(result, { preconditions: [condition] }), true);
  assert.equal(isAdoptableCandidate(result, { preconditions: [E.createCompare('eq', x, E.createBv(3, 1n))] }), false);
  assert.equal(E.evaluateExpr(x, { [x.symbolId]: 1n }).value, 1n); // Independent refutation without the condition.
  preconditions.length = 0;
  assert.equal(isAdoptableCandidate(result, { preconditions }), false);
  assert.equal(isAdoptableCandidate(result, { preconditions: [condition] }), true);
});

test('renamed-input proofs require the exact current correspondence at consumption', async () => {
  const x = E.createFreshSymbol(E.bvSort(3), 'before-input'), y = E.createFreshSymbol(E.bvSort(3), 'after-input');
  const inputs = [{ before: x.symbolId, after: y.symbolId }];
  const result = await verifyDeobfuscationCandidate(request(x, y, { correspondence: { inputs } }));
  assert.equal(result.eligible, true, result.reason);
  assert.equal(isAdoptableCandidate(result), false);
  assert.equal(isAdoptableCandidate(result, { correspondence: { inputs } }), true);
  inputs[0].after = x.symbolId;
  assert.equal(isAdoptableCandidate(result, { correspondence: { inputs } }), false);
});

test('unconditional identity-mapped pure proofs retain the existing consumption API', async () => {
  const x = E.createFreshSymbol(E.bvSort(3), 'unconditional-input');
  const result = await verifyDeobfuscationCandidate(request(E.createBinary('xor', x, x), E.createBv(3, 0n)));
  assert.equal(result.eligible, true, result.reason);
  assert.equal(isAdoptableCandidate(result), true);
  assert.equal(isAdoptableCandidate(result, { preconditions: [E.createBool(true)] }), false);
});
