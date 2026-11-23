import assert from 'node:assert/strict';
import test from 'node:test';
import { OP, VK, MK, COND } from '../../js/ir.js';
import {
  decompileSemantic,
  memoryElementType,
  reachingRegisterValue,
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

function makeIr(args, values, insts, blocks = null, loops = [], extra = {}) {
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
    loops,
    stackSlots: [],
    ...extra,
  };
}

// ============================================================================
// Fix 1: Allow 128-bit OP.LOAD local declarations
// ============================================================================
test('Fix 1: materialized 128-bit OP.LOAD declares uint128 instead of truncating to uint64', () => {
  const ptr = arg(1, 'x0', 64);
  const loaded = val(2, 'q0', 128);
  const storeVal = arg(3, 'x1', 64);
  const loc = { kind: MK.MEM, key: 'mem:x0+0', base: ptr, offset: 0n, size: 16 };
  const loadInst = {
    id: 10, op: OP.LOAD, row: 0, block: 0, address: 0x1000n,
    bits: 128, size: 16, dst: loaded, loc, args: [av(ptr)],
  };
  loaded.def = loadInst;
  const storeInst = {
    id: 11, op: OP.STORE, row: 1, block: 0, address: 0x1004n,
    bits: 64, size: 8, loc: { kind: MK.MEM, key: 'mem:x0+0', base: ptr, offset: 0n, size: 8 },
    args: [av(storeVal), av(ptr)],
  };
  const retInst = {
    id: 12, op: OP.RET, row: 2, block: 0, address: 0x1008n, args: [av(loaded)],
  };
  loaded.uses.push(retInst);
  ptr.uses.push(loadInst, storeInst);
  storeVal.uses.push(storeInst);

  const ir = makeIr([ptr, storeVal], [loaded], [loadInst, storeInst, retInst]);
  const model = {
    instructions: [
      { row: 0, address: 0x1000n, mnemonic: 'ldr', opStr: 'q0, [x0]' },
      { row: 1, address: 0x1004n, mnemonic: 'str', opStr: 'x1, [x0]' },
      { row: 2, address: 0x1008n, mnemonic: 'ret', opStr: '' },
    ],
    calls: [],
    addressRefs: [],
  };

  const res = decompileSemantic(model, { ir, name: 'load128', addr: 0x1000n });
  assert.match(res.pseudocode, /\buint128\s+\w+;/, `expected uint128 local decl, got:\n${res.pseudocode}`);
  assert.doesNotMatch(res.pseudocode, /\buint64\s+v_2;/, `should not truncate 128-bit load to uint64:\n${res.pseudocode}`);
});

// ============================================================================
// Fix 2: Copy-chain read-mirrors do not override in reachingRegisterValue
// ============================================================================
test('Fix 2: reachingRegisterValue ignores copy-chain read-mirror OP.MOVs in loop bodies', () => {
  const x0Arg = arg(1, 'x0', 64);
  const mirror1 = val(2, 'x0', 64);
  const mirror2 = val(3, 'x0', 64);
  const otherDef = val(4, 'x0', 64);

  const mov1 = { id: 10, op: OP.MOV, row: 1, block: 1, dst: mirror1, args: [av(x0Arg)] };
  mirror1.def = mov1;
  const mov2 = { id: 11, op: OP.MOV, sub: 'copy', row: 2, block: 1, dst: mirror2, args: [av(mirror1)] };
  mirror2.def = mov2;
  const jmpBack = { id: 12, op: OP.JMP, row: 3, block: 1, args: [] };
  const retInst = { id: 13, op: OP.RET, row: 4, block: 2, args: [] };

  const blocks = [
    { index: 0, startRow: 0, endRow: 0, succ: [1, 2], pred: [], phis: [], insts: [{ id: 9, op: OP.CBR, row: 0, block: 0, args: [] }] },
    { index: 1, startRow: 1, endRow: 3, succ: [1, 2], pred: [0, 1], phis: [], insts: [mov1, mov2, jmpBack] },
    { index: 2, startRow: 4, endRow: 4, succ: [], pred: [0, 1], phis: [], insts: [retInst] },
  ];

  const ir = makeIr([x0Arg], [mirror1, mirror2], [blocks[0].insts[0], mov1, mov2, jmpBack, retInst], blocks, [], {
    idom: [-1, 0, 0],
    dominators: [new Set([0]), new Set([0, 1]), new Set([0, 2])],
  });

  const reached = reachingRegisterValue(ir, retInst, 'x0', true);
  assert.equal(reached, x0Arg, 'copy-chain read-mirrors of x0Arg must not clobber reachingRegisterValue');

  // A genuinely different definition on a reaching path must still return null.
  const cInst = { id: 14, op: OP.CONST, row: 2, block: 1, dst: otherDef, args: [], extra: { value: 42n } };
  otherDef.def = cInst;
  otherDef.const = 42n;
  blocks[1].insts.splice(2, 0, cInst);
  const irWithOverride = makeIr([x0Arg], [mirror1, mirror2, otherDef], [blocks[0].insts[0], mov1, mov2, cInst, jmpBack, retInst], blocks, [], {
    idom: [-1, 0, 0],
    dominators: [new Set([0]), new Set([0, 1]), new Set([0, 2])],
  });
  const overridden = reachingRegisterValue(irWithOverride, retInst, 'x0', true);
  assert.equal(overridden, null, 'distinct reaching definition must still override and return null');
});

