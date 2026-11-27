import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSemanticModel } from '../../js/blocks.js';
import { buildIR, setSemanticMigrationMode, OP, VK } from '../../js/ir.js';
import { SEMANTIC_V2_MIGRATION_MODES } from '../../js/semantics/compat/index.js';
import { projectSemanticIrV2ToLegacyV1 } from '../../js/semantics/compat/semantic-ir-v2-to-v1.js';
import { decompileSemantic, reachingRegisterValue } from '../../js/decompiler/semantic-core.js';
import { resolveABIPlugin } from '../../js/targets/abi/index.js';
import { semanticAbiAdapter } from '../../js/analysis/semantic-function-base.js';

const BASE = 0x100000000n;

function buildModel(lines) {
  const rows = lines.map((line, row) => {
    const trimmed = String(line).trim();
    const split = trimmed.indexOf(' ');
    return {
      row,
      address: BASE + BigInt(row * 4),
      mn: split < 0 ? trimmed : trimmed.slice(0, split),
      ops: split < 0 ? '' : trimmed.slice(split + 1).trim(),
    };
  });
  const rowOfAddress = (address) => {
    const delta = address - BASE;
    return delta < 0n || delta >= BigInt(rows.length * 4) ? null : Number(delta / 4n);
  };
  return {
    model: buildSemanticModel(rows, { startRow: 0, endRow: rows.length - 1, rowOfAddress }),
    rowOfAddress,
  };
}

function makeUnaryIr(sub, bits) {
  const arg0 = { id: 1, kind: VK.ARG, reg: 'd0', bits: 64, uses: [], def: null };
  const dst = { id: 2, kind: VK.DEF, reg: 'x0', bits, uses: [], def: null };
  const unary = { id: 10, op: OP.UN, sub, bits, dst, args: [{ value: arg0, bits: 64 }], block: 0, row: 0, address: BASE };
  dst.def = unary;
  arg0.uses.push(unary);
  const ret = { id: 11, op: OP.RET, dst: null, args: [{ value: dst, bits }], block: 0, row: 1, address: BASE + 4n };
  dst.uses.push(ret);
  const block = { index: 0, startRow: 0, endRow: 1, succ: [], pred: [], insts: [unary, ret], phis: [], isEntry: true, isExit: true };
  return {
    name: `fn_${sub}_${bits}`,
    entry: 0,
    blocks: [block],
    instructions: [unary, ret],
    values: [arg0, dst],
    args: new Map([['d0', arg0]]),
    dominators: [new Set([0])],
    idom: [-1],
  };
}

test('Fix 1: unaryText lowers fcvtzs/fcvtzu/scvtf/ucvtf/fcvt and aliases to C casts', () => {
  const cases = [
    ['fcvtzs', 32, '((int32_t)(double)'],
    ['fcvtzs', 64, '((int64_t)(double)'],
    ['f2i', 32, '((int32_t)(double)'],
    ['f2i', 64, '((int64_t)(double)'],
    ['fcvtzu', 32, '((uint32_t)(double)'],
    ['fcvtzu', 64, '((uint64_t)(double)'],
    ['f2u', 32, '((uint32_t)(double)'],
    ['f2u', 64, '((uint64_t)(double)'],
    ['scvtf', 32, '((float)(int64_t)'],
    ['scvtf', 64, '((double)(int64_t)'],
    ['i2f', 32, '((float)(int64_t)'],
    ['i2f', 64, '((double)(int64_t)'],
    ['ucvtf', 32, '((float)(uint64_t)'],
    ['ucvtf', 64, '((double)(uint64_t)'],
    ['u2f', 32, '((float)(uint64_t)'],
    ['u2f', 64, '((double)(uint64_t)'],
    ['fcvt', 32, '((float)'],
    ['fcvt', 64, '((double)'],
  ];

  for (const [sub, bits, expectedPrefix] of cases) {
    const ir = makeUnaryIr(sub, bits);
    const out = decompileSemantic({ instructions: [], calls: [] }, { ir });
    assert.ok(out && typeof out.pseudocode === 'string', `decompileSemantic failed for ${sub}:${bits}`);
    assert.ok(
      out.pseudocode.includes(expectedPrefix),
      `expected ${sub}:${bits} to include "${expectedPrefix}", got:\n${out.pseudocode}`,
    );
    assert.equal(
      out.pseudocode.includes(`${sub}(`),
      false,
      `must not emit undefined ${sub}(...) call in:\n${out.pseudocode}`,
    );
  }
});

