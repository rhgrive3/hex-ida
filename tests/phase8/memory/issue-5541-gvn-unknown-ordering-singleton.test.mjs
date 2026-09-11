import assert from 'node:assert/strict';
import test from 'node:test';

import { runPassTransaction, seedAnalysisState } from '../../../js/decompiler/phase8/transaction.js';
import { SCCP_PASS, runSccpPass } from '../../../js/decompiler/phase8/sccp.js';
import { GVN_PASS, loadIsReusable, runGvnPass } from '../../../js/decompiler/phase8/valuenumber.js';
import { fixture } from '../helpers/ir-fixtures.mjs';

// #5541: GVN treated memoryAccess.ordering:'unknown' as proof that a load
// imposes no ordering. "unknown is not permission" is the phase's contract:
// a load whose ordering is an unproved absence-of-fact stays a singleton and
// is never offered as a reuse candidate.

const analyze = (ir) => {
  const state = seedAnalysisState(ir);
  const context = { analysis: state, ir };
  runPassTransaction(state, { descriptor: SCCP_PASS, run: runSccpPass }, context, {});
  const outcome = runPassTransaction(state, { descriptor: GVN_PASS, run: runGvnPass }, context, {});
  return { outcome, facts: state.get('valueNumbers'), state };
};

const congruent = (facts, left, right) => facts.numbers.get(left.id) === facts.numbers.get(right.id);

test('#5541: an unproved ordering blocks load reuse instead of laundering it', () => {
  const verdict = loadIsReusable({
    extra: { memoryAccess: { addressSpace: 'memory', volatility: false, atomic: false, ordering: 'unknown' }, addressPrecise: true },
    loc: { key: 'global:x' },
  });
  assert.equal(verdict.ok, false, 'ordering:unknown is an absence of a fact, not proof of no ordering');
  assert.match(verdict.reason, /ordering/);
});

test('#5541: proved non-ordering spellings stay reusable', () => {
  const withoutOrdering = loadIsReusable({
    extra: { memoryAccess: { addressSpace: 'memory', volatility: false, atomic: false, ordering: null }, addressPrecise: true },
    loc: { key: 'global:x' },
  });
  assert.equal(withoutOrdering.ok, true);

  const relaxed = loadIsReusable({
    extra: { memoryAccess: { addressSpace: 'memory', volatility: false, atomic: false, ordering: 'relaxed' }, addressPrecise: true },
    loc: { key: 'global:x' },
  });
  assert.equal(relaxed.ok, true);
});

test('#5541: two unknown-ordering loads of one location are singletons, not a class', () => {
  const f = fixture('gvn-unknown-ordering');
  f.block(0);
  const facts = { locKey: 'field:root+0', addressSpace: 'memory', volatility: false, atomic: false, ordering: 'unknown', memDefs: ['store_1'], addressPrecise: true };
  const first = f.load(32, facts);
  const second = f.load(32, facts);
  f.ret();
  const { facts: valueNumbers } = analyze(f.build());
  assert.equal(congruent(valueNumbers, first, second), false, 'an unknown ordering cannot ground congruence');
  assert.match(valueNumbers.singletonReasons.get(second.id) ?? '', /ordering/);
  assert.equal(valueNumbers.reuseCandidates.some((entry) => entry.valueId === second.id), false);
});
