import assert from 'node:assert/strict';
import test from 'node:test';
import { semanticAbiAdapter } from '../../js/analysis/semantic-function.js';
import { AAPCS64_ABI } from '../../js/targets/abi/index.js';
import { enhanceSemanticDecompilation, buildExpressionForTesting } from '../../js/decompiler/pipeline-core.js';
import { expr } from '../../js/decompiler/ast/nodes.js';
import { printExpression } from '../../js/decompiler/pretty/c.js';

const ABI = semanticAbiAdapter(AAPCS64_ABI);

function val(id, reg, bits = 64, kind = 'def', extra = {}) {
  return { id, reg, bits, kind, uses: [], def: null, const: null, ...extra };
}
function arg(id, reg, bits = 64) {
  return val(id, reg, bits, 'arg');
}
function av(v) {
  return { value: v };
}

function makeState(ir, { model = { calls: [], addressRefs: [] }, opts = {}, types = null, highVariables = null } = {}) {
  return {
    ir,
    model,
    opts: { abiAdapter: ABI, ...opts },
    types: types || { values: new Map(), locations: new Map() },
    highVariables,
    preservePhase8Unknown: opts.phase8Optimize === true,
    expressionMemo: new Map(),
    expressionActive: new Set(),
    warnings: [],
  };
}

function makeSingleBlockEnhance({
  args,
  values,
  insts,
  lines,
  types = null,
  model = { calls: [], addressRefs: [] },
  opts = {},
}) {
  const ir = {
    values: [...args, ...values],
    instructions: insts,
    args: new Map(args.map((a) => [a.reg, a])),
    blocks: [{ index: 0, startRow: 0, endRow: Math.max(0, insts.length - 1), succ: [], insts }],
  };
  const result = {
    semantic: true,
    ir,
    types: types || { values: new Map(), locations: new Map() },
    lines,
    warnings: [],
    evidence: [],
    summary: 'test',
    coverage: { mode: 'structured' },
  };
  return enhanceSemanticDecompilation(result, model, {
    abiAdapter: ABI,
    decompilerTimeBudgetMs: 5000,
    ...opts,
  });
}

