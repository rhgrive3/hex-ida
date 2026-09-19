import assert from 'node:assert/strict';
import test from 'node:test';

import { runPassTransaction, seedAnalysisState } from '../../js/decompiler/phase8/transaction.js';
import { SCCP_PASS, runSccpPass } from '../../js/decompiler/phase8/sccp.js';
import { fixture } from '../phase8/helpers/ir-fixtures.mjs';

test('SCCP switch validation does not rescan normalized cases quadratically', () => {
  const count = 96;
  const f = fixture('switch-case-indexing');
  f.block(0);
  const selector = f.opaque(16);
  f.switchBranch(selector, Array.from({ length:count }, (_, index) => [index, index + 1]), count + 1);
  for (let index = 1; index <= count + 1; index += 1) f.block(index).ret();
  const state = seedAnalysisState(f.build());
  const originalFind = Array.prototype.find;
  const originalSome = Array.prototype.some;
  let normalizedCaseFinds = 0;
  let duplicateCaseNestedScans = 0;
  Array.prototype.find = function patchedFind(...args) {
    if (String(args[0]).includes('candidate.index === index')) normalizedCaseFinds += 1;
    return Reflect.apply(originalFind, this, args);
  };
  Array.prototype.some = function patchedSome(...args) {
    if (String(args[0]).includes('other.value === entry.value')) duplicateCaseNestedScans += 1;
    return Reflect.apply(originalSome, this, args);
  };
  let outcome;
  try {
    outcome = runPassTransaction(state, { descriptor:SCCP_PASS, run:runSccpPass }, { analysis:state }, {});
  } finally {
    Array.prototype.find = originalFind;
    Array.prototype.some = originalSome;
  }
  assert.equal(outcome.committed, true);
  assert.equal(normalizedCaseFinds, 0, `SCCP performed ${normalizedCaseFinds} normalized-case linear finds`);
  assert.equal(duplicateCaseNestedScans, 0, `SCCP performed ${duplicateCaseNestedScans} nested duplicate-case scans`);
});
