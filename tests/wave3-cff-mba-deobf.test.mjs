import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CFF_STATUS,
  CFF_GUARD_REASON,
  unflattenCffIr,
  runCffUnflattenWasm,
} from '../js/analysis/deobf/cff-unflatten.js';

import {
  MBA_MAX_NODES,
  inspectMbaDag,
  evalMbaDag,
  verifyMbaEquiv,
  simplifyMbaDag,
} from '../js/analysis/deobf/mba-simplifier.js';

function makeValidCffIr({
  firstBlockId = 10,
  preExtraSucc = null,
  preTerminator = null,
  preInsts = null,
  dispatchCases = null,
  block10Insts = null,
} = {}) {
  const b1 = firstBlockId;
  const b2 = 20;
  const b3 = 30;
  const b4 = 40;
  const dispId = 100;
  const preId = 1;
  const earlyExitId = 99;

  const blocks = [
    {
      id: preId,
      insts: preInsts ?? [{ op: 'const', dst: 'state', value: 0x10n }],
      succs: preExtraSucc != null ? [dispId, preExtraSucc] : [dispId],
      ...(preTerminator ? { terminator: preTerminator } : {}),
    },
    {
      id: dispId,
      stateVar: 'state',
      insts: [],
      succs: [b1, b2, b3, b4],
      dispatchCases: dispatchCases ?? {
        '0x10': b1,
        '0x20': b2,
        '0x30': b3,
        '0x40': b4,
      },
    },
    {
      id: b1,
      insts: block10Insts ?? [{ op: 'const', dst: 'state', value: 0x20n }],
      succs: [dispId],
    },
    {
      id: b2,
      insts: [{ op: 'csel', dst: 'state', condInstId: 7, trueVal: 0x30n, falseVal: 0x40n }],
      succs: [dispId],
    },
    {
      id: b3,
      insts: [{ op: 'const', dst: 'state', value: 0x40n }],
      succs: [dispId],
    },
    {
      id: b4,
      insts: [{ op: 'ret' }],
      succs: [],
    },
  ];
  if (preExtraSucc != null) {
    blocks.push({
      id: earlyExitId,
      insts: [{ op: 'ret' }],
      succs: [],
    });
  }
  return {
    entryBlock: preId,
    stateVar: 'state',
    blocks,
  };
}

// ============================================================================
// CFF Unflatten Regression Tests
// ============================================================================

test('CFF: allows block ID 0 as firstReal without falsely failing integrity check', () => {
  const ir = makeValidCffIr({ firstBlockId: 0 });
  const res = unflattenCffIr(ir, { flags: 0x01 });
  assert.equal(res.statusCode, CFF_STATUS.RECOVERED);
  assert.equal(res.guardFailReason, CFF_GUARD_REASON.NONE);
  const pre = res.unflattenedIr.blocks.find((b) => b.id === 1);
  assert.deepEqual(pre.succs, [0]);
});

test('CFF: preDraft preserves non-dispatcher branches and rewrites terminator without mutating input', () => {
  const origTerminator = { op: 'cbr', condInstId: 42, trueDst: 100, falseDst: 99 };
  const ir = makeValidCffIr({
    firstBlockId: 10,
    preExtraSucc: 99,
    preTerminator: origTerminator,
  });
  const res = unflattenCffIr(ir, { flags: 0x01 });
  assert.equal(res.statusCode, CFF_STATUS.RECOVERED);
  const pre = res.unflattenedIr.blocks.find((b) => b.id === 1);
  assert.deepEqual(pre.succs, [10, 99]);
  assert.deepEqual(pre.terminator, { op: 'cbr', condInstId: 42, trueDst: 10, falseDst: 99 });
  assert.equal(origTerminator.trueDst, 100);
});

test('CFF: mba_expr with unknown dynamic variable fails closed as UNRESOLVED_TRANSITION', () => {
  const ir = makeValidCffIr({
    block10Insts: [
      {
        op: 'mba_expr',
        dst: 'state',
        dag: {
          op: 'add',
          width: 64,
          a: { op: 'var', name: 'state', width: 64 },
          b: { op: 'var', name: 'arg0', width: 64 },
        },
      },
    ],
  });
  const res = unflattenCffIr(ir, { flags: 0x05 });
  assert.equal(res.statusCode, CFF_STATUS.ABORT_GUARD);
  assert.equal(res.guardFailReason, CFF_GUARD_REASON.UNRESOLVED_TRANSITION);
});

