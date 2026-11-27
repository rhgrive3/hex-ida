import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSemanticModel, makeInstruction } from '../js/blocks-base.js';
import { buildIR, OP, VK } from '../js/architecture/compat/ir-core-arm64-aapcs64-v1.js';
import { expr } from '../js/decompiler/ast/nodes.js';
import { recoverExactStackPhiExpressions } from '../js/decompiler/passes/stack-phi-recovery.js';
import { recoverExactStackReturn } from '../js/decompiler/passes/stack-return-recovery.js';
import { projectNode } from '../js/semantics/compat/semantic-ir-v2-to-v1-nodes.js';

function makeStackTestContext({
  storeLoc,
  interveningLoc = null,
  loadLoc = storeLoc,
  loadSize = 8,
} = {}) {
  const valOld = { id: 1, kind: VK.ARG, reg: 'x0', bits: 64, signed: false, def: null, uses: [] };
  const valPart = { id: 2, kind: VK.ARG, reg: 'x1', bits: 64, signed: false, def: null, uses: [] };
  const valLoaded = { id: 3, kind: VK.TEMP, reg: 'x0', bits: 64, signed: false, def: null, uses: [] };

  const store = {
    id: 10, op: OP.STORE, block: 0, row: 1, address: 0x1004n,
    args: [{ value: valOld, bits: 64 }],
    loc: storeLoc,
    size: storeLoc.size ?? 8,
  };
  const intervening = interveningLoc ? [{
    id: 20, op: OP.STORE, block: 0, row: 2, address: 0x1008n,
    args: [{ value: valPart, bits: 64 }],
    loc: interveningLoc,
    size: interveningLoc.size ?? 8,
  }] : [];
  const load = {
    id: 30, op: OP.LOAD, block: 0, row: 3, address: 0x100cn,
    dst: valLoaded, args: [],
    loc: loadLoc,
    size: loadSize,
  };
  valLoaded.def = load;
  const ret = {
    id: 40, op: OP.RET, block: 0, row: 4, address: 0x1010n,
    args: [{ value: valLoaded, bits: 64 }],
  };

  const insts = [store, ...intervening, load, ret];
  const block0 = {
    index: 0, id: 0, startRow: 0, endRow: 4, address: 0x1000n,
    insts, phis: [], pred: [], succ: [], idom: -1,
  };
  const loadExpr = expr.load(
    { kind: 'stack', key: loadLoc.key, size: loadSize },
    64,
    { ir: [load.id], rows: [load.row], addresses: [load.address] },
  );

  return {
    semantic: true,
    ir: {
      blocks: [block0],
      instructions: insts,
      values: [valOld, valPart, valLoaded],
      idom: [-1],
      dominators: [new Set([0])],
    },
    semanticAst: {
      values: [
        { valueId: valOld.id, expression: expr.variable('a1', 64, false) },
        { valueId: valPart.id, expression: expr.variable('a2', 64, false) },
        { valueId: valLoaded.id, expression: loadExpr },
      ],
      conditions: [],
      stores: [],
      outputs: [{ name: 'return', expression: loadExpr }],
    },
    cAst: {
      header: 'int64_t f(int64_t a1, int64_t a2) {',
      footer: '}',
      body: [{
        kind: 'stmt', indent: 1, text: 'return slot;',
        row: ret.row, addr: ret.address,
        source: { ir: [ret.id], rows: [ret.row], addresses: [ret.address] },
        semantic: { op: 'return', ir: ret.id, expression: loadExpr },
      }],
    },
    lines: [],
    pseudocode: '',
  };
}

