import assert from 'node:assert/strict';
import test from 'node:test';
import { runPassTransaction, seedAnalysisState } from '../../../js/decompiler/phase8/transaction.js';
import { SCCP_PASS, runSccpPass } from '../../../js/decompiler/phase8/sccp.js';
import { GVN_PASS, runGvnPass } from '../../../js/decompiler/phase8/valuenumber.js';
import { fixture } from '../helpers/ir-fixtures.mjs';
function analyze(ir) {
  const state = seedAnalysisState(ir); const context = { analysis: state, ir };
  runPassTransaction(state, { descriptor: SCCP_PASS, run: runSccpPass }, context, {});
  runPassTransaction(state, { descriptor: GVN_PASS, run: runGvnPass }, context, {});
  return state.get('valueNumbers');
}
function congruentFixture() {
  const f = fixture('cse'); f.block(0); const a=f.opaque(32), b=f.opaque(32); const first=f.binary('add',a,b,32), second=f.binary('add',a,b,32); f.ret();
  return { facts: analyze(f.build()), first, second };
}
test('#5484 GVN published maps and arrays are immutable snapshots', () => {
  const { facts, first, second } = congruentFixture();
  assert.equal(Object.isFrozen(facts), true);
  assert.throws(() => facts.numbers.set(first.id, 999), TypeError);
  const members = facts.classes.get(facts.numbers.get(first.id));
  assert.ok(Object.isFrozen(members)); assert.throws(() => members.push('fake'), TypeError);
  const candidate = facts.reuseCandidates.find((entry) => entry.valueId === second.id);
  assert.ok(candidate && Object.isFrozen(candidate)); assert.throws(() => { candidate.proof='fake'; }, TypeError);
});
test('#5484 singleton reasons are read-only', () => {
  const f=fixture('calls'); f.block(0); f.call(32); const second=f.call(32); f.ret(); const facts=analyze(f.build());
  assert.match(facts.singletonReasons.get(second.id) ?? '', /different value each time/);
  assert.throws(() => facts.singletonReasons.set(second.id, 'fake'), TypeError);
});