// ============================================================================
// Fix 3: isAddressDerivedValue depth cap + \b regex + &global_* (uintptr_t) cast
// ============================================================================
test('Fix 3a/3b/3c: deep MOV/CAST address chains, .rodata/.data section boundary, and &global_* byte-offset cast', () => {
  // 3a: >8 OP.MOV / OP.CAST hops from OP.ADDR remain address-derived and fold add
  const baseAddr = val(1, 'x0', 64, VK.DEF, { const: 0x402000n });
  const addrInst = { id: 100, op: OP.ADDR, row: 0, block: 0, dst: baseAddr, args: [], extra: { value: 0x402000n } };
  baseAddr.def = addrInst;

  const chainVals = [baseAddr];
  const insts = [addrInst];
  let cur = baseAddr;
  for (let i = 0; i < 12; i++) {
    const next = val(10 + i, 'x0', 64, VK.DEF, { const: 0x402000n });
    const op = i % 3 === 0 ? 'cast' : OP.MOV;
    const step = { id: 110 + i, op, row: i + 1, block: 0, dst: next, args: [av(cur)] };
    next.def = step;
    chainVals.push(next);
    insts.push(step);
    cur = next;
  }
  const offsetConst = val(50, 'imm', 64, VK.DEF, { const: 0x10n });
  const foldedDst = val(51, 'x1', 64);
  const foldedBin = { id: 200, op: OP.BIN, sub: 'add', row: 20, block: 0, dst: foldedDst, args: [av(cur), av(offsetConst)] };
  foldedDst.def = foldedBin;
  chainVals.push(offsetConst, foldedDst);
  insts.push(foldedBin);

  // 3b: section name ending with .rodata (tests fixed \b instead of \x08)
  const globalConst = val(60, 'x2', 64, VK.DEF, { const: 0x500000n });
  const globalConstInst = { id: 201, op: OP.CONST, row: 21, block: 0, dst: globalConst, args: [], extra: { value: 0x500000n } };
  globalConst.def = globalConstInst;

  // 3c: &global_<hex> + dynamic integer byte offset wraps &global_<hex> in (uintptr_t)(...)
  const dynIdx = arg(70, 'x3', 64);
  const addGlobalDst = val(71, 'x4', 64);
  const addGlobalInst = { id: 202, op: OP.BIN, sub: 'add', row: 22, block: 0, dst: addGlobalDst, args: [av(globalConst), av(dynIdx)] };
  addGlobalDst.def = addGlobalInst;

  const subGlobalDst = val(72, 'x5', 64);
  const subGlobalInst = { id: 203, op: OP.BIN, sub: 'sub', row: 23, block: 0, dst: subGlobalDst, args: [av(globalConst), av(dynIdx)] };
  subGlobalDst.def = subGlobalInst;

  const ir = makeIr(
    [dynIdx],
    [...chainVals, globalConst, addGlobalDst, subGlobalDst],
    [...insts, globalConstInst, addGlobalInst, subGlobalInst],
  );
  const ctx = makeCtx(ir, {
    opts: {
      sections: [
        { name: 'custom.rodata', start: 0x500000n, size: 0x1000n },
      ],
      stringFor: (a) => (a === 0x402010n ? 'hello_deep_chain' : null),
    },
    model: {
      calls: [],
      instructions: [],
      addressRefs: [{ row: 21, addr: 0x500000n }],
    },
  });

  // 3a check: folded through 12 MOV/CAST hops
  assert.equal(renderValue(foldedDst, ctx), '"hello_deep_chain"');
  // 3b check: custom.rodata recognized as known data section -> &global_500000
  assert.equal(renderValue(globalConst, ctx), '&global_500000');
  // 3c check: byte-offset add/sub wraps &global_500000 in (uintptr_t)
  assert.equal(renderValue(addGlobalDst, ctx), '((uintptr_t)(&global_500000)) + a4');
  assert.equal(renderValue(subGlobalDst, ctx), '((uintptr_t)(&global_500000)) - a4');
});