// ---------------------------------------------------------------------------
// 1 & 2. [P1] stackLocationsOverlap & parseStackByteRange
// ---------------------------------------------------------------------------
test('[W2A-01 P1] stackLocationsOverlap fails closed on different base or incompatible frameEpoch', () => {
  // Different base: sp vs x29 -> conservative barrier (blocks recovery)
  const diffBasePhi = makeStackTestContext({
    storeLoc: { kind: 'stack', key: 'stack:sp:c16:s8', baseReg: 'sp', frameEpoch: 0, disp: 16n, size: 8 },
    interveningLoc: { kind: 'stack', key: 'stack:x29:c16:s8', baseReg: 'x29', frameEpoch: 0, disp: 16n, size: 8 },
  });
  recoverExactStackPhiExpressions(diffBasePhi);
  assert.equal(diffBasePhi.cAst.body[0].text, 'return slot;');

  const diffBaseRet = makeStackTestContext({
    storeLoc: { kind: 'stack', key: 'stack:sp:c16:s8', baseReg: 'sp', frameEpoch: 0, disp: 16n, size: 8 },
    interveningLoc: { kind: 'stack', key: 'stack:x29:c16:s8', baseReg: 'x29', frameEpoch: 0, disp: 16n, size: 8 },
  });
  recoverExactStackReturn(diffBaseRet);
  assert.equal(diffBaseRet.cAst.body[0].text, 'return slot;');

  // Incompatible frameEpoch: e0 vs e1 -> conservative barrier (blocks recovery)
  const diffEpochPhi = makeStackTestContext({
    storeLoc: { kind: 'stack', key: 'stack:sp:e0:16:s8', baseReg: 'sp', frameEpoch: 0, disp: 16n, size: 8 },
    interveningLoc: { kind: 'stack', key: 'stack:sp:e1:16:s8', baseReg: 'sp', frameEpoch: 1, disp: 16n, size: 8 },
  });
  recoverExactStackPhiExpressions(diffEpochPhi);
  assert.equal(diffEpochPhi.cAst.body[0].text, 'return slot;');

  const diffEpochRet = makeStackTestContext({
    storeLoc: { kind: 'stack', key: 'stack:sp:e0:16:s8', baseReg: 'sp', frameEpoch: 0, disp: 16n, size: 8 },
    interveningLoc: { kind: 'stack', key: 'stack:sp:e1:16:s8', baseReg: 'sp', frameEpoch: 1, disp: 16n, size: 8 },
  });
  recoverExactStackReturn(diffEpochRet);
  assert.equal(diffEpochRet.cAst.body[0].text, 'return slot;');
});

test('[W2A-02 P1] parseStackByteRange handles stack:<num>, stack:<num>:s<size>, and stack:<name>:s<size>', () => {
  // stack:0:s8 vs stack:-8 (size 8) -> disjoint [-8, 0) and [0, 8) -> allows recovery
  const disjointNum = makeStackTestContext({
    storeLoc: { kind: 'stack', key: 'stack:0:s8', size: 8 },
    interveningLoc: { kind: 'stack', key: 'stack:-8', size: 8 },
  });
  recoverExactStackPhiExpressions(disjointNum);
  assert.equal(disjointNum.cAst.body[0].text, 'return a1;');

  // stack:-8 (size 8) vs stack:-4:s4 -> overlapping [-8, 0) and [-4, 0) -> blocks recovery
  const overlapNum = makeStackTestContext({
    storeLoc: { kind: 'stack', key: 'stack:-8', size: 8 },
    interveningLoc: { kind: 'stack', key: 'stack:-4:s4', size: 4 },
  });
  recoverExactStackReturn(overlapNum);
  assert.equal(overlapNum.cAst.body[0].text, 'return slot;');

  // Named keys with different names -> non-overlapping -> allows recovery
  const disjointNamed = makeStackTestContext({
    storeLoc: { kind: 'stack', key: 'stack:condition:s8', size: 8 },
    interveningLoc: { kind: 'stack', key: 'stack:other:s8', size: 8 },
  });
  recoverExactStackPhiExpressions(disjointNamed);
  assert.equal(disjointNamed.cAst.body[0].text, 'return a1;');

  // Mixing named key with base-register-addressed key -> conservative barrier (blocks recovery)
  const mixedBase = makeStackTestContext({
    storeLoc: { kind: 'stack', key: 'stack:sp:c0:s8', baseReg: 'sp', frameEpoch: 0, disp: 0n, size: 8 },
    interveningLoc: { kind: 'stack', key: 'stack:condition:s8', size: 8 },
  });
  recoverExactStackReturn(mixedBase);
  assert.equal(mixedBase.cAst.body[0].text, 'return slot;');
});

