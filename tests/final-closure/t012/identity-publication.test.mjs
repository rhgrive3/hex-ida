import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalAnalysisIdentity } from '../../../js/decompiler/phase8/analysis-identity.js';
import { SCCP_PASS, runSccpPass } from '../../../js/decompiler/phase8/sccp.js';
import { runPassTransaction, seedAnalysisState } from '../../../js/decompiler/phase8/transaction.js';
import { GVN_PASS, runGvnPass } from '../../../js/decompiler/phase8/valuenumber.js';
import { fixture } from '../../phase8/helpers/ir-fixtures.mjs';

function identityFixture(name) {
  const f = fixture(name);
  f.block(0);
  const input = f.opaque(8);
  f.binary('add', input, f.constant(1, 8), 8);
  f.ret();
  return f.build();
}

function gvnFixture(name) {
  const f = fixture(name);
  f.block(0);
  const left = f.opaque(32);
  const right = f.opaque(32);
  const first = f.binary('add', left, right, 32);
  const second = f.binary('add', left, right, 32);
  f.ret();
  return { ir:f.build(), first, second };
}

test('T012 identity rejects an accessor and cannot miss a proxy-hidden semantic field', () => {
  const ir = identityFixture('t012-hostile-identity');
  const target = ir.values[0];
  let getterReads = 0;
  Object.defineProperty(target, 'poison', {
    get() {
      getterReads += 1;
      throw new Error('identity getter executed');
    },
    enumerable: true,
    configurable: true,
  });
  assert.equal(canonicalAnalysisIdentity({ ir }).valid, false);
  assert.equal(getterReads, 0, 'identity must inspect descriptors without executing getters');

  const clean = identityFixture('t012-proxy-hidden-identity');
  const value = clean.values[0];
  const hidden = new Proxy(value, {
    ownKeys(object) { return Reflect.ownKeys(object).filter((key) => key !== 'bits'); },
  });
  clean.values[0] = hidden;
  const before = canonicalAnalysisIdentity({ ir:clean });
  value.bits = 16;
  const after = canonicalAnalysisIdentity({ ir:clean });
  assert.equal(before.valid, true);
  assert.equal(after.valid, true);
  assert.notEqual(after.identity.semanticIrId, before.identity.semanticIrId,
    'a proxy cannot hide a known semantic field from the identity transcript');
});

test('T012 GVN publication does not expose mutable numbering authority', () => {
  const { ir, first, second } = gvnFixture('t012-gvn-publication');
  const state = seedAnalysisState(ir);
  const context = { analysis:state, ir };
  runPassTransaction(state, { descriptor:SCCP_PASS, run:runSccpPass }, context, {});
  const outcome = runPassTransaction(state, { descriptor:GVN_PASS, run:runGvnPass }, context, {});
  assert.equal(outcome.committed, true);
  const facts = state.get('valueNumbers');
  const firstNumber = facts.numbers.get(first.id);
  assert.equal(firstNumber, facts.numbers.get(second.id));

  assert.throws(() => facts.numbers.set(first.id, firstNumber + 100), /immutable|published|read-only/);
  assert.equal(facts.numbers.get(first.id), firstNumber,
    'a rejected post-publication write cannot alter the value-number authority');

  const members = facts.classes.get(firstNumber);
  assert.ok(Array.isArray(members));
  assert.throws(() => members.push('forged-value'), /read only|immutable|object is not extensible/i);
  assert.deepEqual(facts.classes.get(firstNumber), [first.id, second.id],
    'class membership remains stable after publication');
});