test('Fix 1: escaped sp lowers stack slots to typed dereferences over sp instead of disjoint local_* scalars', () => {
  // 1a. sp - 32 passed to a call => stack slots must share sp frame
  const sp = arg(1, 'sp', 64);
  const off32 = val(2, 'imm', 64, 'def', { const: 32n });
  const bufPtr = val(3, 'x0', 64);
  const loadedW = val(4, 'w8', 32);
  const loadedB = val(5, 'w9', 8);
  const loaded0 = val(6, 'x10', 64);
  const loadedPos = val(7, 'w11', 16);

  const subSp = { id: 10, op: 'bin', sub: 'sub', row: 0, block: 0, address: 0x1000n, dst: bufPtr, args: [av(sp), av(off32)] };
  bufPtr.def = subSp;
  const callI = { id: 11, op: 'call', row: 1, block: 0, address: 0x1004n, dst: null, args: [av(bufPtr)], extra: { name: 'fill_buf' } };
  const loadW = { id: 12, op: 'load', row: 2, block: 0, address: 0x1008n, size: 4, dst: loadedW, loc: { kind: 'stack', key: 'stack:-32', disp: -32n, size: 4 }, addr: { base: sp, disp: -32n, size: 4 }, args: [] };
  loadedW.def = loadW;
  const loadB = { id: 13, op: 'load', row: 3, block: 0, address: 0x100cn, size: 1, dst: loadedB, loc: { kind: 'stack', key: 'stack:-28', disp: -28n, size: 1 }, addr: { base: sp, disp: -28n, size: 1 }, args: [] };
  loadedB.def = loadB;
  const load0 = { id: 14, op: 'load', row: 4, block: 0, address: 0x1010n, size: 8, dst: loaded0, loc: { kind: 'stack', key: 'stack:0', disp: 0n, size: 8 }, addr: { base: sp, disp: 0n, size: 8 }, args: [] };
  loaded0.def = load0;
  const loadPos = { id: 15, op: 'load', row: 5, block: 0, address: 0x1014n, size: 2, dst: loadedPos, loc: { kind: 'stack', key: 'stack:16', disp: 16n, size: 2 }, addr: { base: sp, disp: 16n, size: 2 }, args: [] };
  loadedPos.def = loadPos;

  const escapedIr = {
    values: [sp, off32, bufPtr, loadedW, loadedB, loaded0, loadedPos],
    instructions: [subSp, callI, loadW, loadB, load0, loadPos],
    args: new Map([['sp', sp]]),
    blocks: [],
  };
  const escapedState = makeState(escapedIr);
  assert.equal(printExpression(buildExpressionForTesting(loadedW, escapedState)), '*(uint32_t *)(uintptr_t)(sp - 32)');
  assert.equal(printExpression(buildExpressionForTesting(loadedB, escapedState)), '*(uint8_t *)(uintptr_t)(sp - 28)');
  assert.equal(printExpression(buildExpressionForTesting(loaded0, escapedState)), '*(uint64_t *)(uintptr_t)(sp)');
  assert.equal(printExpression(buildExpressionForTesting(loadedPos, escapedState)), '*(uint16_t *)(uintptr_t)(sp + 16)');

  // 1b. sp flowing into a non-sp PHI also triggers escaped-frame lowering
  const sp2 = arg(20, 'sp', 64);
  const phiPtr = val(21, 'x8', 64);
  const slotVal = val(22, 'w0', 32);
  const phiI = { id: 23, op: 'phi', row: 0, block: 0, address: 0x1100n, dst: phiPtr, args: [av(sp2)] };
  phiPtr.def = phiI;
  const loadSlot = { id: 24, op: 'load', row: 1, block: 0, address: 0x1104n, size: 4, dst: slotVal, loc: { kind: 'stack', key: 'stack:-16', disp: -16n, size: 4 }, addr: { base: sp2, disp: -16n, size: 4 }, args: [] };
  slotVal.def = loadSlot;
  const phiIr = { values: [sp2, phiPtr, slotVal], instructions: [phiI, loadSlot], args: new Map([['sp', sp2]]), blocks: [] };
  assert.equal(printExpression(buildExpressionForTesting(slotVal, makeState(phiIr))), '*(uint32_t *)(uintptr_t)(sp - 16)');

  // 1c. Non-escaped stack frame keeps normal scalar promotion (local_m10)
  const sp3 = arg(30, 'sp', 64);
  const normalSlot = val(31, 'w0', 32);
  const normalLoad = { id: 32, op: 'load', row: 0, block: 0, address: 0x1200n, size: 4, dst: normalSlot, loc: { kind: 'stack', key: 'stack:-16', disp: -16n, size: 4 }, addr: { base: sp3, disp: -16n, size: 4 }, args: [] };
  normalSlot.def = normalLoad;
  const normalIr = { values: [sp3, normalSlot], instructions: [normalLoad], args: new Map([['sp', sp3]]), blocks: [] };
  assert.equal(printExpression(buildExpressionForTesting(normalSlot, makeState(normalIr))), 'local_m10');
});