// ---------------------------------------------------------------------------
// 3. [P1] semantic-ir-v2-to-v1-nodes: arm64.fp.fcmp / fcmpe ReferenceError
// ---------------------------------------------------------------------------
test('[W2A-03 P1] projectNode handles arm64.fp.fcmp and arm64.fp.fcmpe without ReferenceError', () => {
  for (const operator of ['arm64.fp.fcmp', 'arm64.fp.fcmpe']) {
    const physicalStateCurrent = new Map();
    const valuesById = new Map([
      [1, { id: 1, kind: 'arg', bits: 64, uses: [] }],
      [2, { id: 2, kind: 'arg', bits: 64, uses: [] }],
      [3, { id: 3, kind: 'const', bits: 32, uses: [] }],
      [4, { id: 4, kind: 'const', bits: 32, uses: [] }],
      [10, { id: 10, kind: 'temp', bits: 4, uses: [] }],
      [11, { id: 11, kind: 'temp', bits: 32, uses: [] }],
    ]);
    const node = {
      id: 42,
      kind: 'intrinsic',
      operator,
      inputs: [1, 2, 3, 4],
      outputs: [10, 11],
      origin: { row: 1, address: 0x1000n },
      sourceEffectIds: [],
      intrinsic: {
        name: operator,
        memoryRead: { scope: 'none' },
        memoryWrite: { scope: 'none' },
        controlEffects: [],
        stateWrites: [{ key: 'nzcv' }],
      },
    };
    const context = {
      blockIndex: 0,
      row: 1,
      valuesById,
      ir: { instructions: [], values: Array.from(valuesById.values()) },
      nodeById: new Map([[42, node]]),
      blockBySemanticId: new Map(),
      producerByValueId: new Map(),
      comparisonCarrierByNodeId: new Map(),
      physicalStateCurrent,
      options: {},
    };
    const [inst] = projectNode(node, context);
    assert.equal(inst.op, 'cmp');
    assert.equal(inst.sub, 'fsub');
    assert.equal(inst.extra.float, true);
    assert.equal(inst.extra.signalingNaN, operator === 'arm64.fp.fcmpe');
    assert.ok(physicalStateCurrent.has('nzcv'));
    assert.equal(physicalStateCurrent.get('nzcv').value.id, 10);
  }
});

// ---------------------------------------------------------------------------
// 4. [P1] ir-core-arm64-aapcs64-v1: wideClobbers marks tracking
// ---------------------------------------------------------------------------
test('[W2A-04 P1] renameIterative pops wideClobbers from v8-v15 stacks at block leave', () => {
  // Block 0 branches to Block 1 (defines v8.16b, calls helper, returns) and Block 2 (uses v8)
  // Before fix: wideClobbers in Block 1 pushed a 64-bit clobber onto v8's stack without pushing
  // 'v8' to marks, so Block 2 saw Block 1's leaked clobber instead of Block 0's arg v8.
  const model = buildSemanticModel([
    { row: 0, address: 0x1000n, mn: 'cbnz', ops: 'x0, #0x1014' },
    { row: 1, address: 0x1004n, mn: 'mov', ops: 'v8.16b, v0.16b' },
    { row: 2, address: 0x1008n, mn: 'bl', ops: '#0x2000' },
    { row: 3, address: 0x100cn, mn: 'mov', ops: 'x0, xzr' },
    { row: 4, address: 0x1010n, mn: 'ret', ops: '' },
    { row: 5, address: 0x1014n, mn: 'mov', ops: 'v0.16b, v8.16b' },
    { row: 6, address: 0x1018n, mn: 'ret', ops: '' },
  ]);
  const ir = buildIR(model, { rowOfAddress: (addr) => Number((addr - 0x1000n) / 4n) });
  const movInBlock2 = ir.byRow.get(5)?.find((inst) => inst.op === OP.MOV);
  assert.ok(movInBlock2, 'mov in block 2 should exist');
  const srcVal = movInBlock2.args[0]?.value;
  assert.ok(srcVal, 'mov in block 2 should have a source value');
  assert.equal(srcVal.kind, VK.ARG, 'v8 in sibling block must be entry ARG, not leaked clobber from block 1');
});