test('Fix 2: ir-core selectReachingRegisterValue prefers same-row non-PHI def over PHI with higher value id', () => {
  // Loop header at row 2 (0x100000008): entry PHI on x1 shares row 2 with `mov w1, w19`,
  // then calls strchr; backedge updates x1 via strchr's clobber/loop.
  const { model, rowOfAddress } = buildModel([
    'mov w19, #0x2a',        // row 0: 0x100000000
    'cbz x0, #0x100000018',  // row 1: 0x100000004 -> row 6 (ret)
    'mov w1, w19',           // row 2: 0x100000008 (loop header with PHI on x1 + non-PHI mov w1, w19)
    'bl #0x100001000',       // row 3: 0x10000000c (strchr)
    'cbnz x0, #0x100000008', // row 4: 0x100000010 -> row 2 (backedge)
    'mov x0, #0',            // row 5: 0x100000014
    'ret',                   // row 6: 0x100000018
  ]);
  setSemanticMigrationMode(SEMANTIC_V2_MIGRATION_MODES.V2_COMPAT);
  let ir;
  try {
    ir = buildIR(model, {
      rowOfAddress,
      symbolFor: (addr) => (addr === 0x100001000n ? 'strchr' : null),
    });
  } finally {
    setSemanticMigrationMode(SEMANTIC_V2_MIGRATION_MODES.LEGACY);
  }

  const call = ir.instructions.find((i) => i.op === OP.CALL);
  assert.ok(call, 'expected strchr call instruction');
  const x1Arg = (call.args || []).map((a) => a?.value).find((v) => v?.reg === 'x1');
  assert.ok(x1Arg, 'expected x1 call argument');
  assert.notEqual(x1Arg.kind, VK.ARG, 'strchr x1 arg must not resolve to entry LIVE_IN x1');
  assert.notEqual(x1Arg.def?.op, OP.PHI, 'same-row non-PHI mov w1, w19 must beat block-header PHI');
});

test('Fix 3a: v2-to-v1 sets isTailCall and clears bogus external succ edge for tail-call branch', () => {
  const origin = (id, addr) => ({ instructionIds: [id], virtualRanges: [{ start: addr, end: addr + 4n }] });
  const bit64 = { kind: 'bitvector', widthBits: 64 };
  const x0Var = { key: 'reg:x0', kind: 'physical-state', scope: 'function', physicalIdentity: { kind: 'register', registerId: 'x0' } };
  const abiAdapter = semanticAbiAdapter(resolveABIPlugin('arm64', 'linux-elf'));

  const ir = {
    schemaVersion: 2,
    contractVersion: '2.0.0',
    functionId: 'fn_tailcall_v2',
    entryBlockId: 'b0',
    blocks: [
      { id: 'b0', nodeIds: ['n_c0', 'n_w0', 'n_br'], origin: origin('blk0', BASE) },
      { id: 'b_ext_empty', nodeIds: [], origin: origin('blk_ext', 0x100002000n) },
    ],
    values: [
      { id: 'v_c0', kind: 'definition', machineType: bit64, definitionNodeId: 'n_c0', sourceEntityId: 'n_c0', origin: origin('i0', BASE) },
    ],
    nodes: [
      { id: 'n_c0', kind: 'const', blockId: 'b0', inputs: [], outputs: ['v_c0'], attributes: { value: 64n }, completeness: 'complete', origin: origin('i0', BASE) },
      { id: 'n_w0', kind: 'state-write', blockId: 'b0', inputs: ['v_c0'], outputs: [], variable: x0Var, completeness: 'complete', origin: origin('i0', BASE) },
      {
        id: 'n_br',
        kind: 'branch',
        blockId: 'b0',
        inputs: [],
        outputs: [],
        targets: ['b_ext_empty'],
        attributes: {
          machineControlEffect: {
            kind: 'branch',
            target: 0x100002000n,
          },
        },
        completeness: 'complete',
        origin: origin('i1', BASE + 4n),
      },
    ],
    completeness: 'complete',
    unknowns: [],
    origin: origin('fn', BASE),
  };

  const projected = projectSemanticIrV2ToLegacyV1(ir, {
    abiAdapter,
    symbolFor: (addr) => (addr === 0x100002000n ? 'malloc' : null),
  });

  const br = projected.instructions.find((i) => i.op === OP.BR);
  assert.ok(br, 'expected OP.BR instruction');
  assert.equal(br.extra?.isTailCall, true, 'tail-call OP.BR must set extra.isTailCall = true');
  assert.equal(br.extra?.name, 'malloc', 'tail-call OP.BR must resolve symbol name via symbolFor');
  assert.deepEqual(projected.blocks[0].succ, [], 'external tail-call block must not retain bogus succ edge');
  assert.equal(projected.blocks[0].isExit, true, 'external tail-call block must be marked as exit');
});