test('Fix 2: narrow field accesses emit typed dereferences even under phase8Optimize while preserving struct pointers and fieldFor', () => {
  const ptr = arg(1, 'x0', 64);
  const b0 = val(2, 'w0', 8);
  const h2 = val(3, 'w1', 16);
  const w4 = val(4, 'w2', 32);
  const q8 = val(5, 'x3', 64);

  const loadB0 = { id: 10, op: 'load', sub: 'ldrb', row: 0, block: 0, address: 0x2000n, size: 1, dst: b0, loc: { kind: 'field', key: 'field:1:0', base: ptr, disp: 0n, size: 1 }, addr: { base: ptr, disp: 0n, size: 1 }, args: [] };
  b0.def = loadB0;
  const loadH2 = { id: 11, op: 'load', sub: 'ldrh', row: 1, block: 0, address: 0x2004n, size: 2, dst: h2, loc: { kind: 'field', key: 'field:1:2', base: ptr, disp: 2n, size: 2 }, addr: { base: ptr, disp: 2n, size: 2 }, args: [] };
  h2.def = loadH2;
  const loadW4 = { id: 12, op: 'load', sub: 'ldr', row: 2, block: 0, address: 0x2008n, size: 4, dst: w4, loc: { kind: 'field', key: 'field:1:4', base: ptr, disp: 4n, size: 4 }, addr: { base: ptr, disp: 4n, size: 4 }, args: [] };
  w4.def = loadW4;
  const loadQ8 = { id: 13, op: 'load', sub: 'ldr', row: 3, block: 0, address: 0x200cn, size: 8, dst: q8, loc: { kind: 'field', key: 'field:1:8', base: ptr, disp: 8n, size: 8 }, addr: { base: ptr, disp: 8n, size: 8 }, args: [] };
  q8.def = loadQ8;

  const ir = { values: [ptr, b0, h2, w4, q8], instructions: [loadB0, loadH2, loadW4, loadQ8], args: new Map([['x0', ptr]]), blocks: [] };
  const p8State = makeState(ir, { opts: { phase8Optimize: true } });
  assert.equal(printExpression(buildExpressionForTesting(b0, p8State)), '*(uint8_t *)(uintptr_t)(a1)');
  assert.equal(printExpression(buildExpressionForTesting(h2, p8State)), '*(uint16_t *)((uintptr_t)(a1) + 2)');
  assert.equal(printExpression(buildExpressionForTesting(w4, p8State)), '*(uint32_t *)((uintptr_t)(a1) + 4)');
  assert.equal(printExpression(buildExpressionForTesting(q8, p8State)), 'a1->field_8');

  // Known struct pointer stays ->field_4 under phase8Optimize
  const structState = makeState(ir, {
    opts: { phase8Optimize: true },
    types: { values: new Map([[ptr.id, { name: 'Player *', kind: 'pointer' }]]), locations: new Map() },
  });
  assert.equal(printExpression(buildExpressionForTesting(w4, structState)), 'a1->field_4');

  // fieldFor metadata stays ->hp under phase8Optimize
  const fieldForState = makeState(ir, {
    opts: { phase8Optimize: true, fieldFor: (_reg, off) => (off === 4n ? { name: 'hp' } : null) },
  });
  assert.equal(printExpression(buildExpressionForTesting(w4, fieldForState)), 'a1->hp');
});