test('CFF: mba_expr referencing only stateVar succeeds', () => {
  const ir = makeValidCffIr({
    block10Insts: [
      {
        op: 'mba_expr',
        dst: 'state',
        dag: {
          op: 'add',
          width: 64,
          a: { op: 'var', name: 'state', width: 64 },
          b: { op: 'const', value: 0x10n, width: 64 },
        },
      },
    ],
  });
  const res = unflattenCffIr(ir, { flags: 0x05 });
  assert.equal(res.statusCode, CFF_STATUS.RECOVERED);
});

test('CFF: add_const / xor_const / mba_expr after csel fails closed as UNRESOLVED_TRANSITION', () => {
  for (const followUp of [
    { op: 'add_const', dst: 'state', imm: 0x10n },
    { op: 'xor_const', dst: 'state', imm: 0x10n },
    {
      op: 'mba_expr',
      dst: 'state',
      dag: { op: 'add', width: 64, a: { op: 'var', name: 'state', width: 64 }, b: { op: 'const', value: 0x10n, width: 64 } },
    },
  ]) {
    const ir = makeValidCffIr({
      block10Insts: [
        { op: 'csel', dst: 'state', condInstId: 9, trueVal: 0x20n, falseVal: 0x30n },
        followUp,
      ],
    });
    const res = unflattenCffIr(ir, { flags: 0x01 });
    assert.equal(res.statusCode, CFF_STATUS.ABORT_GUARD);
    assert.equal(res.guardFailReason, CFF_GUARD_REASON.UNRESOLVED_TRANSITION);
  }
});

test('CFF: invalid numeric operands fail closed without throwing', () => {
  const badValueIr = makeValidCffIr({
    block10Insts: [{ op: 'const', dst: 'state', value: 'not-a-number' }],
  });
  const r1 = unflattenCffIr(badValueIr, { flags: 0x01 });
  assert.equal(r1.statusCode, CFF_STATUS.ABORT_GUARD);
  assert.equal(r1.guardFailReason, CFF_GUARD_REASON.UNRESOLVED_TRANSITION);

  const badCselIr = makeValidCffIr({
    block10Insts: [{ op: 'csel', dst: 'state', trueVal: NaN, falseVal: 0x20n }],
  });
  const r2 = unflattenCffIr(badCselIr, { flags: 0x01 });
  assert.equal(r2.statusCode, CFF_STATUS.ABORT_GUARD);
  assert.equal(r2.guardFailReason, CFF_GUARD_REASON.UNRESOLVED_TRANSITION);
});

test('CFF: preBlock unknown op overwriting initState resets initState and fails closed', () => {
  const ir = makeValidCffIr({
    preInsts: [
      { op: 'const', dst: 'state', value: 0x10n },
      { op: 'add_reg', dst: 'state', srcs: ['state', 'x1'] },
    ],
  });
  const res = unflattenCffIr(ir, { flags: 0x01 });
  assert.equal(res.statusCode, CFF_STATUS.ABORT_GUARD);
  assert.equal(res.guardFailReason, CFF_GUARD_REASON.NATURAL_FSM_STATE_ORIGIN);
});

test('CFF: dispatchCases non-numeric key and masked/target collisions fail closed', () => {
  const badKeyIr = makeValidCffIr({
    dispatchCases: { not_a_num: 10, '0x20': 20, '0x30': 30, '0x40': 40 },
  });
  const r1 = unflattenCffIr(badKeyIr, { flags: 0x01 });
  assert.equal(r1.statusCode, CFF_STATUS.ABORT_GUARD);
  assert.equal(r1.guardFailReason, CFF_GUARD_REASON.DRAFT_CFG_INTEGRITY_ERROR);

  const maskedCollisionIr = makeValidCffIr({
    dispatchCases: { '0x10': 10, '0x100000010': 20, '0x30': 30, '0x40': 40 },
  });
  const r2 = unflattenCffIr(maskedCollisionIr, { flags: 0x01, stateWidthBits: 32 });
  assert.equal(r2.statusCode, CFF_STATUS.ABORT_GUARD);
  assert.equal(r2.guardFailReason, CFF_GUARD_REASON.DRAFT_CFG_INTEGRITY_ERROR);

  const targetCollisionIr = makeValidCffIr({
    dispatchCases: { '0x10': 10, '0x20': 10, '0x30': 30, '0x40': 40 },
  });
  const r3 = unflattenCffIr(targetCollisionIr, { flags: 0x01 });
  assert.equal(r3.statusCode, CFF_STATUS.ABORT_GUARD);
  assert.equal(r3.guardFailReason, CFF_GUARD_REASON.DRAFT_CFG_INTEGRITY_ERROR);
});

