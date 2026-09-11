import assert from 'node:assert/strict';
import test from 'node:test';
import { runPassTransaction, seedAnalysisState } from '../../../js/decompiler/phase8/transaction.js';
import { SCCP_PASS, runSccpPass } from '../../../js/decompiler/phase8/sccp.js';
import { GVN_PASS, runGvnPass } from '../../../js/decompiler/phase8/valuenumber.js';
import { fixture } from '../helpers/ir-fixtures.mjs';

function pair(op = 'sel', sub = 'sel', changeFirst = () => {}, changeSecond = () => {}, constantOperands = false) {
  const f = fixture('issue-4697'); f.block(0);
  const a = constantOperands ? f.constant(op === 'bfx' ? 511n : op === 'bfi' ? 0n : ['un', 'mov'].includes(op) ? 255n : 1n, 64) : f.opaque(64);
  const b = constantOperands ? f.constant(op === 'bfi' ? 511n : 2n, 64) : f.opaque(64);
  const flags = constantOperands ? f.constant(6n, 64) : f.opaque(4);
  const first = f.binary('add', a, b, 64), second = f.binary('add', a, b, 64);
  for (const v of [first, second]) {
    v.def.op = op; v.def.sub = sub;
    if (op === 'sel') { v.def.args.push({ value: flags }); flags.uses.push(v.def); v.def.cond = 'eq'; }
    if (op === 'bfx') { v.def.args = [{ value: a }]; v.def.extra = { lsb: 0, width: 8, signed: false }; }
    if (op === 'bfi') v.def.extra = { lsb: 0, width: 8, bitfieldKind: 'bfi' };
    if (op === 'un' || op === 'mov') v.def.args = [{ value: a }];
  }
  changeFirst(first.def, f); changeSecond(second.def, f); f.ret();
  const ir = f.build(), state = seedAnalysisState(ir), context = { ir, analysis: state };
  assert.equal(runPassTransaction(state, { descriptor: SCCP_PASS, run: runSccpPass }, context, {}).committed, true);
  const outcome = runPassTransaction(state, { descriptor: GVN_PASS, run: runGvnPass }, context, {});
  assert.equal(outcome.committed, true);
  const facts = state.get('valueNumbers'); assert.ok(facts);
  return { first, second, facts };
}
function distinct(result) {
  const { first, second, facts } = result;
  assert.notEqual(facts.numbers.get(first.id), facts.numbers.get(second.id));
  assert.equal(facts.reuseCandidates.some((r) => r.valueId === second.id && r.reuseOf === first.id), false);
}
for (const [first, second] of [['eq', 'ne'], ['lt', 'ge'], ['hi', 'ls']]) {
  test(`#4697: same values/flags with ${first} and ${second} are not congruent`, () => {
    distinct(pair('sel', 'sel', (i) => { i.cond = first; }, (i) => { i.cond = second; }));
  });
}
for (const condition of [undefined, null, '', 'unknown', ['eq'], {}]) {
  test(`#4697: missing/malformed condition ${JSON.stringify(condition)} stays singleton`, () => {
    distinct(pair('sel', 'sel', (i) => { i.cond = condition; }, (i) => { i.cond = condition; }));
  });
}
test('#4697: genuine duplicate select remains congruent and reusable', () => {
  const { first, second, facts } = pair();
  assert.equal(facts.numbers.get(first.id), facts.numbers.get(second.id));
  assert.ok(facts.reuseCandidates.some((r) => r.valueId === second.id && r.reuseOf === first.id));
});
test('#4697: a separate flags definition prevents reuse', () => {
  distinct(pair('sel', 'sel', () => {}, (i, f) => { i.args[2] = { value: f.opaque(4) }; }));
});
test('#4697: explicit predicate identity is part of a projected select', () => {
  distinct(pair('sel', 'sel', (i, f) => { i.cond = null; i.conditionValue = f.opaque(1); },
    (i, f) => { i.cond = null; i.conditionValue = f.opaque(1); }));
});
for (const [op, field, value] of [
  ['bfx', 'lsb', 1], ['bfx', 'width', 16], ['bfx', 'signed', true],
  ['bfi', 'lsb', 1], ['bfi', 'width', 16], ['bfi', 'bitfieldKind', 'bfxil'],
]) {
  test(`#4697: ${op}.${field} changes the computation`, () => {
    distinct(pair(op, op, () => {}, (i) => { i.extra[field] = value; }));
  });
}
for (const op of ['bfx', 'bfi']) {
  test(`#4697: valid duplicate ${op} keeps a reuse candidate`, () => {
    const { first, second, facts } = pair(op, op);
    assert.equal(facts.numbers.get(first.id), facts.numbers.get(second.id));
    assert.ok(facts.reuseCandidates.some((r) => r.valueId === second.id));
  });
  test(`#4697: ${op} without a proven field width stays singleton`, () => {
    distinct(pair(op, op, (i) => { delete i.extra.width; }, (i) => { delete i.extra.width; }));
  });
}
for (const [op, sub, field, left, right] of [
  ['bin', 'add', 'negate', false, true],
  ['mac', 'madd', 'widen', 'signed', 'unsigned'],
  ['cmp', 'sub', 'comparison', '<', '>='],
  ['cmp', 'sub', 'signed', true, false],
  ['un', 'sext', 'sourceBits', 8, 32],
  ['mov', 'zext', 'sourceBits', 8, 32],
]) {
  test(`#4697: ${op}/${sub}.${field} is retained in the scalar key`, () => {
    distinct(pair(op, sub, (i) => { i.extra[field] = left; }, (i) => { i.extra[field] = right; }));
  });
}
test('#4697: operand shifts are not discarded before value numbering', () => {
  distinct(pair('bin', 'add', (i) => { i.args[1].shift = { op: 'lsl', amount: 1 }; },
    (i) => { i.args[1].shift = { op: 'lsl', amount: 2 }; }));
});
test('#4697: an operand view width is not replaced by the underlying value width', () => {
  distinct(pair('bin', 'add', (i) => { i.args[1].bits = 32; }, (i) => { i.args[1].bits = 64; }));
});
test('#4697: an unowned scalar operation cannot generate a reuse proof', () => {
  distinct(pair('future-op', 'unknown'));
});