test('Fix 3: ccmp/ccmn conditional compare carriers, flag-setting ALU, and PHI flag producers lower cleanly', () => {
  const a1 = val(1, 'x0', 32, 'arg', { signed: false });
  const a2 = val(2, 'x1', 32, 'arg', { signed: false });
  const zero = val(3, 'imm', 32, 'def', { const: 0n });
  const five = val(4, 'imm', 32, 'def', { const: 5n });
  const guardFlags = val(5, 'nzcv', 4);
  const ccmpFlagsAnd = val(6, 'nzcv', 4);
  const ccmpFlagsOr = val(7, 'nzcv', 4);
  const selAnd = val(8, 'w0', 32);
  const selOr = val(9, 'w0', 32);
  const one = val(10, 'imm', 32, 'def', { const: 1n });

  const guardCmp = { id: 100, op: 'cmp', sub: 'sub', row: 0, block: 0, address: 0x3000n, bits: 32, dst: guardFlags, args: [av(a1), av(zero)] };
  guardFlags.def = guardCmp;

  // fallbackNzcv = 0 (Z=0 => eq is false) => guard && inner
  const ccmpAnd = {
    id: 101, op: 'cmp', sub: 'sub', row: 1, block: 0, address: 0x3004n, bits: 32, dst: ccmpFlagsAnd, args: [],
    extra: { conditional: true, guardCond: 'ne', guardCmp: guardFlags, innerOp: 'sub', innerLhs: av(a2), innerRhs: av(five), fallbackNzcv: 0 },
  };
  ccmpFlagsAnd.def = ccmpAnd;

  // fallbackNzcv = 4 (Z=1 => eq is true) => !(guard) || inner
  const ccmpOr = {
    id: 102, op: 'cmp', sub: 'sub', row: 2, block: 0, address: 0x3008n, bits: 32, dst: ccmpFlagsOr, args: [],
    extra: { conditional: true, guardCond: 'ne', guardCmp, innerOp: 'ccmp', innerLhs: av(a2), innerRhs: av(five), fallbackNzcv: 4 },
  };
  ccmpFlagsOr.def = ccmpOr;

  const cselAnd = { id: 103, op: 'sel', sub: 'set', cond: 'eq', row: 3, block: 0, address: 0x300cn, dst: selAnd, args: [av(one), av(zero), av(ccmpFlagsAnd)] };
  selAnd.def = cselAnd;
  const cselOr = { id: 104, op: 'sel', sub: 'set', cond: 'eq', row: 4, block: 0, address: 0x3010n, dst: selOr, args: [av(one), av(zero), av(ccmpFlagsOr)] };
  selOr.def = cselOr;

  const ir = {
    values: [a1, a2, zero, five, one, guardFlags, ccmpFlagsAnd, ccmpFlagsOr, selAnd, selOr],
    instructions: [guardCmp, ccmpAnd, ccmpOr, cselAnd, cselOr],
    args: new Map([['x0', a1], ['x1', a2]]),
    blocks: [],
  };
  const state = makeState(ir);
  const andText = printExpression(buildExpressionForTesting(selAnd, state));
  const orText = printExpression(buildExpressionForTesting(selOr, state));
  assert.match(andText, /a1 != 0 && a2 == 5/, andText);
  assert.doesNotMatch(andText, /condition_/, andText);
  assert.match(orText, /!\(a1 != 0\) \|\| a2 == 5/, orText);
  assert.doesNotMatch(orText, /condition_/, orText);

  // Track 2 exact ID-based carrier shape (innerLhs/innerRhs/guardCmp are numeric value IDs)
  const ccmpIdFlags = val(17, 'nzcv', 4);
  const ccmpIdCarrier = {
    id: 111, op: 'cmp', sub: 'sub', row: 2, block: 0, address: 0x3009n, bits: 32, dst: ccmpIdFlags,
    args: [av(a2), av(five), av(guardFlags)],
    extra: { conditional: true, cond: 'ne', guardCond: 'ne', guardCmp: guardFlags.id, innerOp: 'cmp', innerLhs: a2.id, innerRhs: five.id, fallbackNzcv: 0 },
  };
  ccmpIdFlags.def = ccmpIdCarrier;
  const selId = val(18, 'w0', 32);
  const cselId = { id: 112, op: 'sel', sub: 'set', cond: 'eq', row: 3, block: 0, address: 0x300an, dst: selId, args: [av(one), av(zero), av(ccmpIdFlags)] };
  selId.def = cselId;
  const idIr = {
    values: [a1, a2, zero, five, one, guardFlags, ccmpIdFlags, selId],
    instructions: [guardCmp, ccmpIdCarrier, cselId],
    args: new Map([['x0', a1], ['x1', a2]]),
    blocks: [],
  };
  const idText = printExpression(buildExpressionForTesting(selId, makeState(idIr)));
  assert.match(idText, /a1 != 0 && a2 == 5/, idText);
  assert.doesNotMatch(idText, /condition_|missing-arg/, idText);

  // Flag-setting ALU (subs, ands, bics) + PHI flag producer
  const aluFlags = val(11, 'nzcv', 4);
  const subsI = { id: 105, op: 'bin', sub: 'subs', row: 5, block: 0, address: 0x3014n, bits: 32, dst: aluFlags, args: [av(a1), av(five)] };
  aluFlags.def = subsI;
  const selSubs = val(12, 'w0', 32);
  const cselSubs = { id: 106, op: 'sel', sub: 'set', cond: 'eq', row: 6, block: 0, address: 0x3018n, dst: selSubs, args: [av(one), av(zero), av(aluFlags)] };
  selSubs.def = cselSubs;

  const bicsFlags = val(13, 'nzcv', 4);
  const bicsI = { id: 107, op: 'bin', sub: 'bics', row: 7, block: 0, address: 0x301cn, bits: 32, dst: bicsFlags, args: [av(a1), av(five)] };
  bicsFlags.def = bicsI;
  const selBics = val(14, 'w0', 32);
  const cselBics = { id: 108, op: 'sel', sub: 'set', cond: 'ne', row: 8, block: 0, address: 0x3020n, dst: selBics, args: [av(one), av(zero), av(bicsFlags)] };
  selBics.def = cselBics;

  const phiFlags = val(15, 'nzcv', 4);
  const phiI = { id: 109, op: 'phi', row: 9, block: 0, address: 0x3024n, dst: phiFlags, args: [av(aluFlags), av(phiFlags)] };
  phiFlags.def = phiI;
  const selPhi = val(16, 'w0', 32);
  const cselPhi = { id: 110, op: 'sel', sub: 'set', cond: 'eq', row: 10, block: 0, address: 0x3028n, dst: selPhi, args: [av(one), av(zero), av(phiFlags)] };
  selPhi.def = cselPhi;

  const ir2 = {
    values: [a1, a2, zero, five, one, aluFlags, selSubs, bicsFlags, selBics, phiFlags, selPhi],
    instructions: [subsI, cselSubs, bicsI, cselBics, phiI, cselPhi],
    args: new Map([['x0', a1], ['x1', a2]]),
    blocks: [],
  };
  const state2 = makeState(ir2);
  const subsText = printExpression(buildExpressionForTesting(selSubs, state2));
  const bicsText = printExpression(buildExpressionForTesting(selBics, state2));
  const phiText = printExpression(buildExpressionForTesting(selPhi, state2));
  assert.match(subsText, /a1 == 5/, subsText);
  assert.match(bicsText, /\(.*a1 & .*~5\) != 0/, bicsText);
  assert.match(phiText, /a1 == 5/, phiText);
  assert.doesNotMatch(phiText, /condition_/, phiText);
});

