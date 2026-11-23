import assert from 'node:assert/strict';
import test from 'node:test';
import { OP, VK, MK } from '../../js/ir.js';
import {
  decompileSemantic,
  renderBranchCondition,
  renderMemoryLocation,
  renderValue,
} from '../../js/decompiler/semantic-core.js';

function val(id, reg, bits = 64, kind = VK.DEF, extra = {}) {
  return { id, reg, bits, kind, uses: [], def: null, const: null, ...extra };
}
function arg(id, reg, bits = 64, extra = {}) {
  return val(id, reg, bits, VK.ARG, extra);
}
function av(v) {
  return { value: v };
}

function makeCtx(ir, { model = { calls: [], addressRefs: [], instructions: [] }, opts = {}, types = null } = {}) {
  return {
    ir,
    model,
    opts,
    types: types || { values: new Map(), locations: new Map() },
    exprCache: new Map(),
    exprActive: new Set(),
    exprNodes: 0,
    callCache: new Map(),
    callByRow: new Map((model.calls || []).map((c) => [c.row, c])),
    materialNames: new Map(),
    phiVarNames: new Map(),
    unknownCallArities: 0,
    runtime: null,
  };
}

function makeIr(args, values, insts, blocks = null) {
  const allValues = [...args, ...values];
  const defaultBlocks = blocks || [{
    index: 0,
    startRow: 0,
    endRow: Math.max(0, insts.length - 1),
    succ: [],
    pred: [],
    phis: [],
    insts,
  }];
  return {
    entry: 0,
    values: allValues,
    instructions: insts,
    args: new Map(args.map((a) => [a.reg, a])),
    blocks: defaultBlocks,
    loops: [],
    stackSlots: [],
  };
}

