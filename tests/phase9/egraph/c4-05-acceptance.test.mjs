import test from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../../../js/symbolic/expr/index.js';
import * as S from '../../../js/symbolic/index.js';
import {
  EGRAPH_RULE_ORDERS,
  EGRAPH_LIMITS,
  orderEqualityProposals,
  saturatePureExpression,
} from '../../../js/symbolic/egraph/graph.js';
import { EQUALITY_RULESET_VERSION } from '../../../js/symbolic/egraph/rules.js';
import { queryEqualitySaturation } from '../../../js/symbolic/query/equality-saturation.js';
import { verifyDeobfuscationCandidate, isAdoptableCandidate } from '../../../js/symbolic/taint/proof-consumer.js';
import { createQueryGuard } from '../../../js/symbolic/memory/query-state.js';
import {
  WIDTHS,
  FAMILY_IDS,
  fixture,
  boundedProofCell,
  assertWithheld,
  checkConcrete,
  boolFixtures,
} from '../helpers/egraph-family-fixtures.mjs';
import { identity } from '../taint/fixtures.mjs';

const b = E.createBinary, c = (n, w = 4) => E.createBv(w, BigInt(n));
const guard = () => createQueryGuard({ identity, timeoutMs: 2000 }, EGRAPH_LIMITS);
const choices = search => search.choices.map(ch => ({ digest: ch.digest, cost: ch.cost }));

test('C4-05 denominator is frozen to 34 scalar families, 8 widths, 3 schedules, and 14 Bool families', () => {
  assert.equal(FAMILY_IDS.length, 34);
  assert.equal(new Set(FAMILY_IDS).size, 34);
  assert.deepEqual(WIDTHS, [1, 2, 3, 4, 8, 16, 32, 64]);
  assert.equal(WIDTHS.length * FAMILY_IDS.length, 272);
  assert.deepEqual(EGRAPH_RULE_ORDERS, ['canonical', 'reverse', 'discovery']);
  assert.ok(Object.isFrozen(EGRAPH_RULE_ORDERS));
  assert.equal(boolFixtures().cases.length, 14);
  for (const [key, val] of Object.entries(EGRAPH_LIMITS)) {
    assert.ok(Number.isSafeInteger(val) && val > 0, `limit ${key}`);
  }
});

test('C4-05 rule scheduling actually permutes proposals and reaches identical Pareto choices under all 3 schedules', () => {
  const proposals = [{ rule: 'a', owner: 2, after: {} }, { rule: 'z', owner: 3, after: {} }, { rule: 'a', owner: 1, after: {} }];
  const expected = { canonical: [2, 0, 1], reverse: [1, 0, 2], discovery: [0, 1, 2] };
  for (const order of EGRAPH_RULE_ORDERS) {
    const pending = [...proposals], g = guard();
    assert.equal(orderEqualityProposals(pending, g, order), pending);
    assert.deepEqual(pending.map(p => proposals.indexOf(p)), expected[order]);
    assert.equal(g.metrics().workItems, 6);
  }
  // Sample representative scalar families across small and native widths
  for (const family of ['xor-self', 'sub-self', 'and-mask', 'absorb-and', 'factor-mul', 'mba-add']) {
    for (const width of [4, 16, 32]) {
      const f = fixture(family, width);
      const baseline = saturatePureExpression(f.before, guard());
      for (const order of EGRAPH_RULE_ORDERS) {
        const search = saturatePureExpression(f.before, guard(), order);
        assert.equal(search.ruleOrder, order);
        assert.equal(search.saturated, true);
        assert.deepEqual(choices(search), choices(baseline), `${f.id}/${order}`);
      }
    }
  }
});

test('C4-05 candidate generation never creates semantic authority and requires independent proof', async () => {
  const x = E.createFreshSymbol(E.bvSort(4), 'c405_x');
  const expr = b('xor', x, x);
  const r = await queryEqualitySaturation({
    expression: expr,
    valueId: 'c405_test',
    identity,
    memoryObservables: [],
    effectObservables: [],
    timeoutMs: 2000,
    backendTier: 'tiered',
  });
  assert.equal(r.status, 'complete', r.reason);
  assert.ok(r.candidates.length > 0);
  const cand = r.candidates[0];
  assert.equal(cand.eligible, true);
  assert.equal(isAdoptableCandidate(cand.verification, { identity, before: cand.before, after: cand.after }), true);
  // Unverified/tampered receipts are rejected
  assert.equal(isAdoptableCandidate({ ...cand.verification }), false);
  assert.equal(isAdoptableCandidate(cand.verification, { identity: { ...identity, snapshotId: 'fake' } }), false);
  assert.equal(isAdoptableCandidate(cand.verification, { identity, before: cand.after, after: cand.after }), false);
});

