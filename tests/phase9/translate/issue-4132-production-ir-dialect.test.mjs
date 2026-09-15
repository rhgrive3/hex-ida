// Regression for #4132: the proof translator and support matrix read a
// discriminator dialect (`subOp`/`name`/`cond`/`signed`) that no production
// Semantic IR emitter ever sets. Real v1 instructions carry the sub-op in
// `inst.sub` and the comparison predicate/sign in `inst.extra.comparison` /
// `inst.extra.signed` (semantic-ir-v2-to-v1-nodes.js, machine-effects-to-v1.js,
// ir-core-arm64-aapcs64-v1.js). Contract now: the canonical production fields
// translate to their real operations (`sub x0,x1,x2` must become SUB, never
// `add`), the legacy synthetic dialect keeps working, and any missing or
// unknown discriminator stays fail-closed (UNSUPPORTED, #5202).
import assert from 'node:assert/strict';
import { OP, VK } from '../../../js/ir-base.js';
import { EXPR_KIND, BV_BINARY_OP, BV_UNARY_OP, BV_COMPARE_OP } from '../../../js/symbolic/expr/kinds.js';
import { classifyOpSupport, TRANSLATION_STATUS } from '../../../js/symbolic/translate/support-matrix.js';
import { translateSemanticIR } from '../../../js/symbolic/translate/semantic-ir.js';

const argA = { kind: VK.ARG, id: 'a', reg: 'x0' };
const argB = { kind: VK.ARG, id: 'b', reg: 'x1' };
const twoArgs = () => [{ value: argA }, { value: argB }];

function translate(inst) {
  return translateSemanticIR(inst, { bitWidth: 64 });
}

function expectExact(inst, label) {
  const res = translate(inst);
  assert.equal(res.status, TRANSLATION_STATUS.EXACT, `${label}: expected EXACT, got ${res.status}`);
  assert.equal(res.semanticUnknowns, 0, `${label}: must not leak semantic unknowns`);
  return res;
}

function expectFailClosed(inst, label) {
  const res = translate(inst);
  assert.equal(res.status, TRANSLATION_STATUS.UNSUPPORTED, `${label}: expected UNSUPPORTED, got ${res.status}`);
  assert.ok(res.semanticUnknowns > 0, `${label}: semanticUnknowns must increase`);
  assert.equal(res.expression.kind, EXPR_KIND.UNKNOWN_SEMANTIC, `${label}: expression must be unknown, not invented`);
  return res;
}

{
  // Production BIN: `sub x0, x1, x2` — the #4132 minimal repro. Must
  // translate to SUB and never to the invented default.
  const sub = expectExact({ id: 'i1', op: OP.BIN, sub: 'sub', args: twoArgs() }, "BIN sub:'sub'");
  assert.equal(sub.expression.kind, EXPR_KIND.BINARY);
  assert.equal(sub.expression.op, BV_BINARY_OP.SUB, 'a real `sub` instruction must not mistranslate');
  assert.notEqual(sub.expression.op, BV_BINARY_OP.ADD, '`sub x0,x1,x2` must never become `add` (#4132)');
  assert.equal(expectExact({ id: 'i2', op: OP.BIN, sub: 'add', args: twoArgs() }, "BIN sub:'add'").expression.op, BV_BINARY_OP.ADD);
  assert.equal(classifyOpSupport(OP.BIN, { sub: 'bic' }), TRANSLATION_STATUS.UNSUPPORTED, "unsupported BIN sub 'bic' must stay classified unsupported");
  expectFailClosed({ id: 'i4', op: OP.BIN, sub: 'ror', args: twoArgs() }, "BIN sub:'ror' (unsupported in solver dialect)");
  expectFailClosed({ id: 'i5', op: OP.BIN, args: twoArgs() }, 'BIN without any discriminator (#5202 preserved)');
  assert.equal(classifyOpSupport(OP.BIN, { sub: 'sub' }), TRANSLATION_STATUS.EXACT);
  assert.equal(classifyOpSupport(OP.BIN, { sub: 'smull' }), TRANSLATION_STATUS.UNSUPPORTED);
  assert.equal(classifyOpSupport(OP.BIN, {}), TRANSLATION_STATUS.UNSUPPORTED);
}