test('Fix 4: reachingRegisterValue does not resurrect pre-call x0 across a clobbered def', () => {
  const preX0 = val(1, 'x0', 64, 'def', { const: 0x1234n });
  const clobberedX0 = val(2, 'x0', 64, 'def', { clobbered: true });

  const constI = { id: 10, op: 'const', row: 0, block: 0, address: 0x4000n, dst: preX0, args: [], extra: { value: 0x1234n } };
  preX0.def = constI;
  const callI = { id: 11, op: 'call', row: 1, block: 0, address: 0x4004n, dst: clobberedX0, args: [], extra: { name: 'helper' } };
  clobberedX0.def = callI;
  const retI = { id: 12, op: 'ret', row: 2, block: 0, address: 0x4008n, args: [] };

  const enhanced = makeSingleBlockEnhance({
    args: [],
    values: [preX0, clobberedX0],
    insts: [constI, callI, retI],
    lines: [
      { kind: 'sig', indent: 0, text: 'uint64 fn(void)' },
      { kind: 'ctrl', indent: 0, text: '{' },
      { kind: 'stmt', indent: 1, text: 'helper();', row: 1, addr: 0x4004n },
      { kind: 'stmt', indent: 1, text: 'return ret_val;', row: 2, addr: 0x4008n },
      { kind: 'ctrl', indent: 0, text: '}' },
    ],
  });

  // Must NOT resurrect pre-call 0x1234 across the clobbered call def
  assert.doesNotMatch(enhanced.pseudocode, /return 0x1234;/, enhanced.pseudocode);
});