test('C4-05 near-MBA counterexamples remain refuted and unadoptable', async () => {
  for (const width of [4, 8, 16, 32]) {
    const f = fixture('mba-add', width);
    const wrong = b('add', b('add', f.x, f.y), E.createBv(width, 1n));
    const result = await verifyDeobfuscationCandidate({
      before: f.before,
      after: wrong,
      identity,
      candidateId: `wrong:${f.id}`,
      beforeValueId: f.id,
      afterValueId: `wrong:${f.id}`,
      memoryObservables: [],
      effectObservables: [],
      timeoutMs: 2000,
      backendTier: 'tiered',
    });
    assert.equal(result.verdict, 'refuted');
    assert.equal(result.eligible, false);
    assert.equal(isAdoptableCandidate(result), false);
    assert.ok(result.counterexample, `${f.id} must retain counterexample witness`);
  }
});

test('C4-05 memory, side-effects, unknown semantics, and contradictory preconditions fail closed', async () => {
  const x = E.createFreshSymbol(E.bvSort(4), 'fail_x');
  for (const extra of [
    { memoryObservables: [{ id: 'heap' }] },
    { effectObservables: [{ id: 'call' }] },
    { rules: [] },
    { verified: true },
    { backend: { check: () => ({ status: 'unsat' }) } },
    { executionSnapshot: {} },
  ]) {
    const r = await queryEqualitySaturation({
      expression: b('sub', x, x),
      valueId: 'fail_val',
      identity,
      memoryObservables: [],
      effectObservables: [],
      timeoutMs: 2000,
      ...extra,
    });
    assert.equal(r.status, 'partial');
    assert.deepEqual(r.candidates, []);
  }
  const contradictory = await queryEqualitySaturation({
    expression: b('sub', x, x),
    valueId: 'contra_val',
    identity,
    memoryObservables: [],
    effectObservables: [],
    preconditions: [E.createBool(false)],
    timeoutMs: 2000,
  });
  assert.equal(contradictory.status, 'complete');
  assert.equal(contradictory.candidates.filter(c => c.eligible).length, 0);
});

test('C4-05 bounded proof cells withhold unproved candidates without publishing receipts', async () => {
  for (const { family, width } of [
    { family: 'factor-mul', width: 16 },
    { family: 'xor-cancel', width: 16 },
  ]) {
    assert.ok(boundedProofCell(family, width));
    const f = fixture(family, width);
    for (const order of EGRAPH_RULE_ORDERS) {
      const r = await queryEqualitySaturation({
        expression: f.before,
        valueId: f.id,
        identity,
        memoryObservables: [],
        effectObservables: [],
        timeoutMs: 2000,
        backendTier: 'tiered',
        ruleOrder: order,
      });
      assertWithheld(r, `${f.id}/${order}`);
      assert.deepEqual(r.candidates, []);
    }
  }
});

test('C4-05 work, iteration, cancellation, and deadline budgets terminate deterministically', async () => {
  const x = E.createFreshSymbol(E.bvSort(4), 'budget_x');
  for (const limits of [{ workItems: 0 }, { iterations: 0 }, { unions: 0 }, { candidates: 0 }, { enodes: 0 }]) {
    const r = await queryEqualitySaturation({
      expression: b('sub', x, x),
      valueId: 'budget_val',
      identity,
      memoryObservables: [],
      effectObservables: [],
      limits,
      timeoutMs: 2000,
    });
    assert.equal(r.status, 'partial');
    assert.deepEqual(r.candidates, []);
  }
  // Cancellation and zero timeout
  const ac = new AbortController();
  const pending = queryEqualitySaturation({
    expression: b('sub', x, x),
    valueId: 'cancel_val',
    identity,
    memoryObservables: [],
    effectObservables: [],
    signal: ac.signal,
    timeoutMs: 2000,
  });
  ac.abort();
  const cancelled = await pending;
  assert.equal(cancelled.status, 'partial');
  assert.deepEqual(cancelled.candidates, []);
  const expired = await queryEqualitySaturation({
    expression: b('sub', x, x),
    valueId: 'expired_val',
    identity,
    memoryObservables: [],
    effectObservables: [],
    timeoutMs: 0,
  });
  assert.equal(expired.status, 'partial');
  assert.deepEqual(expired.candidates, []);
});

test('C4-05 pure Bool terms are verified independently from BV1', async () => {
  const { p, cases } = boolFixtures();
  for (const [name, expr, expected] of cases) {
    const r = await queryEqualitySaturation({
      expression: expr,
      valueId: `bool_${name}`,
      identity,
      memoryObservables: [],
      effectObservables: [],
      timeoutMs: 2000,
      backendTier: 'tiered',
    });
    assert.equal(r.status, 'complete', `${name}:${r.reason}`);
    for (const c of r.candidates.filter(cand => cand.eligible)) {
      assert.equal(c.verification.evidence.verdict, 'proved');
      assert.equal(isAdoptableCandidate(c.verification, { identity, before: expr, after: c.after }), true);
    }
  }
});
