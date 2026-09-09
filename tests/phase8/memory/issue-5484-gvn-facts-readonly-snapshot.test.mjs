import assert from 'node:assert/strict';
import test from 'node:test';

import { runPassTransaction, seedAnalysisState } from '../../../js/decompiler/phase8/transaction.js';
import { SCCP_PASS, runSccpPass } from '../../../js/decompiler/phase8/sccp.js';
import { GVN_PASS, runGvnPass } from '../../../js/decompiler/phase8/valuenumber.js';
import { fixture } from '../helpers/ir-fixtures.mjs';

/**
 * #5484: facts a pass commits are published, not lent. Object.freeze() does not
 * freeze a Map's internal slots and frozen arrays of unfrozen entries stay
 * writable, so the GVN publication used to hand out live `numbers`/`classes`/
 * `singletonReasons` containers that could be rewritten in place without
 * advancing the analysis version.
 */

function analyze(ir) {
  const state = seedAnalysisState(ir);
  const context = { analysis: state, ir };
  runPassTransaction(state, { descriptor: SCCP_PASS, run: runSccpPass }, context, {});
  runPassTransaction(state, { descriptor: GVN_PASS, run: runGvnPass }, context, {});
  return state.get('valueNumbers');
}

function congruentFixture() {
  const f = fixture('cse');
  f.block(0);
  const a = f.opaque(32);
  const b = f.opaque(32);
  const first = f.binary('add', a, b, 32);
  const second = f.binary('add', a, b, 32);
  f.ret();
  return { facts: analyze(f.build()), first, second };
}

test('#5484: published value numbers are a read-only snapshot', () => {
  const { facts, first } = congruentFixture();
  assert.equal(Object.isFrozen(facts), true);
  assert.throws(() => facts.numbers.set(first.id, 999), TypeError);
  assert.notEqual(facts.numbers.get(first.id), 999, 'post-publication rewrites cannot stick');
});

test('#5484: published congruence classes are frozen copies', () => {
  const { facts, first, second } = congruentFixture();
  assert.equal(facts.numbers.get(first.id), facts.numbers.get(second.id), 'the evidence itself is unchanged');
  assert.equal(facts.congruentClassCount, 1);
  const members = facts.classes.get(facts.classes.keys().next().value);
  assert.ok(Object.isFrozen(members));
  assert.throws(() => members.push('injected-fake-value'), TypeError);
});

test('#5484: reuse candidates are frozen entries, not live objects', () => {
  const { facts, first, second } = congruentFixture();
  const candidate = facts.reuseCandidates.find((entry) => entry.valueId === second.id && entry.reuseOf === first.id);
  assert.ok(candidate, 'the reuse evidence is still published');
  assert.ok(Object.isFrozen(candidate));
  assert.throws(() => { candidate.proof = 'TAMPERED PROOF'; }, TypeError);
});

test('#5484: singleton reasons are a read-only view with intact content', () => {
  const f = fixture('calls');
  f.block(0);
  f.call(32);
  const second = f.call(32);
  f.ret();
  const facts = analyze(f.build());
  assert.match(facts.singletonReasons.get(second.id) ?? '', /different value each time/);
  assert.throws(() => facts.singletonReasons.set(second.id, 'TAMPERED'), TypeError);
});