test('Fix 5: argumentName preserves sp; buildValue and selectExpression resolve .rodata strings and .bss &global_ under phase8Optimize', () => {
  // 5a. argumentName preserves 'sp' even when highVariables maps sp to a renamed group
  const sp = arg(1, 'sp', 64);
  const spState = makeState(
    { values: [sp], instructions: [], args: new Map([['sp', sp]]), blocks: [] },
    { highVariables: { valueToGroup: new Map([[sp.id, 'g_sp']]), groups: [{ id: 'g_sp', name: 'local_renamed_sp' }] } },
  );
  assert.equal(printExpression(buildExpressionForTesting(sp, spState)), 'sp');

  // 5b. .rodata 0-char and 1-char strings + .bss &global_<HEX> under phase8Optimize === true
  const rodataBytes = Uint8Array.from([
    0x00,             // "" at 0x900
    0x61, 0x00,       // "a" at 0x901
    0x59, 0x45, 0x53, 0x00, // "YES" at 0x903
  ]);
  const rodataSec = { name: '.rodata', addr: 0x900n, size: BigInt(rodataBytes.length), bytes: rodataBytes, perm: 'r--' };
  const bssSec = { name: '.bss', addr: 0x12000n, size: 0x100n, bytes: new Uint8Array(0x100), perm: 'rw-' };

  const pageRo = val(2, 'x8', 64, 'def', { const: 0x0n });
  const offEmpty = val(3, 'imm', 64, 'def', { const: 0x900n });
  const offOneChar = val(4, 'imm', 64, 'def', { const: 0x901n });
  const foldedEmpty = val(5, 'x8', 64, 'def', { const: 0x900n });
  const unfoldedOneChar = val(6, 'x9', 64); // v.const intentionally null to test unfolded bin add
  const pageBss = val(7, 'x10', 64, 'def', { const: 0x12000n });
  const offBss = val(8, 'imm', 64, 'def', { const: 0x40n });
  const foldedBss = val(9, 'x10', 64, 'def', { const: 0x12040n });

  const adrpRo = { id: 20, op: 'addr', row: 0, block: 0, address: 0x5000n, dst: pageRo, args: [], extra: { value: 0x0n } };
  pageRo.def = adrpRo;
  const addEmpty = { id: 21, op: 'bin', sub: 'add', row: 1, block: 0, address: 0x5004n, dst: foldedEmpty, args: [av(pageRo), av(offEmpty)] };
  foldedEmpty.def = addEmpty;
  const addOneChar = { id: 22, op: 'bin', sub: 'add', row: 2, block: 0, address: 0x5008n, dst: unfoldedOneChar, args: [av(pageRo), av(offOneChar)] };
  unfoldedOneChar.def = addOneChar;
  const adrpBss = { id: 23, op: 'addr', row: 3, block: 0, address: 0x500cn, dst: pageBss, args: [], extra: { value: 0x12000n } };
  pageBss.def = adrpBss;
  const addBss = { id: 24, op: 'bin', sub: 'add', row: 4, block: 0, address: 0x5010n, dst: foldedBss, args: [av(pageBss), av(offBss)] };
  foldedBss.def = addBss;

  // 5c. csel / selectExpression with .rodata string arms (including peer const arm) under phase8Optimize === true
  const a1 = val(10, 'x0', 32, 'arg', { signed: false });
  const zero = val(11, 'imm', 32, 'def', { const: 0n });
  const flg = val(12, 'nzcv', 4);
  const cmpI = { id: 25, op: 'cmp', sub: 'sub', row: 5, block: 0, address: 0x5014n, bits: 32, dst: flg, args: [av(a1), av(zero)] };
  flg.def = cmpI;
  const rawConstYes = val(13, 'x11', 64, 'def', { const: 0x903n });
  const constYesI = { id: 26, op: 'const', row: 6, block: 0, address: 0x5018n, dst: rawConstYes, args: [], extra: { value: 0x903n } };
  rawConstYes.def = constYesI;
  const selStr = val(14, 'x0', 64);
  const selI = { id: 27, op: 'sel', sub: 'sel', cond: 'eq', row: 7, block: 0, address: 0x501cn, dst: selStr, args: [av(foldedEmpty), av(rawConstYes), av(flg)] };
  selStr.def = selI;

  const p8State = makeState(
    {
      values: [a1, zero, pageRo, offEmpty, offOneChar, foldedEmpty, unfoldedOneChar, pageBss, offBss, foldedBss, flg, rawConstYes, selStr],
      instructions: [adrpRo, addEmpty, addOneChar, adrpBss, addBss, cmpI, constYesI, selI],
      args: new Map([['x0', a1]]),
      blocks: [],
    },
    { opts: { phase8Optimize: true, sections: [rodataSec, bssSec] } },
  );

  assert.equal(printExpression(buildExpressionForTesting(foldedEmpty, p8State)), '""');
  assert.equal(printExpression(buildExpressionForTesting(unfoldedOneChar, p8State)), '"a"');
  assert.equal(printExpression(buildExpressionForTesting(foldedBss, p8State)), '&global_12040');
  assert.equal(printExpression(buildExpressionForTesting(selStr, p8State)), 'a1 == 0 ? "" : "YES"');
});

