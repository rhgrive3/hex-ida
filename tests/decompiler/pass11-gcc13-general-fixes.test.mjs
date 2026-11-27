import test from 'node:test';
import assert from 'node:assert/strict';

import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';
import { inferSemanticTypes } from '../../js/decompiler/type-recovery.js';
import { OP, VK } from '../../js/ir.js';
import { closeFunctionOutput } from '../../js/decompiler/c-output-closure.js';
import { decompile as decompileLegacy, decompiledText } from '../../js/decompile-legacy.js';
import { buildSemanticModel } from '../../js/blocks.js';

function makeModel(lines, opts = {}) {
  const base = opts.addr ?? 0x1000n;
  const rows = lines.map((text, row) => {
    const trimmed = text.trim();
    const split = trimmed.indexOf(' ');
    return {
      row,
      address: base + BigInt(row * 4),
      mn: split < 0 ? trimmed : trimmed.slice(0, split),
      ops: split < 0 ? '' : trimmed.slice(split + 1).trim(),
    };
  });
  const rowOfAddress = (address) => rows.find((r) => r.address === BigInt(address))?.row ?? null;
  const symbols = opts.symbols || new Map();
  const symbolFor = (address) => symbols.get(BigInt(address)) ?? null;
  const model = buildSemanticModel(rows, {
    rowOfAddress,
    symbolFor,
    startRow: 0,
    endRow: rows.length - 1,
  });
  return {
    model,
    opts: {
      addr: base,
      name: opts.name || 'func0',
      symbolFor,
      rowOfAddress,
    },
  };
}

test('Pass 11: ARM64 scalar FP store (str d0, [x3]) reads 128-bit physical v0 and truncates to 64-bit', () => {
  const { model } = makeModel(['str d0, [x3]']);
  const insn = model.instructions[0];
  const bundle = liftArm64MachineEffects(insn, { instructionId: 'test_str_d0' });
  const v0Read = bundle.operations.find((op) => op.kind === 'register-read' && op.register?.registerId === 'v0');
  assert.ok(v0Read, 'expected register-read of physical v0');
  assert.equal(v0Read.register.widthBits, 128, 'str d0 must read 128-bit physical v0 to share SSA variant with ldr d0');
  const trunc = bundle.operations.find((op) => op.op === 'truncate' || op.metadata?.purpose === 'memory-store-register-view');
  assert.ok(trunc, 'expected truncate from 128-bit v0 to 64-bit d0 view');
});

test('Pass 11: type-recovery does not propagate float evidence through non-stack heap memory buckets', () => {
  const ptr = { id: 1, reg: 'x0', bits: 64, kind: VK.ARG, uses: [] };
  const fzero = { id: 2, reg: 'd0', bits: 64, kind: VK.DEF, float: 0.0, floatConst: 0.0, uses: [] };
  const heapLoad = { id: 3, reg: 'x1', bits: 64, kind: VK.DEF, uses: [] };
  const storeInst = {
    id: 10, op: OP.STORE, row: 0, block: 0, address: 0x1000n,
    args: [{ value: fzero }], loc: { kind: 'mem', base: ptr, offset: 0, size: 8 },
    extra: { float: true },
  };
  const loadInst = {
    id: 11, op: OP.LOAD, row: 1, block: 0, address: 0x1004n, dst: heapLoad,
    args: [{ value: ptr }], loc: { kind: 'mem', base: ptr, offset: 0, size: 8 },
  };
  heapLoad.def = loadInst;
  const retInst = { id: 12, op: OP.RET, row: 2, block: 0, address: 0x1008n, args: [{ value: heapLoad }] };
  ptr.uses.push(storeInst, loadInst);
  fzero.uses.push(storeInst);
  heapLoad.uses.push(retInst);
  const ir = {
    architectureId: 'arm64',
    args: new Map([['x0', ptr]]),
    values: [ptr, fzero, heapLoad],
    instructions: [storeInst, loadInst, retInst],
    blocks: [{ index: 0, startRow: 0, endRow: 2, succ: [], pred: [], phis: [], insts: [storeInst, loadInst, retInst] }],
    loops: [],
  };
  const recovered = inferSemanticTypes(ir, { instructions: [], calls: [], addressRefs: [] });
  const loadType = recovered.values.get(heapLoad.id);
  assert.notEqual(loadType?.kind, 'float', `heap GP load must not be poisoned to float/double, got ${JSON.stringify(loadType)}`);
});

test('Pass 11: c-output-closure reserves positive headroom above sp when sp is captured directly (x8 = sp;)', () => {
  const { model, opts } = makeModel([
    'str x1, [sp, #-16]',
    'mov x8, sp',
    'strb w0, [x8]',
    'ret',
  ], { name: 'test_sp' });
  const raw = decompileLegacy(model, opts);
  const closed = closeFunctionOutput(raw, opts);
  assert.match(closed.pseudocode, /__hex_stack_frame\[8192\]/, `expected headroom both below and above sp:\n${closed.pseudocode}`);
  assert.match(closed.pseudocode, /sp = \(uintptr_t\)\(__hex_stack_frame \+ 4096\)/, `expected sp positioned at +4096, got:\n${closed.pseudocode}`);
});

test('Pass 11: legacy decompiler handles ccmn chain without uninitialized flag_eq', () => {
  const { model, opts } = makeModel([
    'cmp w20, w22',
    'ccmn w22, #1, #4, ne',
    'ccmn w20, #1, #4, ne',
    'b.eq 0x1018',
    'mov w0, #1',
    'ret',
    'mov w0, #0',
    'ret',
  ], { name: 'test_ccmn' });
  const code = decompiledText(decompileLegacy(model, opts));
  assert.doesNotMatch(code, /\bflag_eq\b/, `ccmn chain should not fall back to uninitialized flag_eq:\n${code}`);
  assert.match(code, /\|\|/, `expected logical OR from ccmn #4 ne chain:\n${code}`);
});

test('Pass 11: legacy decompiler preserves pre-clobber fabs operand across fcmpe + movi d0, #0 + b.gt', () => {
  const { model, opts } = makeModel([
    'fabs d0, d3',
    'fcmpe d0, d7',
    'movi d0, #0',
    'b.gt 0x1014',
    'ret',
    'fmov d0, #1.0',
    'ret',
  ], { name: 'test_fcmpe_movi' });
  const code = decompiledText(decompileLegacy(model, opts));
  assert.match(code, /fabs\(a1\)\s*>\s*a2/, `expected pre-clobber fabs(v3) > v7 in branch condition:\n${code}`);
});