// ============================================================================
// Fix 1: renderCmp() numeric SSA ID & innerOp normalization for ccmp/ccmn
// ============================================================================
test('Fix 1: renderCmp resolves numeric SSA IDs and normalizes cmp/cmn innerOp for ccmp/ccmn', () => {
  const a1 = arg(1, 'x0', 32);
  const a2 = arg(2, 'x1', 32);
  const c0 = val(3, 'imm', 32, VK.DEF, { const: 0n });
  const c10 = val(4, 'imm', 32, VK.DEF, { const: 10n });
  const flags1 = val(10, 'nzcv', 4);
  const flags2 = val(11, 'nzcv', 4);

  const cmp1 = {
    id: 100, op: OP.CMP, sub: 'sub', row: 0, block: 0, address: 0x1000n, bits: 32,
    dst: flags1, args: [av(a1), av(c0)], extra: {},
  };
  flags1.def = cmp1;

  // v2->v1 projection shape: numeric IDs in extra.guardCmp/innerLhs/innerRhs and innerOp = 'cmp'
  const ccmp = {
    id: 101, op: OP.CMP, sub: 'sub', cond: 'gt', row: 1, block: 0, address: 0x1004n, bits: 32,
    dst: flags2,
    args: [av(a2), av(c10), av(flags1)],
    extra: {
      conditional: true,
      cond: 'gt',
      guardCond: 'gt',
      guardCmp: flags1.id, // numeric SSA ID
      innerOp: 'cmp',      // must normalize to 'sub'
      innerLhs: a2.id,     // numeric SSA ID
      innerRhs: c10.id,    // numeric SSA ID
      fallbackNzcv: 0,     // Z=0, N=0, V=0 -> 'lt' is false -> (guard && inner)
    },
  };
  flags2.def = ccmp;

  const cbr = {
    id: 102, op: OP.CBR, cond: 'lt', row: 2, block: 0, address: 0x1008n,
    args: [av(flags2)], extra: { cond: 'lt' },
  };

  const ir = makeIr([a1, a2], [c0, c10, flags1, flags2], [cmp1, ccmp, cbr]);
  const ctx = makeCtx(ir);

  const rendered = renderBranchCondition(cbr, ctx);
  assert.doesNotMatch(rendered, /condition_|vundefined/, rendered);
  assert.match(rendered, /\(int32_t\)a1 > 0/, rendered);
  assert.match(rendered, /\(int32_t\)a2 < 10/, rendered);
  assert.match(rendered, /&&/, rendered);

  // Test ccmn with innerOp = 'cmn' (normalizes to 'add') and fallbackNzcv = 4 (Z=1 -> 'eq' is true -> (!(guard) || inner))
  const flags3 = val(12, 'nzcv', 4);
  const ccmn = {
    id: 103, op: OP.CMP, sub: 'add', cond: 'ne', row: 3, block: 0, address: 0x100cn, bits: 32,
    dst: flags3,
    args: [av(a2), av(c10), av(flags1)],
    extra: {
      conditional: true,
      cond: 'ne',
      guardCond: 'ne',
      guardCmp: flags1.id,
      innerOp: 'cmn',
      innerLhs: a2.id,
      innerRhs: c10.id,
      fallbackNzcv: 4, // Z=1 -> eq is true
    },
  };
  flags3.def = ccmn;
  const cbr2 = {
    id: 104, op: OP.CBR, cond: 'eq', row: 4, block: 0, address: 0x1010n,
    args: [av(flags3)], extra: { cond: 'eq' },
  };
  const ir2 = makeIr([a1, a2], [c0, c10, flags1, flags3], [cmp1, ccmn, cbr2]);
  const ctx2 = makeCtx(ir2);
  const renderedCmn = renderBranchCondition(cbr2, ctx2);
  assert.doesNotMatch(renderedCmn, /condition_|vundefined|\/\* eq \*\//, renderedCmn);
  assert.match(renderedCmn, /\|\|/, renderedCmn);
  assert.match(renderedCmn, /a2 \+ (?:\(uint32_t\))?10/, renderedCmn);

  // Fallback to cmp.args[0..2] when extra.guardCmp/innerLhs/innerRhs are null
  const flags4 = val(13, 'nzcv', 4);
  const ccmpFallback = {
    id: 105, op: OP.CMP, sub: 'sub', cond: 'ne', row: 5, block: 0, address: 0x1014n, bits: 32,
    dst: flags4,
    args: [av(a2), av(c10), av(flags1)],
    extra: {
      conditional: true,
      guardCond: 'ne',
      guardCmp: null,
      innerOp: 'cmp',
      innerLhs: null,
      innerRhs: null,
      fallbackNzcv: 0,
    },
  };
  flags4.def = ccmpFallback;
  const cbr3 = {
    id: 106, op: OP.CBR, cond: 'eq', row: 6, block: 0, address: 0x1018n,
    args: [av(flags4)], extra: { cond: 'eq' },
  };
  const ir3 = makeIr([a1, a2], [c0, c10, flags1, flags4], [cmp1, ccmpFallback, cbr3]);
  const renderedFallback = renderBranchCondition(cbr3, makeCtx(ir3));
  assert.doesNotMatch(renderedFallback, /condition_|vundefined/, renderedFallback);
  assert.match(renderedFallback, /a1 != 0/, renderedFallback);
  assert.match(renderedFallback, /a2 == 10/, renderedFallback);
});

// ============================================================================
// Fix 2: Narrow-width / FP MK.FIELD guard in renderMemoryLocation()
// ============================================================================
test('Fix 2: renderMemoryLocation emits typed pointer deref for narrow-width and FP untyped MK.FIELD accesses', () => {
  const ptr = arg(1, 'x0', 64);
  const b0 = val(2, 'w0', 8);
  const sb1 = val(3, 'w1', 8, VK.DEF, { signed: true });
  const h2 = val(4, 'w2', 16);
  const w4 = val(5, 'w3', 32);
  const d8 = val(6, 'd0', 64);
  const q8 = val(7, 'x4', 64);

  const mkLoad = (id, dst, size, disp, extra = {}) => ({
    id, op: OP.LOAD, row: id, block: 0, address: 0x2000n, size, dst,
    loc: { kind: MK.FIELD, key: `field:1:${disp}`, base: ptr, disp, size },
    addr: { base: ptr, disp, size },
    args: [],
    ...extra,
  });

  const loadB0 = mkLoad(10, b0, 1, 0n);
  const loadSb1 = mkLoad(11, sb1, 1, 1n, { signed: true });
  const loadH2 = mkLoad(12, h2, 2, 2n);
  const loadW4 = mkLoad(13, w4, 4, 4n);
  const loadD8 = mkLoad(14, d8, 8, 8n, { float: true });
  const loadQ8 = mkLoad(15, q8, 8, 0n);

  const ir = makeIr([ptr], [b0, sb1, h2, w4, d8, q8], [loadB0, loadSb1, loadH2, loadW4, loadD8, loadQ8]);
  const ctx = makeCtx(ir);

  assert.equal(renderMemoryLocation(loadB0.loc, loadB0, ctx), '*(uint8_t *)(uintptr_t)(a1)');
  assert.equal(renderMemoryLocation(loadSb1.loc, loadSb1, ctx), '*(int8_t *)((uintptr_t)(a1) + 1)');
  assert.equal(renderMemoryLocation(loadH2.loc, loadH2, ctx), '*(uint16_t *)((uintptr_t)(a1) + 2)');
  assert.equal(renderMemoryLocation(loadW4.loc, loadW4, ctx), '*(uint32_t *)((uintptr_t)(a1) + 4)');
  assert.equal(renderMemoryLocation(loadD8.loc, loadD8, ctx), '*(double *)((uintptr_t)(a1) + 8)');

  // 8-byte integer access still emits ->field_0
  assert.equal(renderMemoryLocation(loadQ8.loc, loadQ8, ctx), 'a1->field_0');

  // Known struct pointer preserves ->field_4
  const structCtx = makeCtx(ir, {
    types: { values: new Map([[ptr.id, { kind: 'pointer', name: 'Player *' }]]), locations: new Map() },
  });
  assert.equal(renderMemoryLocation(loadW4.loc, loadW4, structCtx), 'a1->field_4');

  // fieldFor metadata preserves named field
  const fieldCtx = makeCtx(ir, {
    opts: { fieldFor: (_reg, off) => (off === 4n ? { name: 'count' } : null) },
  });
  assert.equal(renderMemoryLocation(loadW4.loc, loadW4, fieldCtx), 'a1->count');

  // phase8Optimize mode preserves ->field_4
  const p8Ctx = makeCtx(ir, { opts: { phase8Optimize: true } });
  assert.equal(renderMemoryLocation(loadW4.loc, loadW4, p8Ctx), 'a1->field_4');
});

// ============================================================================
// Fix 3: .rodata strings & .bss &global_ on OP.SEL arms and folded adrp+add
// ============================================================================
test('Fix 3: OP.SEL arms and folded adrp+add constants resolve .rodata strings and .bss &global_ addresses', () => {
  const a1 = arg(1, 'x0', 32);
  const c0 = val(2, 'imm', 32, VK.DEF, { const: 0n });
  const flags = val(3, 'nzcv', 4);
  const cmpI = { id: 10, op: OP.CMP, sub: 'sub', row: 0, block: 0, address: 0x3000n, bits: 32, dst: flags, args: [av(a1), av(c0)] };
  flags.def = cmpI;

  // (a) OP.SEL returning "Yes" / "No" via addressDerived constants
  const yesVal = val(4, 'x1', 64, VK.DEF, { const: 0x990n });
  const yesDef = { id: 11, op: OP.CONST, row: 1, block: 0, address: 0x3004n, dst: yesVal, args: [], extra: { value: 0x990n, addressDerived: true } };
  yesVal.def = yesDef;

  const noVal = val(5, 'x2', 64, VK.DEF, { const: 0x998n });
  const noDef = { id: 12, op: OP.CONST, row: 2, block: 0, address: 0x3008n, dst: noVal, args: [], extra: { value: 0x998n, addressDerived: true } };
  noVal.def = noDef;

  const selStr = val(6, 'x0', 64);
  const selStrDef = { id: 13, op: OP.SEL, cond: 'ne', row: 3, block: 0, address: 0x300cn, dst: selStr, args: [av(yesVal), av(noVal), av(flags)] };
  selStr.def = selStrDef;

  // (b) OP.SEL returning .bss buffers via model.addressRefs (no string text)
  const bssA = val(7, 'x3', 64, VK.DEF, { const: 0x20048n });
  const bssADef = { id: 14, op: OP.CONST, row: 4, block: 0, address: 0x3010n, dst: bssA, args: [], extra: { value: 0x20048n } };
  bssA.def = bssADef;

  const bssB = val(8, 'x4', 64, VK.DEF, { const: 0x20080n });
  const bssBDef = { id: 15, op: OP.CONST, row: 5, block: 0, address: 0x3014n, dst: bssB, args: [], extra: { value: 0x20080n } };
  bssB.def = bssBDef;

  const selBss = val(9, 'x0', 64);
  const selBssDef = { id: 16, op: OP.SEL, cond: 'eq', row: 6, block: 0, address: 0x3018n, dst: selBss, args: [av(bssA), av(bssB), av(flags)] };
  selBss.def = selBssDef;

  // (c) Unfolded OP.BIN adrp+add (value.const === null)
  const page = val(10, 'x5', 64, VK.DEF, { const: 0x20000n });
  page.def = { id: 17, op: OP.ADDR, row: 7, block: 0, address: 0x301cn, dst: page, args: [], extra: { value: 0x20000n } };
  const off = val(11, 'imm', 64, VK.DEF, { const: 0x48n });
  const addBss = val(12, 'x5', 64);
  addBss.def = { id: 18, op: OP.BIN, sub: 'add', row: 8, block: 0, address: 0x3020n, dst: addBss, args: [av(page), av(off)] };

  // (d) Plain integer OP.SEL (1 vs 0) stays numeric
  const one = val(13, 'w6', 32, VK.DEF, { const: 1n });
  const zero = val(14, 'w7', 32, VK.DEF, { const: 0n });
  const selInt = val(15, 'w0', 32);
  selInt.def = { id: 19, op: OP.SEL, cond: 'ne', row: 9, block: 0, address: 0x3024n, dst: selInt, args: [av(one), av(zero), av(flags)] };

  const ir = makeIr(
    [a1],
    [c0, flags, yesVal, noVal, selStr, bssA, bssB, selBss, page, off, addBss, one, zero, selInt],
    [cmpI, yesDef, noDef, selStrDef, bssADef, bssBDef, selBssDef, page.def, addBss.def, selInt.def],
  );
  const ctx = makeCtx(ir, {
    model: {
      calls: [],
      instructions: [],
      addressRefs: [
        { row: 40, addr: 0x20048n },
        { row: 41, addr: 0x20080n },
      ],
    },
    opts: {
      stringFor: (addr) => (addr === 0x990n ? 'Yes' : addr === 0x998n ? 'No' : null),
    },
  });

  const strText = renderValue(selStr, ctx);
  assert.match(strText, /"Yes"/, strText);
  assert.match(strText, /"No"/, strText);
  assert.doesNotMatch(strText, /0x990|0x998/i, strText);

  const bssText = renderValue(selBss, ctx);
  assert.match(bssText, /&global_20048/, bssText);
  assert.match(bssText, /&global_20080/, bssText);
  assert.doesNotMatch(bssText, /0x20048|0x20080/i, bssText);

  const binText = renderValue(addBss, ctx);
  assert.equal(binText, '&global_20048');

  const intText = renderValue(selInt, ctx);
  assert.match(intText, /\? 1 : 0/, intText);
  assert.doesNotMatch(intText, /&global_/, intText);
});

// ============================================================================
// Fix 4: Loop-invariant PHI format strings for sprintf/printf/snprintf varargs
// ============================================================================
test('Fix 4: callRecord unwraps loop-invariant PHI and MOV format strings to recover printf/sprintf varargs', () => {
  const buf = arg(1, 'x0', 64);
  const num = arg(2, 'x2', 32);

  const fmtAddr = val(3, 'x1', 64, VK.DEF, { const: 0x4000n });
  const fmtAddrDef = { id: 20, op: OP.ADDR, row: 0, block: 0, address: 0x4000n, dst: fmtAddr, args: [], extra: { value: 0x4000n } };
  fmtAddr.def = fmtAddrDef;

  const fmtMov = val(4, 'x1', 64);
  const fmtMovDef = { id: 21, op: OP.MOV, row: 1, block: 0, address: 0x4004n, dst: fmtMov, args: [av(fmtAddr)] };
  fmtMov.def = fmtMovDef;

  const fmtPhi = val(5, 'x1', 64);
  const fmtPhiDef = {
    id: 22, op: OP.PHI, row: 2, block: 0, address: 0x4008n, dst: fmtPhi,
    incoming: [{ value: fmtMov, from: 0 }, { value: fmtPhi, from: 0 }],
    args: [av(fmtMov), av(fmtPhi)],
  };
  fmtPhi.def = fmtPhiDef;

  const callRet = val(6, 'w0', 32);
  const callI = {
    id: 23, op: OP.CALL, row: 3, block: 0, address: 0x400cn, dst: callRet,
    args: [av(buf), av(fmtPhi), av(num)],
    callArguments: [
      { reg: 'x0', value: buf },
      { reg: 'x1', value: fmtPhi },
      { reg: 'x2', value: num },
    ],
    extra: { name: 'sprintf', target: 0x9000n },
  };
  callRet.def = callI;

  const ir = makeIr([buf, num], [fmtAddr, fmtMov, fmtPhi, callRet], [fmtAddrDef, fmtMovDef, fmtPhiDef, callI]);
  const ctx = makeCtx(ir, {
    opts: { stringFor: (addr) => (addr === 0x4000n ? '%d' : null) },
  });
  // Simulate PHI being lowered to a variable name so argText[1] is 'phi_5', not '"%d"'
  ctx.phiVarNames.set(fmtPhi.id, 'phi_5');

  const callText = renderValue(callRet, ctx);
  assert.match(callText, /^sprintf\(a1, phi_5, a3\)$/, callText);
  assert.doesNotMatch(callText, /varargs unknown/, callText);
});

// ============================================================================
// Fix 5: FP call parameter ABI, FP call return typing, and FP unary rendering
// ============================================================================
test('Fix 5A: callRecord uses AAPCS64 FP arg registers for pow/ldexp and types FP-returning call variables', () => {
  const gp0 = arg(1, 'x0', 32);
  const fp0 = arg(2, 'd0', 64);
  const fp1 = arg(3, 'd1', 64);

  const powRet = val(4, 'd0', 64);
  const powCall = {
    id: 30, op: OP.CALL, row: 0, block: 0, address: 0x5000n, dst: null,
    args: [av(fp0), av(fp1)],
    callArguments: [
      { reg: 'd0', value: fp0 },
      { reg: 'd1', value: fp1 },
    ],
    extra: { name: 'pow', target: 0x9100n },
  };
  powRet.def = powCall;

  const ldexpRet = val(5, 'd0', 64);
  const ldexpCall = {
    id: 31, op: OP.CALL, row: 1, block: 0, address: 0x5004n, dst: null,
    args: [av(powRet), av(gp0)],
    callArguments: [
      { reg: 'd0', value: powRet },
      { reg: 'x0', value: gp0 },
    ],
    extra: { name: 'ldexp', target: 0x9104n },
  };
  ldexpRet.def = ldexpCall;

  const retI = { id: 32, op: OP.RET, row: 2, block: 0, address: 0x5008n, args: [av(ldexpRet)] };
  powRet.uses.push(ldexpCall);
  ldexpRet.uses.push(retI);

  const ir = makeIr([gp0, fp0, fp1], [powRet, ldexpRet], [powCall, ldexpCall, retI]);
  const model = {
    name: 'test_pow',
    instructions: [
      { row: 0, address: 0x5000n },
      { row: 1, address: 0x5004n },
      { row: 2, address: 0x5008n },
    ],
    calls: [
      { row: 0, name: 'pow', target: 0x9100n },
      { row: 1, name: 'ldexp', target: 0x9104n },
    ],
    addressRefs: [],
  };

  const res = decompileSemantic(model, { ir, addr: 0x5000n });
  assert.match(res.pseudocode, /double call_4;/, res.pseudocode);
  assert.match(res.pseudocode, /call_4 = pow\(a1, a2\);/, res.pseudocode);
  assert.match(res.pseudocode, /call_5 = ldexp\(call_4, a1\);/, res.pseudocode);
  assert.equal(res.types.values.get(powRet.id)?.name, 'double');
  assert.equal(res.types.values.get(ldexpRet.id)?.name, 'double');
});

test('Fix 5B: unaryText renders ARM64 scalar FP conversion, rounding, and sqrt instructions', () => {
  const d0 = arg(1, 'd0', 64);
  const s0 = arg(2, 's0', 32);

  const cases = [
    { sub: 'fcvtps', src: d0, bits: 32, expected: '((int32_t)ceil(d0))' },
    { sub: 'fcvtps', src: s0, bits: 32, expected: '((int32_t)ceilf(s0))' },
    { sub: 'fcvtms', src: d0, bits: 32, expected: '((int32_t)floor(d0))' },
    { sub: 'fcvtms', src: s0, bits: 64, expected: '((int64_t)floorf(s0))' },
    { sub: 'fcvtas', src: d0, bits: 32, expected: '((int32_t)round(d0))' },
    { sub: 'fcvtns', src: s0, bits: 32, expected: '((int32_t)roundf(s0))' },
    { sub: 'fcvtpu', src: d0, bits: 32, expected: '((uint32_t)ceil(d0))' },
    { sub: 'fcvtmu', src: s0, bits: 64, expected: '((uint64_t)floorf(s0))' },
    { sub: 'fcvtau', src: d0, bits: 64, expected: '((uint64_t)round(d0))' },
    { sub: 'fcvtnu', src: s0, bits: 32, expected: '((uint32_t)roundf(s0))' },
    { sub: 'frinta', src: d0, bits: 64, expected: 'round(d0)' },
    { sub: 'frintn', src: s0, bits: 32, expected: 'roundf(s0)' },
    { sub: 'frintm', src: d0, bits: 64, expected: 'floor(d0)' },
    { sub: 'frintm', src: s0, bits: 32, expected: 'floorf(s0)' },
    { sub: 'frintp', src: d0, bits: 64, expected: 'ceil(d0)' },
    { sub: 'frintp', src: s0, bits: 32, expected: 'ceilf(s0)' },
    { sub: 'frintz', src: d0, bits: 64, expected: 'trunc(d0)' },
    { sub: 'frintz', src: s0, bits: 32, expected: 'truncf(s0)' },
    { sub: 'fsqrt', src: d0, bits: 64, expected: 'sqrt(d0)' },
    { sub: 'fsqrt', src: s0, bits: 32, expected: 'sqrtf(s0)' },
  ];

  const vals = [];
  const insts = [];
  cases.forEach((c, idx) => {
    const out = val(10 + idx, c.bits === 32 ? 'w0' : 'x0', c.bits);
    const inst = { id: 50 + idx, op: OP.UN, sub: c.sub, row: idx, block: 0, address: 0x6000n, bits: c.bits, dst: out, args: [av(c.src)] };
    out.def = inst;
    vals.push(out);
    insts.push(inst);
  });

  const ir = makeIr([d0, s0], vals, insts);
  const ctx = makeCtx(ir);
  cases.forEach((c, idx) => {
    assert.equal(renderValue(vals[idx], ctx), c.expected, `sub=${c.sub} bits=${c.bits}`);
  });
});