// ============================================================================
// Fix 4: Recognize ARM64 in isAArch64Context for semantic-ir-v2-to-v1
// ============================================================================
test('Fix 4: semantic-ir-v2-to-v1 with ARM64 architectureId resolves FP arg registers (d0/d1/s0)', () => {
  const d0Arg = arg(1, 'd0', 64);
  const d1Arg = arg(2, 'd1', 64);
  const callRes = val(3, 'd0', 64);
  const callInst = {
    id: 10, op: OP.CALL, row: 0, block: 0, address: 0x2000n,
    dst: callRes, args: [], extra: { name: '_pow', target: 0x9000n },
  };
  callRes.def = callInst;
  const retInst = { id: 11, op: OP.RET, row: 1, block: 0, address: 0x2004n, args: [av(callRes)] };
  callRes.uses.push(retInst);

  const ir = makeIr(
    [d0Arg, d1Arg],
    [callRes],
    [callInst, retInst],
    null,
    [],
    { compat: { projection: 'semantic-ir-v2-to-v1', architectureId: 'arm64' } },
  );

  // Direct reachingRegisterValue check for v0/d0/s0 aliasing under AArch64
  assert.equal(reachingRegisterValue(ir, callInst, 'v0'), d0Arg);
  assert.equal(reachingRegisterValue(ir, callInst, 's0'), d0Arg);
  assert.equal(reachingRegisterValue(ir, callInst, 'd1'), d1Arg);

  // End-to-end decompileSemantic renders pow(arg0, arg1) using FP args
  const model = {
    instructions: [
      { row: 0, address: 0x2000n, mnemonic: 'bl', opStr: '_pow' },
      { row: 1, address: 0x2004n, mnemonic: 'ret', opStr: '' },
    ],
    calls: [{ row: 0, address: 0x2000n, name: '_pow', target: 0x9000n }],
    addressRefs: [],
  };
  const res = decompileSemantic(model, { ir, name: 'call_pow', addr: 0x2000n });
  assert.match(res.pseudocode, /pow\([^,]+,\s*[^)]+\)/, `expected pow with 2 FP args, got:\n${res.pseudocode}`);
});

// ============================================================================
// Fix 5: Scalar FP OP.LOAD/OP.STORE and OP.CONST float literals
// ============================================================================
test('Fix 5: memoryElementType returns float/double and renderValue formats float/double OP.CONST literals', () => {
  // 5a: memoryElementType
  const dst32 = val(1, 'w0', 32);
  const dst64 = val(2, 'x0', 64);
  const loadFpExtra32 = { id: 10, op: OP.LOAD, dst: dst32, extra: { float: true } };
  const loadFpExtra64 = { id: 11, op: OP.LOAD, dst: dst64, extra: { float: true } };
  assert.equal(memoryElementType(loadFpExtra32, 4), 'float');
  assert.equal(memoryElementType(loadFpExtra64, 8), 'double');

  const srcTyped = val(3, 'x1', 64);
  const copyVal = val(4, 'x2', 64);
  const movCopy = { id: 12, op: OP.MOV, dst: copyVal, args: [av(srcTyped)] };
  copyVal.def = movCopy;
  const storeFpTyped = { id: 13, op: OP.STORE, args: [av(copyVal)] };
  const types = { values: new Map([[srcTyped.id, { name: 'double' }]]) };
  assert.equal(memoryElementType(storeFpTyped, 8, types), 'double');

  const dstTyped32 = val(5, 'w3', 32);
  const loadTyped32 = { id: 14, op: OP.LOAD, dst: dstTyped32 };
  const types32 = { values: new Map([[dstTyped32.id, 'float']]) };
  assert.equal(memoryElementType(loadTyped32, 4, types32), 'float');

  // 5b: renderValue float literals (constKind === 'float', typeof val.float === 'number', typeof d.extra?.float === 'number')
  const fHalf = val(20, 's0', 32, VK.DEF, { constKind: 'float', const: 0.5 });
  const fNegOne = val(21, 's1', 32, VK.DEF, { float: -1, const: 0xbf800000n });
  const fHundred = val(22, 's2', 32);
  fHundred.def = { id: 200, op: OP.CONST, bits: 32, dst: fHundred, args: [], extra: { float: 100 } };
  const dHalf = val(23, 'd0', 64, VK.DEF, { float: 0.5 });
  const fNegZero = val(24, 's3', 32, VK.DEF, { float: -0 });
  const fNaN = val(25, 's4', 32, VK.DEF, { float: Number.NaN });
  const dInf = val(26, 'd1', 64, VK.DEF, { float: Number.POSITIVE_INFINITY });
  const dNegInf = val(27, 'd2', 64, VK.DEF, { float: Number.NEGATIVE_INFINITY });

  const ir = makeIr([], [fHalf, fNegOne, fHundred, dHalf, fNegZero, fNaN, dInf, dNegInf], [fHundred.def]);
  const ctx = makeCtx(ir);

  assert.equal(renderValue(fHalf, ctx), '0.5f');
  assert.equal(renderValue(fNegOne, ctx), '-1.0f');
  assert.equal(renderValue(fHundred, ctx), '100.0f');
  assert.equal(renderValue(dHalf, ctx), '0.5');
  assert.equal(renderValue(fNegZero, ctx), '-0.0f');
  assert.equal(renderValue(fNaN, ctx), 'NAN');
  assert.equal(renderValue(dInf, ctx), 'INFINITY');
  assert.equal(renderValue(dNegInf, ctx), '-INFINITY');
});