test('Fix 3b: decompileSemantic forwards symbolFor and emits return callee(...) / callee(...); return; for tail calls', () => {
  const { model: mallocModel, rowOfAddress: mallocRow } = buildModel([
    'mov x0, #0x40',
    'b #0x100002000',
  ]);
  setSemanticMigrationMode(SEMANTIC_V2_MIGRATION_MODES.V2_COMPAT);
  let mallocOut;
  let freeOut;
  try {
    mallocOut = decompileSemantic(mallocModel, {
      rowOfAddress: mallocRow,
      symbolFor: (addr) => (addr === 0x100002000n ? 'malloc' : null),
    });

    const { model: freeModel, rowOfAddress: freeRow } = buildModel([
      'b #0x100002004',
    ]);
    freeOut = decompileSemantic(freeModel, {
      rowOfAddress: freeRow,
      symbolFor: (addr) => (addr === 0x100002004n ? 'free' : null),
    });
  } finally {
    setSemanticMigrationMode(SEMANTIC_V2_MIGRATION_MODES.LEGACY);
  }

  assert.ok(mallocOut && typeof mallocOut.pseudocode === 'string');
  assert.match(mallocOut.pseudocode, /return\s+malloc\(/, `expected return malloc(...), got:\n${mallocOut.pseudocode}`);
  assert.doesNotMatch(mallocOut.pseudocode, /goto\s+loc_/, `must not emit goto loop for tail call:\n${mallocOut.pseudocode}`);

  assert.ok(freeOut && typeof freeOut.pseudocode === 'string');
  assert.match(freeOut.pseudocode, /free\([^)]*\);\s*return;/, `expected free(...); return;, got:\n${freeOut.pseudocode}`);
  assert.doesNotMatch(freeOut.pseudocode, /goto\s+loc_/, `must not emit goto loop for void tail call:\n${freeOut.pseudocode}`);
});

