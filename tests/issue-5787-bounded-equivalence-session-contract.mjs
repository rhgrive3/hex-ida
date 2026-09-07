import assert from 'node:assert/strict';
import test from 'node:test';

import { bvSort, BV_BINARY_OP } from '../js/symbolic/expr/kinds.js';
import { createFreshSymbol, createBv, createBinary } from '../js/symbolic/expr/factory.js';
import { verifyBoundedEquivalence } from '../js/symbolic/verify/equivalence.js';
import { VERDICT } from '../js/symbolic/verify/query.js';

function sameExprPair() {
  const x = createFreshSymbol(bvSort(4), 'x');
  const before = createBinary(BV_BINARY_OP.ADD, x, x);
  const after = createBinary(BV_BINARY_OP.SHL, x, createBv(4, 1));
  return { before, after };
}

test('#5787 a check()-only session on the UNSAT path does not throw a TypeError', async () => {
  const { before, after } = sameExprPair();
  const session = {
    async check() {
      return { status: 'unsat', lifecycle: {} };
    },
  };
  const res = await verifyBoundedEquivalence({ beforeTarget: before, afterTarget: after, session });
  assert.equal(res.verdict, VERDICT.UNKNOWN);
  assert.equal(res.reasonCode, 'proof-ineligible');
});

test('#5787 a session with isCancelled() keeps the cancel gate behaviour', async () => {
  const { before, after } = sameExprPair();
  const session = {
    isCancelled() { return true; },
    async check() {
      return { status: 'unsat', lifecycle: {} };
    },
  };
  const res = await verifyBoundedEquivalence({ beforeTarget: before, afterTarget: after, session });
  assert.equal(res.verdict, VERDICT.UNKNOWN);
  assert.equal(res.reasonCode, 'proof-ineligible');
});