// ---------------------------------------------------------------------------
// 5. [P1] ir-core-arm64-aapcs64-v1: buildMemorySSA incoming edges
// ---------------------------------------------------------------------------
test('[W2A-05 P1] buildMemorySSA records incoming edges even when predecessors are visited before merge block', () => {
  // Diamond CFG: block 0 -> block 1 (store), block 0 -> block 2 (store), both -> block 3 (load)
  const model = buildSemanticModel([
    { row: 0, address: 0x1000n, mn: 'sub', ops: 'sp, sp, #0x20' },
    { row: 1, address: 0x1004n, mn: 'cbnz', ops: 'x0, #0x1014' },
    { row: 2, address: 0x1008n, mn: 'str', ops: 'x1, [sp, #8]' },
    { row: 3, address: 0x100cn, mn: 'b', ops: '#0x1018' },
    { row: 4, address: 0x1014n, mn: 'str', ops: 'x2, [sp, #8]' },
    { row: 5, address: 0x1018n, mn: 'ldr', ops: 'x0, [sp, #8]' },
    { row: 6, address: 0x101cn, mn: 'add', ops: 'sp, sp, #0x20' },
    { row: 7, address: 0x1020n, mn: 'ret', ops: '' },
  ]);
  const ir = buildIR(model, { rowOfAddress: (addr) => Number((addr - 0x1000n) / 4n) });
  const mergeBlock = ir.blocks.find((b) => b.pred.length >= 2);
  assert.ok(mergeBlock, 'merge block should exist');
  assert.ok(mergeBlock.memPhis.length > 0, 'merge block should have memPhi');
  const phi = mergeBlock.memPhis[0];
  assert.equal(phi.incoming.length, mergeBlock.pred.length,
    `memPhi should have incoming edges from all ${mergeBlock.pred.length} predecessors`);
});

// ---------------------------------------------------------------------------
// 6. [P2] ARM64 exclusive stores (stxr/stlxr/stxp/stlxp) & LSE atomics
// ---------------------------------------------------------------------------
test('[W2A-06 P2] ARM64 exclusive stores use ops[1..2] as stored data and define Ws; LSE atomics define result reg', () => {
  // 1) stxr w0, x1, [x2]: w0 is status output, x1 is stored value
  const stxrInsn = makeInstruction({ row: 0, address: 0x1000n, mn: 'stxr', ops: 'w0, x1, [x2]' });
  assert.equal(stxrInsn.memory?.kind, 'store');
  assert.equal(stxrInsn.memory?.size, 8);
  assert.deepEqual(stxrInsn.writes, ['x0']);

  // 2) stxp w0, x1, x2, [x3]: w0 is status output, x1 & x2 are stored values (16 bytes total)
  const stxpInsn = makeInstruction({ row: 0, address: 0x1000n, mn: 'stxp', ops: 'w0, x1, x2, [x3]' });
  assert.equal(stxpInsn.memory?.kind, 'store');
  assert.equal(stxpInsn.memory?.size, 16);
  assert.deepEqual(stxpInsn.writes, ['x0']);

  // Check IR lifting for stxr + stxp + ldadd
  const model = buildSemanticModel([
    { row: 0, address: 0x1000n, mn: 'mov', ops: 'w0, #0x55' },
    { row: 1, address: 0x1004n, mn: 'stxr', ops: 'w0, x1, [sp, #8]' },
    { row: 2, address: 0x1008n, mn: 'stlxp', ops: 'w4, x2, x3, [sp, #16]' },
    { row: 3, address: 0x100cn, mn: 'ldadd', ops: 'x5, x6, [sp, #32]' },
    { row: 4, address: 0x1010n, mn: 'ret', ops: '' },
  ]);
  const ir = buildIR(model, { rowOfAddress: (addr) => Number((addr - 0x1000n) / 4n) });

  // stxr: store arg must be x1 (ARG), not w0 (#0x55); and w0 must get a fresh DEF
  const stxrStore = ir.byRow.get(1)?.find((i) => i.op === OP.STORE);
  const stxrStatus = ir.byRow.get(1)?.find((i) => i.dst && i.dst.reg === 'x0');
  assert.ok(stxrStore, 'stxr should emit STORE');
  assert.equal(stxrStore.args[0]?.value?.reg, 'x1', 'stxr must store ops[1] (x1), not ops[0] (w0)');
  assert.ok(stxrStatus, 'stxr must define status register w0 (x0)');
  assert.equal(stxrStatus.dst.bits, 32);

  // stlxp: two STOREs with x2 and x3, plus status DEF for w4 (x4)
  const stlxpStores = (ir.byRow.get(2) || []).filter((i) => i.op === OP.STORE);
  const stlxpStatus = (ir.byRow.get(2) || []).find((i) => i.dst && i.dst.reg === 'x4');
  assert.equal(stlxpStores.length, 2, 'stlxp should emit 2 STOREs');
  assert.equal(stlxpStores[0].args[0]?.value?.reg, 'x2');
  assert.equal(stlxpStores[1].args[0]?.value?.reg, 'x3');
  assert.ok(stlxpStatus, 'stlxp must define status register w4 (x4)');

  // ldadd: defines result register x6 and emits STORE with x5
  const ldaddLoad = (ir.byRow.get(3) || []).find((i) => i.op === OP.LOAD);
  const ldaddStore = (ir.byRow.get(3) || []).find((i) => i.op === OP.STORE);
  assert.ok(ldaddLoad?.dst && ldaddLoad.dst.reg === 'x6', 'ldadd must define result register x6');
  assert.equal(ldaddStore?.args[0]?.value?.reg, 'x5', 'ldadd STORE must use source x5');
});