// ============================================================================
// Fix 6: Post-loop uses in backedgePhisConflictWithConditionOrExit
// ============================================================================
test('Fix 6: self-loop whose backedge PHI is used post-loop emits if (exitCond) break before backedge copies', () => {
  const initVal = arg(1, 'x0', 64);
  const limitArg = arg(2, 'x1', 64);
  const phiVal = val(3, 'x0', 64);
  const oneConst = val(4, 'imm', 64, VK.DEF, { const: 1n });
  const nextVal = val(5, 'x0', 64);
  const cntPhi = val(6, 'x2', 64);
  const cntInit = val(7, 'imm', 64, VK.DEF, { const: 0n });
  const cntNext = val(8, 'x2', 64);
  const cmpVal = val(9, 'flags', 64);

  const b0Jmp = { id: 100, op: OP.JMP, row: 0, block: 0, address: 0x3000n, args: [] };

  const phiInst = {
    id: 101, op: OP.PHI, row: 1, block: 1, address: 0x3004n, dst: phiVal,
    incoming: [{ from: 0, value: initVal }, { from: 1, value: nextVal }],
  };
  phiVal.def = phiInst;
  const cntPhiInst = {
    id: 102, op: OP.PHI, row: 1, block: 1, address: 0x3004n, dst: cntPhi,
    incoming: [{ from: 0, value: cntInit }, { from: 1, value: cntNext }],
  };
  cntPhi.def = cntPhiInst;

  const addInst = { id: 103, op: OP.BIN, sub: 'add', row: 2, block: 1, address: 0x3008n, dst: nextVal, args: [av(phiVal), av(oneConst)] };
  nextVal.def = addInst;
  const cntAddInst = { id: 104, op: OP.BIN, sub: 'add', row: 3, block: 1, address: 0x300cn, dst: cntNext, args: [av(cntPhi), av(oneConst)] };
  cntNext.def = cntAddInst;

  // Condition only references cntNext & limitArg (NOT phiVal!)
  const cmpInst = { id: 105, op: OP.CMP, row: 4, block: 1, address: 0x3010n, dst: cmpVal, args: [av(cntNext), av(limitArg)] };
  cmpVal.def = cmpInst;
  const cbrInst = {
    id: 106, op: OP.CBR, row: 5, block: 1, address: 0x3014n,
    cond: COND.LT, args: [av(cmpVal)], extra: { target: 0x3004n, fallthrough: 0x3018n },
  };

  // Exit block (outside loop) uses phiVal directly via return!
  const retInst = { id: 107, op: OP.RET, row: 6, block: 2, address: 0x3018n, args: [av(phiVal)] };

  phiVal.uses.push(addInst, retInst);
  nextVal.uses.push(phiInst);
  cntPhi.uses.push(cntAddInst);
  cntNext.uses.push(cntPhiInst, cmpInst);
  cmpVal.uses.push(cbrInst);
  limitArg.uses.push(cmpInst);

  const blocks = [
    { index: 0, startRow: 0, endRow: 0, startAddr: 0x3000n, succ: [1], pred: [], phis: [], insts: [b0Jmp] },
    { index: 1, startRow: 1, endRow: 5, startAddr: 0x3004n, succ: [1, 2], pred: [0, 1], phis: [phiInst, cntPhiInst], insts: [phiInst, cntPhiInst, addInst, cntAddInst, cmpInst, cbrInst] },
    { index: 2, startRow: 6, endRow: 6, startAddr: 0x3018n, succ: [], pred: [1], phis: [], insts: [retInst] },
  ];
  const loop = { header: 1, nodes: new Set([1]), exits: new Set([2]), backedges: [[1, 1]] };
  const ir = makeIr(
    [initVal, limitArg],
    [phiVal, oneConst, nextVal, cntPhi, cntInit, cntNext, cmpVal],
    [b0Jmp, phiInst, cntPhiInst, addInst, cntAddInst, cmpInst, cbrInst, retInst],
    blocks,
    [loop],
  );
  const model = {
    instructions: [
      { row: 0, address: 0x3000n, mnemonic: 'b', opStr: '0x3004' },
      { row: 1, address: 0x3004n, mnemonic: 'nop', opStr: '' },
      { row: 2, address: 0x3008n, mnemonic: 'add', opStr: 'x0, x0, #1' },
      { row: 3, address: 0x300cn, mnemonic: 'add', opStr: 'x2, x2, #1' },
      { row: 4, address: 0x3010n, mnemonic: 'cmp', opStr: 'x2, x1' },
      { row: 5, address: 0x3014n, mnemonic: 'b.lt', opStr: '0x3004' },
      { row: 6, address: 0x3018n, mnemonic: 'ret', opStr: '' },
    ],
    calls: [],
    addressRefs: [],
  };

  const rowByAddr = new Map(model.instructions.map((ins) => [ins.address, ins.row]));
  const res = decompileSemantic(model, { ir, name: 'post_loop_phi_use', addr: 0x3000n, rowOfAddress: (a) => rowByAddr.get(a) ?? null });
  assert.match(res.pseudocode, /if\s*\(.+\)\s*break;/, `expected break-before-backedge-copy, got:\n${res.pseudocode}`);
  assert.match(res.pseudocode, /\}\s*while\s*\(1\);/, `expected while (1) loop, got:\n${res.pseudocode}`);
});