{
  // Production UN: canonical discriminator is `sub`.
  assert.equal(expectExact({ id: 'u1', op: OP.UN, sub: 'not', args: [{ value: argA }] }, "UN sub:'not'").expression.op, BV_UNARY_OP.NOT);
  assert.equal(expectExact({ id: 'u2', op: OP.UN, sub: 'neg', args: [{ value: argA }] }, "UN sub:'neg'").expression.op, BV_UNARY_OP.NEG);
  expectFailClosed({ id: 'u3', op: OP.UN, sub: 'clz', args: [{ value: argA }] }, "UN sub:'clz'");
  expectFailClosed({ id: 'u4', op: OP.UN, args: [{ value: argA }] }, 'UN without discriminator (#5202 preserved)');
  assert.equal(classifyOpSupport(OP.UN, { sub: 'not' }), TRANSLATION_STATUS.EXACT);
  assert.equal(classifyOpSupport(OP.UN, {}), TRANSLATION_STATUS.UNSUPPORTED);
}

{
  // Production CMP: predicate and signedness travel in extra.comparison /
  // extra.signed (v2→v1 nodes) or top-level comparison/signed
  // (machine-effects-to-v1). None of them may be dropped.
  assert.equal(expectExact({ id: 'c1', op: OP.CMP, args: twoArgs(), extra: { comparison: 'lt', signed: true } }, 'CMP extra lt signed').expression.op, BV_COMPARE_OP.SLT);
  assert.equal(expectExact({ id: 'c2', op: OP.CMP, args: twoArgs(), extra: { comparison: 'lt', signed: false } }, 'CMP extra lt unsigned').expression.op, BV_COMPARE_OP.ULT);
  assert.equal(expectExact({ id: 'c3', op: OP.CMP, args: twoArgs(), extra: { comparison: 'eq' } }, 'CMP extra eq').expression.op, BV_COMPARE_OP.EQ);
  assert.equal(expectExact({ id: 'c4', op: OP.CMP, args: twoArgs(), extra: { comparison: 'sge' } }, 'CMP extra sge').expression.op, BV_COMPARE_OP.SGE);
  assert.equal(expectExact({ id: 'c5', op: OP.CMP, args: twoArgs(), extra: { comparison: 'uge' } }, 'CMP extra uge').expression.op, BV_COMPARE_OP.UGE);
  assert.equal(expectExact({ id: 'c6', op: OP.CMP, sub: 'sub', comparison: 'gt', signed: true, args: twoArgs() }, 'CMP machine-effects top-level gt signed').expression.op, BV_COMPARE_OP.SGT);
  expectFailClosed({ id: 'c7', op: OP.CMP, args: twoArgs(), extra: { comparison: 'semantic-flag-result' } }, 'CMP flag-carrier marker must not become an equality');
  expectFailClosed({ id: 'c8', op: OP.CMP, args: twoArgs(), extra: {} }, 'CMP without any predicate (#5202 preserved)');
  expectFailClosed({ id: 'c9', op: OP.CMP, args: twoArgs() }, 'CMP with no discriminator at all (#5202 preserved)');
  assert.equal(classifyOpSupport(OP.CMP, { extra: { comparison: 'lt' } }), TRANSLATION_STATUS.EXACT);
  assert.equal(classifyOpSupport(OP.CMP, { comparison: 'eq' }), TRANSLATION_STATUS.EXACT);
  assert.equal(classifyOpSupport(OP.CMP, { sub: 'sub' }), TRANSLATION_STATUS.UNSUPPORTED, 'the flag arithmetic sub is not a comparison predicate');
  assert.equal(classifyOpSupport(OP.CMP, {}), TRANSLATION_STATUS.UNSUPPORTED);
}

{
  // The legacy synthetic dialect (`subOp`/`name`/`cond`/`signed`) keeps
  // translating exactly as before — this fix adds the canonical fields, it
  // does not silently drop previously accepted shapes.
  assert.equal(expectExact({ id: 'l1', op: OP.BIN, subOp: 'add', args: twoArgs() }, 'legacy BIN subOp').expression.op, BV_BINARY_OP.ADD);
  assert.equal(expectExact({ id: 'l2', op: OP.CMP, cond: '!=', args: twoArgs() }, 'legacy CMP cond').expression.op, BV_COMPARE_OP.NE);
  assert.equal(expectExact({ id: 'l3', op: OP.CMP, cond: 'lt', signed: true, args: twoArgs() }, 'legacy CMP signed').expression.op, BV_COMPARE_OP.SLT);
}