test('CFF WASM bridge: rejects non-array inputs, OOB recoveredEdgeCount, and survives memory.grow', () => {
  assert.equal(runCffUnflattenWasm(null, []), null);
  assert.equal(runCffUnflattenWasm([], null), null);

  const mem = new WebAssembly.Memory({ initial: 2, maximum: 4 });
  const mockOobExports = {
    memory: mem,
    hex_deobf_scratch_ptr: () => 1024,
    hex_deobf_scratch_size: () => 32768,
    hex_cff_unflatten: (_bp, _bc, _ep, _ec, _oep, maxOut, resPtr) => {
      mem.grow(1);
      const dv = new DataView(mem.buffer);
      dv.setUint32(resPtr + 0x18, maxOut + 5, true);
      return 0;
    },
  };
  assert.equal(runCffUnflattenWasm([{ blockId: 1, flags: 0 }], [], { wasmExports: mockOobExports }), null);

  const mem2 = new WebAssembly.Memory({ initial: 2, maximum: 4 });
  const mockGrowExports = {
    memory: mem2,
    hex_deobf_scratch_ptr: () => 1024,
    hex_deobf_scratch_size: () => 32768,
    hex_cff_unflatten: (_bp, _bc, _ep, _ec, outEdgePtr, _maxOut, resPtr) => {
      mem2.grow(1);
      const dv = new DataView(mem2.buffer);
      dv.setUint32(resPtr + 0x00, 0, true);
      dv.setUint32(resPtr + 0x18, 1, true);
      dv.setUint32(outEdgePtr + 0x00, 10, true);
      dv.setUint32(outEdgePtr + 0x04, 20, true);
      dv.setUint32(outEdgePtr + 0x08, 1, true);
      dv.setUint32(outEdgePtr + 0x0c, 0, true);
      return 0;
    },
  };
  const ok = runCffUnflattenWasm([{ blockId: 10, flags: 0 }], [], { wasmExports: mockGrowExports });
  assert.ok(ok);
  assert.equal(ok.recoveredEdgeCount, 1);
  assert.deepEqual(ok.recoveredEdges[0], { srcBlock: 10, dstBlock: 20, kind: 1, condId: 0 });
});

// ============================================================================
// MBA Simplifier Regression Tests
// ============================================================================

test('MBA: inspectMbaDag rejects cyclic mul child without stack overflow', () => {
  const cyc = { op: 'add', width: 64, a: null, b: { op: 'const', value: 1n, width: 64 } };
  cyc.a = cyc;
  const root = {
    op: 'mul',
    width: 64,
    a: cyc,
    b: { op: 'var', name: 'x', width: 64 },
  };
  const info = inspectMbaDag(root);
  assert.equal(info.eligible, false);
  assert.equal(info.reason, 'max_depth_exceeded');
});

test('MBA: inspectMbaDag classifies arithmetic nested inside bitwise ops as non-linear', () => {
  const x = { op: 'var', name: 'x', width: 64 };
  const y = { op: 'var', name: 'y', width: 64 };
  const z = { op: 'var', name: 'z', width: 64 };

  const nl1 = { op: 'and', width: 64, a: { op: 'add', width: 64, a: x, b: y }, b: z };
  const info1 = inspectMbaDag(nl1);
  assert.equal(info1.eligible, true);
  assert.equal(info1.isLinearMba, false);

  const nl2 = { op: 'xor', width: 64, a: { op: 'add', width: 64, a: x, b: { op: 'const', value: 1n, width: 64 } }, b: y };
  const info2 = inspectMbaDag(nl2);
  assert.equal(info2.eligible, true);
  assert.equal(info2.isLinearMba, false);

  // Non-linear expression must not be falsely proven via Layer 1 linear theorem
  const proof = verifyMbaEquiv(nl2, { op: 'xor', width: 64, a: { op: 'add', width: 64, a: x, b: { op: 'const', value: 1n, width: 64 } }, b: y });
  assert.equal(proof.proved, true);
  assert.equal(proof.layer1LinearTheorem, false);
});