// Constants are created before their users, so SCCP can evaluate this fully
// defined fixture. A post-definition fixture mutation must not accidentally
// disable the very constant shortcut these regressions exercise.
test('#4697: constant select arms do not turn opposite flag conditions into one constant', () => {
  distinct(pair('sel', 'sel', (i) => { i.cond = 'eq'; }, (i) => { i.cond = 'ne'; }, true));
});
for (const op of ['bfx', 'bfi']) {
  test(`#4697: constant ${op} operands cannot hide a changed field width`, () => {
    distinct(pair(op, op, (i) => { i.extra.width = 8; }, (i) => { i.extra.width = 16; }, true));
  });
}
test('#4697: constant operands with different shifts are not equal before the key is constructed', () => {
  distinct(pair('bin', 'add', (i) => { i.args[1].shift = { op: 'lsl', amount: 1 }; },
    (i) => { i.args[1].shift = { op: 'lsl', amount: 2 }; }, true));
});
test('#4697: negation metadata is not lost in scalar constant propagation', () => {
  distinct(pair('bin', 'add', (i) => { i.extra.negate = false; }, (i) => { i.extra.negate = true; }, true));
});
test('#4697: source view width is not lost in scalar constant propagation', () => {
  distinct(pair('un', 'sext', (i) => { i.extra.sourceBits = 8; }, (i) => { i.extra.sourceBits = 16; }, true));
});

for (const [op, sub] of [['bfx', 'extract'], ['bfi', 'insert']]) {
  test(`#4697: generic ${sub} derives its field width from the explicit typed operands/result`, () => {
    const result = pair(op, sub, (i) => { delete i.extra.width; }, (i) => { delete i.extra.width; });
    assert.equal(result.facts.numbers.get(result.first.id), result.facts.numbers.get(result.second.id));
    assert.ok(result.facts.reuseCandidates.some((r) => r.valueId === result.second.id));
  });
}

for (const op of ['bfx', 'bfi']) {
  test(`#4697: constant operands cannot give a missing ${op} geometry a congruence proof`, () => {
    distinct(pair(op, op, (i) => { delete i.extra.width; }, (i) => { delete i.extra.width; }, true));
  });
}