// ---------------------------------------------------------------------------
// 7. [W3T1-01 P1] ARM64 atomic OP.LOAD deferDef keeps pre-instruction inputs for OP.STORE
// ---------------------------------------------------------------------------
test('[W3T1-01 P1] ARM64 atomic OP.STORE resolves pre-instruction SSA values before OP.LOAD pushDef', () => {
  const model = buildSemanticModel([
    { row: 0, address: 0x1000n, mn: 'mov', ops: 'x0, #0x11' },
    { row: 1, address: 0x1004n, mn: 'mov', ops: 'x1, #0x22' },
    { row: 2, address: 0x1008n, mn: 'cas', ops: 'x0, x1, [x2]' },
    { row: 3, address: 0x100cn, mn: 'mov', ops: 'x3, x0' },
    { row: 4, address: 0x1010n, mn: 'ldadd', ops: 'x0, x0, [x2]' },
    { row: 5, address: 0x1014n, mn: 'mov', ops: 'x4, x0' },
    { row: 6, address: 0x1018n, mn: 'ldadd', ops: 'x1, x2, [x2]' },
    { row: 7, address: 0x101cn, mn: 'mov', ops: 'x5, x2' },
    { row: 8, address: 0x1020n, mn: 'ret', ops: '' },
  ]);
  const ir = buildIR(model, { rowOfAddress: (addr) => Number((addr - 0x1000n) / 4n) });

  // 1) cas x0, x1, [x2]: OP.LOAD precedes OP.STORE, and OP.STORE uses pre-cas x0 (#0x11)
  const movX0 = ir.byRow.get(0)?.find((i) => i.dst?.reg === 'x0');
  const casInsts = ir.byRow.get(2) || [];
  const casLoad = casInsts.find((i) => i.op === OP.LOAD);
  const casStore = casInsts.find((i) => i.op === OP.STORE);
  const afterCas = ir.byRow.get(3)?.find((i) => i.op === OP.MOV);
  assert.ok(casLoad && casStore, 'cas should emit OP.LOAD and OP.STORE');
  assert.ok(casInsts.indexOf(casLoad) < casInsts.indexOf(casStore), 'cas OP.LOAD must precede OP.STORE');
  assert.equal(casLoad.dst?.reg, 'x0');
  const casStoreX0Arg = casStore.args.find((a) => a.value?.reg === 'x0');
  assert.ok(casStoreX0Arg, 'cas OP.STORE should reference x0');
  assert.equal(casStoreX0Arg.value, movX0.dst, 'cas OP.STORE must use pre-instruction x0, not OP.LOAD dst');
  assert.notEqual(casStoreX0Arg.value, casLoad.dst);
  assert.equal(afterCas?.args[0]?.value, casLoad.dst, 'instruction after cas must see OP.LOAD dst');

  // 2) ldadd x0, x0, [x2]: OP.STORE must use pre-ldadd x0 (casLoad.dst), not ldaddLoad.dst
  const ldaddSelfInsts = ir.byRow.get(4) || [];
  const ldaddSelfLoad = ldaddSelfInsts.find((i) => i.op === OP.LOAD);
  const ldaddSelfStore = ldaddSelfInsts.find((i) => i.op === OP.STORE);
  const afterLdaddSelf = ir.byRow.get(5)?.find((i) => i.op === OP.MOV);
  assert.ok(ldaddSelfLoad && ldaddSelfStore);
  assert.ok(ldaddSelfInsts.indexOf(ldaddSelfLoad) < ldaddSelfInsts.indexOf(ldaddSelfStore));
  assert.equal(ldaddSelfStore.args[0]?.value, casLoad.dst, 'ldadd x0, x0, [x2] STORE must use pre-instruction x0');
  assert.notEqual(ldaddSelfStore.args[0]?.value, ldaddSelfLoad.dst);
  assert.equal(afterLdaddSelf?.args[0]?.value, ldaddSelfLoad.dst);

  // 3) ldadd x1, x2, [x2]: OP.STORE addr.base must use pre-instruction x2 (entry ARG), not ldaddBaseLoad.dst
  const ldaddBaseInsts = ir.byRow.get(6) || [];
  const ldaddBaseLoad = ldaddBaseInsts.find((i) => i.op === OP.LOAD);
  const ldaddBaseStore = ldaddBaseInsts.find((i) => i.op === OP.STORE);
  const afterLdaddBase = ir.byRow.get(7)?.find((i) => i.op === OP.MOV);
  assert.ok(ldaddBaseLoad && ldaddBaseStore);
  assert.equal(ldaddBaseLoad.dst?.reg, 'x2');
  assert.equal(ldaddBaseStore.addr?.base, ir.args.get('x2'), 'ldadd x1, x2, [x2] STORE addr.base must use pre-instruction x2');
  assert.notEqual(ldaddBaseStore.addr?.base, ldaddBaseLoad.dst);
  assert.equal(afterLdaddBase?.args[0]?.value, ldaddBaseLoad.dst);

  // 4) Diamond CFG merge starting with cas x0, x1, [x2]: x0 must be live-in and get a PHI
  const rowOfDiamond = (addr) => Number((addr - 0x2000n) / 4n);
  const diamondModel = buildSemanticModel([
    { row: 0, address: 0x2000n, mn: 'cbnz', ops: 'x3, #0x200c' },
    { row: 1, address: 0x2004n, mn: 'mov', ops: 'x0, #1' },
    { row: 2, address: 0x2008n, mn: 'b', ops: '#0x2010' },
    { row: 3, address: 0x200cn, mn: 'mov', ops: 'x0, #2' },
    { row: 4, address: 0x2010n, mn: 'cas', ops: 'x0, x1, [x2]' },
    { row: 5, address: 0x2014n, mn: 'ret', ops: '' },
  ], { rowOfAddress: rowOfDiamond });
  const diamondIr = buildIR(diamondModel, { rowOfAddress: rowOfDiamond });
  const mergeBlock = diamondIr.blocks.find((b) => b.pred.length >= 2);
  const x0Phi = mergeBlock?.phis.find((phi) => phi.reg === 'x0');
  const mergeCasStore = diamondIr.byRow.get(4)?.find((i) => i.op === OP.STORE);
  assert.ok(x0Phi, 'x0 must be live-in at merge block starting with cas x0, x1, [x2]');
  assert.ok(mergeCasStore?.args.some((a) => a.value === x0Phi.dst), 'cas STORE at merge must use the x0 PHI');
});