test('Fix 4a: callRecord prefers explicit SSA inst.args/callArguments over ambiguous reachingRegisterValue', () => {
  // Block 0: mov x0, x20; cbr -> Block 1 (realloc) or Block 2 (override x0 -> Block 1)
  // Block 1: bl realloc(x0, x1) with explicit SSA arg x0 bound to v_ptr and x1 bound to v_size
  // Without Fix 4, Block 2's x0 def reaching Block 1 makes reachingRegisterValue return null -> realloc(unknown, ...).
  const arg0 = { id: 1, kind: VK.ARG, reg: 'x20', bits: 64, uses: [], def: null };
  const vPtr = { id: 2, kind: VK.DEF, reg: 'x0', bits: 64, uses: [], def: null };
  const vSize = { id: 3, kind: VK.CONST, reg: 'x1', bits: 64, const: 128n, uses: [], def: null };
  const vClobber = { id: 4, kind: VK.CONST, reg: 'x0', bits: 64, const: 999n, uses: [], def: null };
  const vRes = { id: 5, kind: VK.DEF, reg: 'x0', bits: 64, uses: [], def: null };

  const movPtr = { id: 10, op: OP.MOV, dst: vPtr, args: [{ value: arg0, bits: 64 }], block: 0, row: 0, address: BASE };
  vPtr.def = movPtr;
  arg0.uses.push(movPtr);

  const cbr = { id: 11, op: OP.CBR, dst: null, args: [{ value: arg0, bits: 64 }], block: 0, row: 1, address: BASE + 4n, extra: { cond: 'ne' } };
  arg0.uses.push(cbr);

  const movOther = { id: 12, op: OP.CONST, dst: vClobber, args: [], block: 2, row: 2, address: BASE + 8n };
  vClobber.def = movOther;
  const brToCall = { id: 13, op: OP.BR, dst: null, args: [], block: 2, row: 3, address: BASE + 12n };

  const callRealloc = {
    id: 14,
    op: OP.CALL,
    dst: vRes,
    args: [{ value: vPtr, bits: 64 }, { value: vSize, bits: 64 }],
    callArguments: [{ reg: 'x0', bits: 64 }, { reg: 'x1', bits: 64 }],
    extra: { name: 'realloc', target: 0x100003000n },
    block: 1,
    row: 4,
    address: BASE + 16n,
  };
  vRes.def = callRealloc;
  vPtr.uses.push(callRealloc);
  vSize.uses.push(callRealloc);

  const ret = { id: 15, op: OP.RET, dst: null, args: [{ value: vRes, bits: 64 }], block: 1, row: 5, address: BASE + 20n };
  vRes.uses.push(ret);

  const b0 = { index: 0, startRow: 0, endRow: 1, succ: [1, 2], pred: [], insts: [movPtr, cbr], phis: [], isEntry: true, isExit: false };
  const b1 = { index: 1, startRow: 4, endRow: 5, succ: [], pred: [0, 2], insts: [callRealloc, ret], phis: [], isEntry: false, isExit: true };
  const b2 = { index: 2, startRow: 2, endRow: 3, succ: [1], pred: [0], insts: [movOther, brToCall], phis: [], isEntry: false, isExit: false };

  const ir = {
    name: 'fn_realloc_explicit_args',
    entry: 0,
    blocks: [b0, b1, b2],
    instructions: [movPtr, cbr, movOther, brToCall, callRealloc, ret],
    values: [arg0, vPtr, vSize, vClobber, vRes],
    args: new Map([['x20', arg0]]),
    dominators: [new Set([0]), new Set([0, 1]), new Set([0, 2])],
    idom: [-1, 0, 0],
  };

  const out = decompileSemantic({ instructions: [], calls: [] }, { ir });
  assert.ok(out && typeof out.pseudocode === 'string');
  assert.match(out.pseudocode, /realloc\(/, `expected realloc call in:\n${out.pseudocode}`);
  assert.equal(out.pseudocode.includes('realloc(unknown'), false, `must not emit realloc(unknown, ...):\n${out.pseudocode}`);
});

test('Fix 4b: reachingRegisterValue resolves block-header phi when multiple defs merge', () => {
  const vA = { id: 1, kind: VK.CONST, reg: 'x0', bits: 64, const: 1n, uses: [], def: null };
  const vB = { id: 2, kind: VK.CONST, reg: 'x0', bits: 64, const: 2n, uses: [], def: null };
  const vPhi = { id: 3, kind: VK.PHI, reg: 'x0', bits: 64, uses: [], def: null };

  const defA = { id: 10, op: OP.CONST, dst: vA, args: [], block: 0, row: 0, address: BASE };
  vA.def = defA;
  const defB = { id: 11, op: OP.CONST, dst: vB, args: [], block: 1, row: 1, address: BASE + 4n };
  vB.def = defB;
  const phiInst = { id: 12, op: OP.PHI, dst: vPhi, args: [{ value: vA, block: 0 }, { value: vB, block: 1 }], block: 2, row: 2, address: BASE + 8n };
  vPhi.def = phiInst;
  const callInst = { id: 13, op: OP.CALL, dst: null, args: [], extra: { name: 'realloc' }, block: 2, row: 3, address: BASE + 12n };

  const b0 = { index: 0, startRow: 0, endRow: 0, succ: [1, 2], pred: [], insts: [defA], phis: [] };
  const b1 = { index: 1, startRow: 1, endRow: 1, succ: [2], pred: [0], insts: [defB], phis: [] };
  const b2 = { index: 2, startRow: 2, endRow: 3, succ: [], pred: [0, 1], insts: [callInst], phis: [phiInst] };

  // Note: vPhi is intentionally omitted from ir.values to verify block.phis lookup directly.
  const ir = {
    entry: 0,
    blocks: [b0, b1, b2],
    instructions: [defA, defB, callInst],
    values: [vA, vB],
    args: new Map(),
    dominators: [new Set([0]), new Set([0, 1]), new Set([0, 2])],
    idom: [-1, 0, 0],
  };

  const resolved = reachingRegisterValue(ir, callInst, 'x0');
  assert.equal(resolved, vPhi, 'reachingRegisterValue must resolve block-header phi when multiple defs merge');
});