// ============================================================================
// Fix 7: Tag owning predecessor block on PHI copies in emitPhiCopiesForEdge
// ============================================================================
test('Fix 7: emitPhiCopiesForEdge tags block: fromBi on emitted PHI-copy nodes', () => {
  const condArg = arg(1, 'x0', 64);
  const zero = val(2, 'imm', 64, VK.DEF, { const: 0n });
  const c10 = val(3, 'imm', 64, VK.DEF, { const: 10n });
  const c20 = val(4, 'imm', 64, VK.DEF, { const: 20n });
  const cmpVal = val(5, 'flags', 64);
  const phiDst = val(6, 'x0', 64);

  const cmpInst = { id: 10, op: OP.CMP, row: 0, block: 0, address: 0x4000n, dst: cmpVal, args: [av(condArg), av(zero)] };
  cmpVal.def = cmpInst;
  const cbrInst = {
    id: 11, op: OP.CBR, row: 1, block: 0, address: 0x4004n,
    cond: COND.NE, args: [av(cmpVal)], extra: { target: 0x4008n, fallthrough: 0x400cn },
  };
  const b1Jmp = { id: 12, op: OP.JMP, row: 2, block: 1, address: 0x4008n, args: [] };
  const b2Jmp = { id: 13, op: OP.JMP, row: 3, block: 2, address: 0x400cn, args: [] };
  const phiInst = {
    id: 14, op: OP.PHI, row: 4, block: 3, address: 0x4010n, dst: phiDst,
    incoming: [{ from: 1, value: c10 }, { from: 2, value: c20 }],
  };
  phiDst.def = phiInst;
  const retInst = { id: 15, op: OP.RET, row: 5, block: 3, address: 0x4014n, args: [av(phiDst)] };

  condArg.uses.push(cmpInst);
  cmpVal.uses.push(cbrInst);
  phiDst.uses.push(retInst);

  const blocks = [
    { index: 0, startRow: 0, endRow: 1, startAddr: 0x4000n, succ: [1, 2], pred: [], phis: [], insts: [cmpInst, cbrInst] },
    { index: 1, startRow: 2, endRow: 2, startAddr: 0x4008n, succ: [3], pred: [0], phis: [], insts: [b1Jmp] },
    { index: 2, startRow: 3, endRow: 3, startAddr: 0x400cn, succ: [3], pred: [0], phis: [], insts: [b2Jmp] },
    { index: 3, startRow: 4, endRow: 5, startAddr: 0x4010n, succ: [], pred: [1, 2], phis: [phiInst], insts: [phiInst, retInst] },
  ];
  const ir = makeIr([condArg], [zero, c10, c20, cmpVal, phiDst], [cmpInst, cbrInst, b1Jmp, b2Jmp, phiInst, retInst], blocks);
  const model = {
    instructions: [
      { row: 0, address: 0x4000n, mnemonic: 'cmp', opStr: 'x0, #0' },
      { row: 1, address: 0x4004n, mnemonic: 'b.ne', opStr: '0x4008' },
      { row: 2, address: 0x4008n, mnemonic: 'b', opStr: '0x4010' },
      { row: 3, address: 0x400cn, mnemonic: 'b', opStr: '0x4010' },
      { row: 4, address: 0x4010n, mnemonic: 'nop', opStr: '' },
      { row: 5, address: 0x4014n, mnemonic: 'ret', opStr: '' },
    ],
    calls: [],
    addressRefs: [],
  };

  const res = decompileSemantic(model, { ir, name: 'diamond_phi', addr: 0x4000n });
  const copy10 = res.lines.find((n) => n.kind === 'stmt' && /=\s*10;/.test(n.text));
  const copy20 = res.lines.find((n) => n.kind === 'stmt' && /=\s*20;/.test(n.text));
  assert.ok(copy10, `expected PHI copy for 10 in:\n${res.pseudocode}`);
  assert.ok(copy20, `expected PHI copy for 20 in:\n${res.pseudocode}`);
  assert.equal(copy10.block, 1, 'PHI copy from arm 1 must be tagged with block 1, not join block 3');
  assert.equal(copy20.block, 2, 'PHI copy from arm 2 must be tagged with block 2, not join block 3');
});