// ---------------------------------------------------------------------------
// 8. [W3T1-02 P1] stackLocationsOverlap fails closed between range and named slots
// ---------------------------------------------------------------------------
test('[W3T1-02 P1] stackLocationsOverlap treats range vs named slots as conservative barrier', () => {
  // Same $frame base, null scope: range (stack:0:s8) vs named (stack:condition:s8)
  for (const recover of [recoverExactStackPhiExpressions, recoverExactStackReturn]) {
    const ctx = makeStackTestContext({
      storeLoc: { kind: 'stack', key: 'stack:0:s8', size: 8 },
      interveningLoc: { kind: 'stack', key: 'stack:condition:s8', size: 8 },
    });
    recover(ctx);
    assert.equal(ctx.cAst.body[0].text, 'return slot;', `${recover.name} must block range vs named ($frame)`);
  }

  // Same physical baseReg (sp) and same frameEpoch (0): range vs named
  for (const recover of [recoverExactStackPhiExpressions, recoverExactStackReturn]) {
    const ctx = makeStackTestContext({
      storeLoc: { kind: 'stack', key: 'stack:sp:e0:16:s8', baseReg: 'sp', frameEpoch: 0, disp: 16n, size: 8 },
      interveningLoc: { kind: 'stack', key: 'stack:condition:s8', baseReg: 'sp', frameEpoch: 0, size: 8 },
    });
    recover(ctx);
    assert.equal(ctx.cAst.body[0].text, 'return slot;', `${recover.name} must block range vs named (sp, e0)`);
  }
});