test('Fix 6: pretty/c.js parenthesizes bitwise &, |, ^ operands inside comparison operators', () => {
  const load441 = expr.variable('load_441', 32, false);
  const mask = expr.constant(0xFFFFFFDFn, 32, false);
  const zero = expr.constant(0n, 32, false);

  // Standard AST binary nodes (and, or, xor) across all comparison operators
  for (const [cmpOp, cmpText] of [['eq', '=='], ['ne', '!='], ['lt', '<'], ['le', '<='], ['gt', '>'], ['ge', '>=']]) {
    for (const [bitOp, bitText] of [['and', '&'], ['or', '|'], ['xor', '^'], ['&', '&'], ['|', '|'], ['^', '^']]) {
      const node = expr.compare(cmpOp, expr.binary(bitOp, load441, mask, 32, false), zero, false);
      assert.equal(printExpression(node), `(load_441 ${bitText} 0xFFFFFFDF) ${cmpText} 0`);
    }
  }

  // Pre-rendered bitwise text inside a variable/load operand
  const rawBitwise = expr.variable('load_441 & 0xFFFFFFDF', 32, false);
  assert.equal(printExpression(expr.compare('ne', rawBitwise, zero, false)), '(load_441 & 0xFFFFFFDF) != 0');

  // Unary address-of &global_1000 must NOT be spuriously wrapped
  const addrVar = expr.variable('&global_1000', 64, false);
  assert.equal(printExpression(expr.compare('ne', addrVar, expr.constant(0n, 64, false), false)), '&global_1000 != 0');

  // Logical andand / oror print as && / ||
  const c1 = expr.compare('ne', expr.variable('a1', 32, false), zero, false);
  const c2 = expr.compare('eq', expr.variable('a2', 32, false), expr.constant(5n, 32, false), false);
  assert.equal(printExpression(expr.binary('andand', c1, c2, 1, false)), 'a1 != 0 && a2 == 5');
  assert.equal(printExpression(expr.binary('oror', expr.unary('lnot', c1, 1, false), c2, 1, false)), '!(a1 != 0) || a2 == 5');
});