// ============================================================================
// Fix 8: Include implicitRetUses in materialization crossesBarrier
// ============================================================================
test('Fix 8: LOAD feeding a PHI chain that reaches implicitRetUses is materialized before free()', () => {
  const ptr = arg(1, 'x0', 64);
  const loaded = val(2, 'x1', 64);
  const other = val(3, 'imm', 64, VK.DEF, { const: 0n });
  const phi1Dst = val(4, 'x0', 64);
  const phi2Dst = val(5, 'x0', 64);

  const loc = { kind: MK.MEM, key: 'mem:x0+0', base: ptr, disp: 0n, size: 8 };
  const loadInst = {
    id: 10, op: OP.LOAD, row: 0, block: 0, address: 0x5000n,
    bits: 64, size: 8, dst: loaded, loc, args: [av(ptr)],
  };
  loaded.def = loadInst;
  const freeCall = {
    id: 11, op: OP.CALL, row: 1, block: 0, address: 0x5004n,
    args: [av(ptr)], extra: { name: '_free', target: 0x9010n },
  };
  const b0Jmp = { id: 12, op: OP.JMP, row: 2, block: 0, address: 0x5008n, args: [] };

  const phi1 = {
    id: 13, op: OP.PHI, row: 3, block: 1, address: 0x500cn, dst: phi1Dst,
    incoming: [{ from: 0, value: loaded }, { from: 1, value: other }],
  };
  phi1Dst.def = phi1;
  const b1Jmp = { id: 14, op: OP.JMP, row: 4, block: 1, address: 0x5010n, args: [] };

  // Second PHI in block 2 whose dst has NO explicit .uses (consumed only by implicit RET!)
  const phi2 = {
    id: 15, op: OP.PHI, row: 5, block: 2, address: 0x5014n, dst: phi2Dst,
    incoming: [{ from: 1, value: phi1Dst }],
  };
  phi2Dst.def = phi2;
  const retInst = { id: 16, op: OP.RET, row: 6, block: 2, address: 0x5018n, args: [] };

  ptr.uses.push(loadInst, freeCall);
  loaded.uses.push(phi1);
  phi1Dst.uses.push(phi2);
  // Note: phi2Dst.uses is intentionally EMPTY — only reached via implicitRetUses!

  const blocks = [
    { index: 0, startRow: 0, endRow: 2, startAddr: 0x5000n, succ: [1], pred: [], phis: [], insts: [loadInst, freeCall, b0Jmp] },
    { index: 1, startRow: 3, endRow: 4, startAddr: 0x500cn, succ: [2], pred: [0], phis: [phi1], insts: [phi1, b1Jmp] },
    { index: 2, startRow: 5, endRow: 6, startAddr: 0x5014n, succ: [], pred: [1], phis: [phi2], insts: [phi2, retInst] },
  ];
  const ir = makeIr(
    [ptr],
    [loaded, other, phi1Dst, phi2Dst],
    [loadInst, freeCall, b0Jmp, phi1, b1Jmp, phi2, retInst],
    blocks,
    [],
    {
      idom: [-1, 0, 1],
      dominators: [new Set([0]), new Set([0, 1]), new Set([0, 1, 2])],
    },
  );
  const model = {
    instructions: [
      { row: 0, address: 0x5000n, mnemonic: 'ldr', opStr: 'x1, [x0]' },
      { row: 1, address: 0x5004n, mnemonic: 'bl', opStr: '_free' },
      { row: 2, address: 0x5008n, mnemonic: 'b', opStr: '0x500c' },
      { row: 3, address: 0x500cn, mnemonic: 'nop', opStr: '' },
      { row: 4, address: 0x5010n, mnemonic: 'b', opStr: '0x5014' },
      { row: 5, address: 0x5014n, mnemonic: 'nop', opStr: '' },
      { row: 6, address: 0x5018n, mnemonic: 'ret', opStr: '' },
    ],
    calls: [{ row: 1, address: 0x5004n, name: '_free', target: 0x9010n }],
    addressRefs: [],
  };

  const res = decompileSemantic(model, { ir, name: 'load_before_free', addr: 0x5000n });
  const loadLineIdx = res.lines.findIndex((n) => n.kind === 'stmt' && /load_2\s*=/.test(n.text));
  const freeLineIdx = res.lines.findIndex((n) => n.kind === 'stmt' && /\bfree\(/.test(n.text));
  assert.ok(loadLineIdx >= 0, `expected materialized load statement in:\n${res.pseudocode}`);
  assert.ok(freeLineIdx >= 0, `expected free() call in:\n${res.pseudocode}`);
  assert.ok(loadLineIdx < freeLineIdx, `LOAD must be materialized BEFORE free(), got:\n${res.pseudocode}`);
});

// ============================================================================
// Fix 9: crossesBarrier follows trivial/self-loop PHIs across loop barriers
// ============================================================================
test('Fix 9: LOAD feeding a trivial self-loop PHI across a free() loop is materialized before the loop', () => {
  const ptr = arg(1, 'x0', 64);
  const limit = arg(2, 'x1', 64);
  const loaded = val(3, 'w22', 32);
  const loopPhi = val(4, 'w22', 32);
  const cntInit = val(5, 'imm', 64, VK.DEF, { const: 0n });
  const cntPhi = val(6, 'x20', 64);
  const one = val(7, 'imm', 64, VK.DEF, { const: 1n });
  const cntNext = val(8, 'x20', 64);
  const cmpVal = val(9, 'flags', 64);
  const exitPhi = val(10, 'w22', 32);
  const altConst = val(11, 'imm', 32, VK.DEF, { const: 0n });

  // Block 0: load before free-loop, jump to loop header (block 1)
  const loadInst = {
    id: 100, op: OP.LOAD, row: 0, block: 0, address: 0x6000n, dst: loaded,
    args: [av(ptr)], loc: { kind: 'mem', base: ptr, offset: 0, size: 4 },
  };
  loaded.def = loadInst;
  const b0Jmp = { id: 101, op: OP.JMP, row: 1, block: 0, address: 0x6004n, args: [] };

  // Block 1: self-loop with trivial loop-invariant PHI for loaded, plus free(ptr) call!
  const loopPhiInst = {
    id: 102, op: OP.PHI, row: 2, block: 1, address: 0x6008n, dst: loopPhi,
    incoming: [{ from: 0, value: loaded }, { from: 1, value: loopPhi }],
  };
  loopPhi.def = loopPhiInst;
  const cntPhiInst = {
    id: 103, op: OP.PHI, row: 2, block: 1, address: 0x6008n, dst: cntPhi,
    incoming: [{ from: 0, value: cntInit }, { from: 1, value: cntNext }],
  };
  cntPhi.def = cntPhiInst;
  const freeCall = {
    id: 104, op: OP.CALL, row: 3, block: 1, address: 0x600cn,
    args: [av(ptr)], extra: { target: 0x9010n, name: 'free' },
  };
  const addInst = {
    id: 105, op: OP.BIN, sub: 'add', row: 4, block: 1, address: 0x6010n, dst: cntNext,
    args: [av(cntPhi), av(one)],
  };
  cntNext.def = addInst;
  const cmpInst = {
    id: 106, op: OP.CMP, row: 5, block: 1, address: 0x6014n, dst: cmpVal,
    args: [av(cntNext), av(limit)],
  };
  cmpVal.def = cmpInst;
  const cbrInst = {
    id: 107, op: OP.CBR, row: 6, block: 1, address: 0x6018n,
    cond: COND.NE, args: [av(cmpVal)], extra: { target: 0x6008n, fallthrough: 0x601cn },
  };

  // Block 2: post-loop exit PHI merging loopPhi (from block 1) and altConst (from block 3)
  const exitPhiInst = {
    id: 108, op: OP.PHI, row: 7, block: 2, address: 0x601cn, dst: exitPhi,
    incoming: [{ from: 1, value: loopPhi }, { from: 3, value: altConst }],
  };
  exitPhi.def = exitPhiInst;
  const retInst = { id: 109, op: OP.RET, row: 8, block: 2, address: 0x6020n, args: [av(exitPhi)] };
  const b3Jmp = { id: 110, op: OP.JMP, row: 9, block: 3, address: 0x6024n, args: [] };

  ptr.uses.push(loadInst, freeCall);
  loaded.uses.push(loopPhiInst);
  loopPhi.uses.push(loopPhiInst, exitPhiInst);
  cntPhi.uses.push(addInst);
  cntNext.uses.push(cntPhiInst, cmpInst);
  limit.uses.push(cmpInst);
  cmpVal.uses.push(cbrInst);
  exitPhi.uses.push(retInst);

  const blocks = [
    { index: 0, startRow: 0, endRow: 1, startAddr: 0x6000n, succ: [1], pred: [], phis: [], insts: [loadInst, b0Jmp] },
    { index: 1, startRow: 2, endRow: 6, startAddr: 0x6008n, succ: [1, 2], pred: [0, 1], phis: [loopPhiInst, cntPhiInst], insts: [loopPhiInst, cntPhiInst, freeCall, addInst, cmpInst, cbrInst] },
    { index: 2, startRow: 7, endRow: 8, startAddr: 0x601cn, succ: [], pred: [1, 3], phis: [exitPhiInst], insts: [exitPhiInst, retInst] },
    { index: 3, startRow: 9, endRow: 9, startAddr: 0x6024n, succ: [2], pred: [], phis: [], insts: [b3Jmp] },
  ];
  const loop = { header: 1, nodes: new Set([1]), exits: new Set([2]), backedges: [[1, 1]] };
  const ir = makeIr(
    [ptr, limit],
    [loaded, loopPhi, cntInit, cntPhi, one, cntNext, cmpVal, exitPhi, altConst],
    [loadInst, b0Jmp, loopPhiInst, cntPhiInst, freeCall, addInst, cmpInst, cbrInst, exitPhiInst, retInst, b3Jmp],
    blocks,
    [loop],
  );
  const model = {
    instructions: [
      { row: 0, address: 0x6000n, mnemonic: 'ldr', opStr: 'w22, [x0]' },
      { row: 1, address: 0x6004n, mnemonic: 'b', opStr: '0x6008' },
      { row: 2, address: 0x6008n, mnemonic: 'nop', opStr: '' },
      { row: 3, address: 0x600cn, mnemonic: 'bl', opStr: 'free' },
      { row: 4, address: 0x6010n, mnemonic: 'add', opStr: 'x20, x20, #1' },
      { row: 5, address: 0x6014n, mnemonic: 'cmp', opStr: 'x20, x1' },
      { row: 6, address: 0x6018n, mnemonic: 'b.ne', opStr: '0x6008' },
      { row: 7, address: 0x601cn, mnemonic: 'nop', opStr: '' },
      { row: 8, address: 0x6020n, mnemonic: 'ret', opStr: '' },
      { row: 9, address: 0x6024n, mnemonic: 'b', opStr: '0x601c' },
    ],
    calls: [{ row: 3, address: 0x600cn, name: 'free', target: 0x9010n }],
    addressRefs: [],
  };
  const rowByAddr = new Map(model.instructions.map((ins) => [ins.address, ins.row]));
  const res = decompileSemantic(model, { ir, name: 'load_before_free_loop', addr: 0x6000n, rowOfAddress: (a) => rowByAddr.get(a) ?? null });
  const loadIdx = res.pseudocode.indexOf('load_3 =');
  const freeIdx = res.pseudocode.indexOf('free(');
  assert.ok(loadIdx >= 0, `expected materialized load_3 statement in:\n${res.pseudocode}`);
  assert.ok(freeIdx >= 0, `expected free() call in:\n${res.pseudocode}`);
  assert.ok(loadIdx < freeIdx, `LOAD must be materialized BEFORE free() loop, got:\n${res.pseudocode}`);
  assert.match(res.pseudocode, /phi_10\s*=\s*load_3;/, `expected post-loop phi_10 = load_3, got:\n${res.pseudocode}`);
});
