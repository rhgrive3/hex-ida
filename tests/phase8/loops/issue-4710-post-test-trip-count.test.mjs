import assert from 'node:assert/strict';
import test from 'node:test';

import { PASS_STAGES } from '../../../js/decompiler/phase8/contract.js';
import { runPhase8Stage } from '../../../js/decompiler/phase8/index.js';
import { fixture } from '../helpers/ir-fixtures.mjs';

function postTestLoop({
  start = 0,
  bound = 10,
  step = 1n,
  predicate = 'ult',
  bits = 32,
  name = 'issue-4710-post-test',
} = {}) {
  const f = fixture(name);
  f.block(0);
  const init = f.constant(start, bits);
  const limit = f.constant(bound, bits);
  f.branch(1);

  f.block(1, { succ: [1, 2] });
  const counter = f.phi([[0, init], [1, null]], bits);
  const magnitude = f.constant(step < 0n ? -step : step, bits);
  const updated = f.binary(step < 0n ? 'sub' : 'add', counter, magnitude, bits);
  f.closePhi(counter, 1, updated);
  const condition = f.binary(predicate, updated, limit, 1);
  f.conditionalBranch(condition, 1, 2);

  f.block(2);
  f.ret();
  return f.build();
}

function inductionFor(options) {
  const ir = postTestLoop(options);
  const { ledger, analysis } = runPhase8Stage({ ir }, { stages: PASS_STAGES, timeBudgetMs: 2_000 });
  assert.equal(ledger.published, true, 'Phase 8 should publish the post-test fixture');
  const facts = analysis.get('induction');
  assert.equal(facts.loops.length, 1);
  assert.equal(facts.loops[0].inductions.length, 1);
  const fact = facts.loops[0].inductions[0];
  assert.equal(fact.guard.comparesUpdatedValue, true, 'fixture must exercise the post-test guard path');
  return fact;
}

test('#4710: post-test upper-bound loop counts the first update exactly once', () => {
  const fact = inductionFor({ start: 0, bound: 10, step: 1n, predicate: 'ult' });
  assert.equal(fact.tripCount.exact, 10n);
  assert.equal(fact.tripCount.minimum, 10n);
  assert.equal(fact.tripCount.maximum, 10n);
  assert.equal(fact.tripCount.completeness, 'complete');
});

test('#4710: inclusive post-test guard counts through the bound without an extra iteration', () => {
  assert.equal(inductionFor({ start: 0, bound: 10, predicate: 'ule' }).tripCount.exact, 11n);
});

test('#4710: a first updated value that already fails the guard is exactly one body execution', () => {
  assert.equal(inductionFor({ start: 9, bound: 10, predicate: 'ult' }).tripCount.exact, 1n);
});

test('#4710: post-test inequality counts from the first updated state', () => {
  assert.equal(inductionFor({ start: 0, bound: 10, predicate: 'ne', bits: 8 }).tripCount.exact, 10n);
});

test('#4710: init-at-bound inequality does not invent exact one when the update moves away', () => {
  const fact = inductionFor({ start: 10, bound: 10, predicate: 'ne', bits: 8 });
  assert.equal(fact.tripCount.exact, null);
  assert.equal(fact.tripCount.completeness, 'partial');
  assert.match(fact.tripCount.reason, /moves away|wrap/i);
});

test('#4710: decreasing and width-edge post-test loops keep machine-width semantics', () => {
  assert.equal(inductionFor({ start: 10, bound: 0, step: -1n, predicate: 'ugt', bits: 8 }).tripCount.exact, 10n);
  assert.equal(inductionFor({ start: 254, bound: 255, step: 1n, predicate: 'ult', bits: 8 }).tripCount.exact, 1n);

  const wrapping = inductionFor({ start: 255, bound: 0, step: 1n, predicate: 'ne', bits: 8 });
  assert.equal(wrapping.tripCount.exact, null);
  assert.equal(wrapping.tripCount.completeness, 'partial');
});

test('#4710: early-exit upper bound uses the same post-test count', () => {
  const f = fixture('issue-4710-post-test-early-exit');
  f.block(0);
  const init = f.constant(0, 32);
  const limit = f.constant(10, 32);
  const bail = f.opaque(1);
  f.branch(1);

  f.block(1, { succ: [2] });
  const counter = f.phi([[0, init], [3, null]], 32);
  f.branch(2);

  f.block(2, { succ: [3, 4] });
  const updated = f.binary('add', counter, f.constant(1, 32), 32);
  f.closePhi(counter, 3, updated);
  f.conditionalBranch(bail, 4, 3);

  f.block(3, { succ: [1, 4] });
  f.conditionalBranch(f.binary('ult', updated, limit, 1), 1, 4);

  f.block(4);
  f.ret();

  const { analysis } = runPhase8Stage({ ir: f.build() }, { stages: PASS_STAGES, timeBudgetMs: 2_000 });
  const [fact] = analysis.get('induction').loops[0].inductions;
  assert.equal(fact.guard.comparesUpdatedValue, true);
  assert.equal(fact.tripCount.exact, null);
  assert.equal(fact.tripCount.minimum, 0n);
  assert.equal(fact.tripCount.maximum, 10n);
  assert.match(fact.tripCount.reason, /early exit/);
});

test('#4710: signed decreasing and 64-bit post-test counts stay width-exact', () => {
  assert.equal(
    inductionFor({ start: 3, bound: -1, step: -1n, predicate: 'sgt', bits: 32 }).tripCount.exact,
    4n,
  );

  const maxSigned64 = (1n << 63n) - 1n;
  assert.equal(
    inductionFor({ start: maxSigned64 - 2n, bound: maxSigned64, step: 1n, predicate: 'slt', bits: 64 }).tripCount.exact,
    2n,
  );

  const signedWrap = inductionFor({ start: 127, bound: 127, step: 1n, predicate: 'slt', bits: 8 });
  assert.equal(signedWrap.tripCount.exact, null);
  assert.equal(signedWrap.tripCount.completeness, 'partial');
  assert.match(signedWrap.tripCount.reason, /first post-test update wraps/i);
});

test('#4710: non-unit post-test step counts from the guard-visible state', () => {
  assert.equal(inductionFor({ start: 0, bound: 10, step: 3n, predicate: 'ult', bits: 32 }).tripCount.exact, 4n);
});