test('MBA: evalMbaDag handles prototype keys safely and validates evalWidth', () => {
  const protoDag = {
    op: 'add',
    width: 64,
    a: { op: 'var', name: 'toString', width: 64 },
    b: { op: 'var', name: 'constructor', width: 64 },
  };
  assert.equal(evalMbaDag(protoDag, {}, 64), 0n);
  assert.equal(evalMbaDag(protoDag, { toString: 3n, constructor: 4n }, 64), 7n);

  // Full simplifyMbaDag with prototype-key variable names must not crash
  const obfProto = {
    op: 'add',
    width: 64,
    a: { op: 'xor', width: 64, a: { op: 'var', name: 'toString', width: 64 }, b: { op: 'var', name: 'constructor', width: 64 } },
    b: { op: 'mul', width: 64, a: { op: 'const', value: 2n, width: 64 }, b: { op: 'and', width: 64, a: { op: 'var', name: 'toString', width: 64 }, b: { op: 'var', name: 'constructor', width: 64 } } },
  };
  const simp = simplifyMbaDag(obfProto, { preferWasm: false });
  assert.equal(simp.simplified, true);
  assert.equal(evalMbaDag(simp.expr, { toString: 11n, constructor: 29n }, 64), 40n);

  for (const badWidth of [0, -8, 257, 32.5, NaN, '64']) {
    assert.throws(() => evalMbaDag(protoDag, {}, badWidth), RangeError);
  }
});

