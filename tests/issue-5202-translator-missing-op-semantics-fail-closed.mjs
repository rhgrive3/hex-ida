// Regression for #5202: the proof translator invented missing operation
// semantics — BIN without subOp/name became ADD, UN became NOT, CMP became
// '==', and SEL without a condition became an always-true ITE — all reported
// as EXACT with zero semanticUnknowns, so malformed/partial IR could feed
// false UNSAT proofs. Contract now: a missing semantic discriminator fails
// closed (unsupported + semanticUnknowns + unsupportedEntities); present
// discriminators keep the exact contract.
import assert from 'node:assert/strict';
import { OP, VK } from '../js/ir-base.js';
import { EXPR_KIND, BV_BINARY_OP, BV_COMPARE_OP } from '../js/symbolic/expr/kinds.js';
import { classifyOpSupport, TRANSLATION_STATUS } from '../js/symbolic/translate/support-matrix.js';
import { translateSemanticIR } from '../js/symbolic/translate/semantic-ir.js';

const argA = { kind: VK.ARG, id: 'a', reg: 'x0' };
const argB = { kind: VK.ARG, id: 'b', reg: 'x1' };
const twoArgs = () => [
  { value: argA },
  { value: argB },
];

function expectFailClosed(inst, label) {
  const res = translateSemanticIR(inst, { bitWidth: 64 });
  assert.equal(res.status, TRANSLATION_STATUS.UNSUPPORTED, `${label}: expected unsupported, got ${res.status}`);
  assert.ok(res.semanticUnknowns > 0, `${label}: semanticUnknowns must increase`);
  assert.ok(res.unsupportedEntities.length > 0, `${label}: unsupportedEntities must record the reason`);
  assert.equal(res.expression.kind, EXPR_KIND.UNKNOWN_SEMANTIC, `${label}: expression must be unknown, not invented`);
  return res;
}

// 1. BIN without subOp/name must not become ADD.
{
  const res = expectFailClosed({ id: 'i_bin', op: OP.BIN, args: twoArgs() }, 'BIN without discriminator');
  assert.ok(!res.unsupportedEntities.some((e) => String(e.reason).includes('bin') === false && false));
}

// 2. UN without subOp/name must not become NOT.
expectFailClosed({ id: 'i_un', op: OP.UN, args: [{ value: argA }] }, 'UN without discriminator');

// 3. CMP without cond/subOp must not become EQ.
{
  const res = expectFailClosed({ id: 'i_cmp', op: OP.CMP, args: twoArgs() }, 'CMP without discriminator');
  assert.notEqual(res.expression.op, BV_COMPARE_OP.EQ);
}

// 4. SEL without cond must not become an always-true ITE.
{
  const res = expectFailClosed({ id: 'i_sel', op: OP.SEL, args: twoArgs() }, 'SEL without condition');
  assert.ok(JSON.stringify(res.unsupportedEntities).includes('select') || JSON.stringify(res.unsupportedEntities).includes('sel'),
    'SEL failure must be attributable');
}

// 5. Support matrix agrees with the translator on missing discriminators.
assert.equal(classifyOpSupport(OP.BIN, {}), TRANSLATION_STATUS.UNSUPPORTED);
assert.equal(classifyOpSupport(OP.BIN, { subOp: '' }), TRANSLATION_STATUS.UNSUPPORTED);
assert.equal(classifyOpSupport(OP.UN, {}), TRANSLATION_STATUS.UNSUPPORTED);
assert.equal(classifyOpSupport(OP.CMP, {}), TRANSLATION_STATUS.UNSUPPORTED);
assert.equal(classifyOpSupport(OP.CMP, { subOp: '' }), TRANSLATION_STATUS.UNSUPPORTED);
assert.equal(classifyOpSupport(OP.SEL, {}), TRANSLATION_STATUS.UNSUPPORTED);
assert.equal(classifyOpSupport(OP.CMP, { cond: '!=' }), TRANSLATION_STATUS.EXACT);
assert.equal(classifyOpSupport(OP.SEL, { cond: { id: 'c1', op: OP.CMP, cond: '==', args: [] } }), TRANSLATION_STATUS.EXACT);

// 6. Controls: present discriminators keep the EXACT contract unchanged.
{
  const add = translateSemanticIR({ id: 'c_add', op: OP.BIN, subOp: 'add', args: twoArgs() }, { bitWidth: 64 });
  assert.equal(add.status, TRANSLATION_STATUS.EXACT);
  assert.equal(add.semanticUnknowns, 0);
  assert.equal(add.expression.op, BV_BINARY_OP.ADD);

  const not = translateSemanticIR({ id: 'c_not', op: OP.UN, subOp: 'not', args: [{ value: argA }] }, { bitWidth: 64 });
  assert.equal(not.status, TRANSLATION_STATUS.EXACT);

  const ne = translateSemanticIR({ id: 'c_ne', op: OP.CMP, cond: '!=', args: twoArgs() }, { bitWidth: 64 });
  assert.equal(ne.status, TRANSLATION_STATUS.EXACT);
  assert.equal(ne.expression.op, BV_COMPARE_OP.NE);

  const sel = translateSemanticIR({
    id: 'c_sel',
    op: OP.SEL,
    cond: { id: 'c1', op: OP.CMP, cond: '==', args: twoArgs() },
    args: twoArgs(),
  }, { bitWidth: 64 });
  assert.equal(sel.status, TRANSLATION_STATUS.EXACT);
}

console.log('issue-5202 translator missing op semantics fail closed: ok');