// ---------------------------------------------------------------------------
// 9. [W3T1-03 P1] stackScopesCompatible fails closed on null vs epoch; parseStackByteRange honors frameEpoch
// ---------------------------------------------------------------------------
test('[W3T1-03 P1] stackScopesCompatible rejects null vs epoch and parseStackByteRange reflects frameEpoch', () => {
  // 1) Epoch-qualified vs unknown-epoch (null) at disjoint offsets -> fail-closed (blocks recovery)
  for (const recover of [recoverExactStackPhiExpressions, recoverExactStackReturn]) {
    const ctx = makeStackTestContext({
      storeLoc: { kind: 'stack', key: 'stack:sp:e0:16:s8', baseReg: 'sp', frameEpoch: 0, disp: 16n, size: 8 },
      interveningLoc: { kind: 'stack', key: 'stack:sp:24:s8', size: 8 },
    });
    recover(ctx);
    assert.equal(ctx.cAst.body[0].text, 'return slot;', `${recover.name} must fail-closed on e0 vs null scope`);
  }

  // 2) Formats stack:<base><±off>:s<size>, stack:<base>:<off>:s<size>, [<base>, #<off>]:s<size> reflect frameEpoch
  const formats = [
    ['stack:sp+16:s8', 'stack:sp+24:s8'],
    ['stack:sp:16:s8', 'stack:sp:24:s8'],
    ['[sp, #16]:s8', '[sp, #24]:s8'],
  ];
  for (const [keyA, keyB] of formats) {
    for (const recover of [recoverExactStackPhiExpressions, recoverExactStackReturn]) {
      // Different frameEpoch -> fail-closed even though offsets 16 and 24 are disjoint
      const diffEpoch = makeStackTestContext({
        storeLoc: { kind: 'stack', key: keyA, frameEpoch: 0, size: 8 },
        interveningLoc: { kind: 'stack', key: keyB, frameEpoch: 1, size: 8 },
      });
      recover(diffEpoch);
      assert.equal(diffEpoch.cAst.body[0].text, 'return slot;', `${recover.name} must block ${keyA}(e0) vs ${keyB}(e1)`);

      // Same frameEpoch -> disjoint offsets allow recovery
      const sameEpoch = makeStackTestContext({
        storeLoc: { kind: 'stack', key: keyA, frameEpoch: 0, size: 8 },
        interveningLoc: { kind: 'stack', key: keyB, frameEpoch: 0, size: 8 },
      });
      recover(sameEpoch);
      assert.equal(sameEpoch.cAst.body[0].text, 'return a1;', `${recover.name} must allow ${keyA}(e0) vs ${keyB}(e0)`);
    }
  }
});