test('MBA: WASM bridge guards outCount > MBA_MAX_NODES, cyclic/OOB/null-child nodes, and memory.grow', () => {
  const x = { op: 'var', name: 'x', width: 64 };
  const y = { op: 'var', name: 'y', width: 64 };
  // (x ^ y) + 2 * (x & y) === x + y
  const dag = {
    op: 'add',
    width: 64,
    a: { op: 'xor', width: 64, a: x, b: y },
    b: {
      op: 'mul',
      width: 64,
      a: { op: 'add', width: 64, a: { op: 'const', value: 1n, width: 64 }, b: { op: 'const', value: 1n, width: 64 } },
      b: { op: 'and', width: 64, a: x, b: y },
    },
  };

  // 1) outCount > MBA_MAX_NODES -> fallback to JS
  const memOob = new WebAssembly.Memory({ initial: 2, maximum: 4 });
  const mockOob = {
    memory: memOob,
    hex_deobf_scratch_ptr: () => 1024,
    hex_deobf_scratch_size: () => 32768,
    hex_mba_simplify: (_ip, _ic, _ir, _op, _oc, outRootPtr, proofPtr) => {
      memOob.grow(1);
      const dv = new DataView(memOob.buffer);
      dv.setUint32(proofPtr + 0, 1, true);
      dv.setUint32(proofPtr + 4, 1, true);
      dv.setUint32(proofPtr + 8, 1, true);
      dv.setUint32(proofPtr + 16, 1, true);
      dv.setUint32(proofPtr + 28, MBA_MAX_NODES + 1, true);
      dv.setUint32(outRootPtr, 0, true);
      return 0;
    },
  };
  const rOob = simplifyMbaDag(dag, { preferWasm: true, wasmExports: mockOob });
  assert.equal(rOob.engine, 'js');
  assert.equal(rOob.simplified, true);

  // 2) Cyclic WASM output node (add(0, 0)) -> unflattenWasmNodes returns null -> fallback to JS
  const memCyc = new WebAssembly.Memory({ initial: 2, maximum: 4 });
  const mockCyc = {
    memory: memCyc,
    hex_deobf_scratch_ptr: () => 1024,
    hex_deobf_scratch_size: () => 32768,
    hex_mba_simplify: (_ip, _ic, _ir, outPtr, _oc, outRootPtr, proofPtr) => {
      const dv = new DataView(memCyc.buffer);
      dv.setUint32(proofPtr + 0, 1, true);
      dv.setUint32(proofPtr + 4, 1, true);
      dv.setUint32(proofPtr + 8, 1, true);
      dv.setUint32(proofPtr + 16, 1, true);
      dv.setUint32(proofPtr + 28, 1, true);
      dv.setUint32(outRootPtr, 0, true);
      dv.setUint32(outPtr + 0, 2, true); // add
      dv.setUint32(outPtr + 4, 0, true); // self-loop lhs
      dv.setUint32(outPtr + 8, 0, true); // self-loop rhs
      return 0;
    },
  };
  const rCyc = simplifyMbaDag(dag, { preferWasm: true, wasmExports: mockCyc });
  assert.equal(rCyc.engine, 'js');
  assert.equal(rCyc.simplified, true);

  // 3) Child node with unknown op -> null propagates to parent -> fallback to JS
  const memBadChild = new WebAssembly.Memory({ initial: 2, maximum: 4 });
  const mockBadChild = {
    memory: memBadChild,
    hex_deobf_scratch_ptr: () => 1024,
    hex_deobf_scratch_size: () => 32768,
    hex_mba_simplify: (_ip, _ic, _ir, outPtr, _oc, outRootPtr, proofPtr) => {
      const dv = new DataView(memBadChild.buffer);
      dv.setUint32(proofPtr + 0, 1, true);
      dv.setUint32(proofPtr + 4, 1, true);
      dv.setUint32(proofPtr + 8, 1, true);
      dv.setUint32(proofPtr + 16, 1, true);
      dv.setUint32(proofPtr + 28, 3, true);
      dv.setUint32(outRootPtr, 2, true);
      // node 0: var 0
      dv.setUint32(outPtr + 0, 0, true);
      dv.setUint32(outPtr + 4, 0, true);
      // node 1: invalid op 99
      dv.setUint32(outPtr + 24, 99, true);
      // node 2: add(0, 1)
      dv.setUint32(outPtr + 48, 2, true);
      dv.setUint32(outPtr + 52, 0, true);
      dv.setUint32(outPtr + 56, 1, true);
      return 0;
    },
  };
  const rBadChild = simplifyMbaDag(dag, { preferWasm: true, wasmExports: mockBadChild });
  assert.equal(rBadChild.engine, 'js');
  assert.equal(rBadChild.simplified, true);

  // 4) Constant-folded mul subtree reaches WASM path and succeeds across memory.grow
  let seenMulImm = null;
  const memOk = new WebAssembly.Memory({ initial: 2, maximum: 4 });
  const mockOk = {
    memory: memOk,
    hex_deobf_scratch_ptr: () => 1024,
    hex_deobf_scratch_size: () => 32768,
    hex_mba_simplify: (inPtr, inCount, _ir, outPtr, _oc, outRootPtr, proofPtr) => {
      const inDv = new DataView(memOk.buffer);
      for (let i = 0; i < inCount; i++) {
        const o = inPtr + i * 24;
        if (inDv.getUint32(o, true) === 9) {
          seenMulImm = inDv.getBigInt64(o + 16, true);
        }
      }
      memOk.grow(1);
      const dv = new DataView(memOk.buffer);
      dv.setUint32(proofPtr + 0, 1, true);
      dv.setUint32(proofPtr + 4, 1, true);
      dv.setUint32(proofPtr + 8, 1, true);
      dv.setUint32(proofPtr + 16, 1, true);
      dv.setUint32(proofPtr + 20, 5, true);
      dv.setUint32(proofPtr + 24, 1, true);
      dv.setUint32(proofPtr + 28, 3, true);
      dv.setUint32(outRootPtr, 2, true);
      // node 0: var 0, node 1: var 1, node 2: add(0, 1)
      dv.setUint32(outPtr + 0, 0, true);
      dv.setUint32(outPtr + 4, 0, true);
      dv.setUint32(outPtr + 24, 0, true);
      dv.setUint32(outPtr + 28, 1, true);
      dv.setUint32(outPtr + 48, 2, true);
      dv.setUint32(outPtr + 52, 0, true);
      dv.setUint32(outPtr + 56, 1, true);
      return 0;
    },
  };
  const rOk = simplifyMbaDag(dag, { preferWasm: true, wasmExports: mockOk });
  assert.equal(seenMulImm, 2n);
  assert.equal(rOk.engine, 'wasm');
  assert.equal(rOk.simplified, true);
  assert.equal(evalMbaDag(rOk.expr, { x: 13n, y: 29n }, 64), 42n);
});
