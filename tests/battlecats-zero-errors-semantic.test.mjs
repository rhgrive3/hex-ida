import test from 'node:test';
import assert from 'node:assert/strict';

import { MK, VK } from '../js/ir.js';
import { renderMemoryLocation } from '../js/decompiler/semantic-core.js';

const TWO_POW_64 = 1n << 64n; // 18446744073709551616n
const TWO_POW_63 = 1n << 63n; // 9223372036854775808n
const NEG_TWO_POW_63 = -TWO_POW_63; // -9223372036854775808n

function makeCtx() {
  return {
    ir: { instructions: [], blocks: [], values: [] },
    _hasEscapedStackFrame: true,
    opts: {},
    types: { values: new Map() },
    materialNames: new Map(),
    exprCache: new Map(),
    exprActive: new Set(),
    exprNodes: 0,
  };
}

function makeArgVal(id, reg, name) {
  return { id, kind: VK.ARG, reg, name, uses: [] };
}

test('MK.STACK (frameEpoch 0, sp base) normalizes 64-bit signed displacements and formats -2^63 with ULL', () => {
  const ctx = makeCtx();
  const cases = [
    [TWO_POW_64, '*(uint64_t *)(uintptr_t)(sp)'],
    [TWO_POW_64 + 8n, '*(uint64_t *)(uintptr_t)(sp + 8)'],
    [TWO_POW_64 - 16n, '*(uint64_t *)(uintptr_t)(sp - 16)'],
    [NEG_TWO_POW_63, '*(uint64_t *)(uintptr_t)(sp - 9223372036854775808ULL)'],
    [TWO_POW_63, '*(uint64_t *)(uintptr_t)(sp - 9223372036854775808ULL)'],
    [0n, '*(uint64_t *)(uintptr_t)(sp)'],
  ];
  for (const [disp, expected] of cases) {
    const loc = { kind: MK.STACK, frameEpoch: 0, baseReg: 'sp', disp, size: 8 };
    const actual = renderMemoryLocation(loc, { size: 8 }, ctx);
    assert.equal(actual, expected, `MK.STACK epoch0 disp=${disp}`);
  }
});

test('MK.STACK (inst.addr.base branch) normalizes 64-bit signed displacements via addr.disp and loc.disp fallback', () => {
  const ctx = makeCtx();
  const baseVal = makeArgVal(1, 'x29', 'fp_val');
  ctx.materialNames.set(baseVal.id, 'fp_val');

  const cases = [
    [TWO_POW_64, '*(uint64_t *)(uintptr_t)(fp_val)'],
    [TWO_POW_64 + 8n, '*(uint64_t *)(uintptr_t)((fp_val) + 8)'],
    [TWO_POW_64 - 16n, '*(uint64_t *)(uintptr_t)((fp_val) - 16)'],
    [NEG_TWO_POW_63, '*(uint64_t *)(uintptr_t)((fp_val) - 9223372036854775808ULL)'],
    [TWO_POW_63, '*(uint64_t *)(uintptr_t)((fp_val) - 9223372036854775808ULL)'],
    [0n, '*(uint64_t *)(uintptr_t)(fp_val)'],
  ];

  for (const [disp, expected] of cases) {
    const locFromAddr = { kind: MK.STACK, frameEpoch: 1, baseReg: 'x29', disp: 0n, size: 8 };
    const instFromAddr = { size: 8, addr: { base: baseVal, disp, size: 8 } };
    assert.equal(
      renderMemoryLocation(locFromAddr, instFromAddr, ctx),
      expected,
      `MK.STACK addr.base addr.disp=${disp}`,
    );

    const locFallback = { kind: MK.STACK, frameEpoch: 1, baseReg: 'x29', disp, size: 8 };
    const instFallback = { size: 8, addr: { base: baseVal, disp: null, size: 8 } };
    assert.equal(
      renderMemoryLocation(locFallback, instFallback, ctx),
      expected,
      `MK.STACK addr.base loc.disp fallback=${disp}`,
    );
  }
});

test('MK.STACK (non-zero frameEpoch sp fallback branch) normalizes 64-bit signed displacements', () => {
  const ctx = makeCtx();
  const cases = [
    [TWO_POW_64, '*(uint64_t *)(uintptr_t)(sp)'],
    [TWO_POW_64 + 8n, '*(uint64_t *)(uintptr_t)(sp + 8)'],
    [TWO_POW_64 - 16n, '*(uint64_t *)(uintptr_t)(sp - 16)'],
    [NEG_TWO_POW_63, '*(uint64_t *)(uintptr_t)(sp - 9223372036854775808ULL)'],
    [TWO_POW_63, '*(uint64_t *)(uintptr_t)(sp - 9223372036854775808ULL)'],
    [0n, '*(uint64_t *)(uintptr_t)(sp)'],
  ];
  for (const [disp, expected] of cases) {
    const loc = { kind: MK.STACK, frameEpoch: 1, baseReg: 'x29', disp, size: 8 };
    const actual = renderMemoryLocation(loc, { size: 8 }, ctx);
    assert.equal(actual, expected, `MK.STACK fallback disp=${disp}`);
  }
});

test('MK.UNKNOWN (indexed branch) normalizes 64-bit signed displacements and formats -2^63 with ULL', () => {
  const ctx = makeCtx();
  const baseVal = makeArgVal(1, 'x0', 'a1');
  const idxVal = makeArgVal(2, 'x1', 'a2');
  ctx.materialNames.set(baseVal.id, 'a1');
  ctx.materialNames.set(idxVal.id, 'a2');

  const cases = [
    [TWO_POW_64, '((uint64_t *)(uintptr_t)(a1))[a2]'],
    [TWO_POW_64 + 8n, '*(uint64_t *)((uintptr_t)(a1) + (a2) * 8 + 8)'],
    [TWO_POW_64 - 16n, '*(uint64_t *)((uintptr_t)(a1) + (a2) * 8 - 16)'],
    [NEG_TWO_POW_63, '*(uint64_t *)((uintptr_t)(a1) + (a2) * 8 - 9223372036854775808ULL)'],
    [TWO_POW_63, '*(uint64_t *)((uintptr_t)(a1) + (a2) * 8 - 9223372036854775808ULL)'],
    [0n, '((uint64_t *)(uintptr_t)(a1))[a2]'],
  ];
  for (const [disp, expected] of cases) {
    const loc = { kind: MK.UNKNOWN, size: 8 };
    const inst = { size: 8, addr: { base: baseVal, index: idxVal, scale: 3, size: 8, disp } };
    assert.equal(
      renderMemoryLocation(loc, inst, ctx),
      expected,
      `MK.UNKNOWN indexed disp=${disp}`,
    );
  }
});

test('MK.UNKNOWN (base+disp branch) normalizes 64-bit signed displacements and formats -2^63 with ULL', () => {
  const ctx = makeCtx();
  const baseVal = makeArgVal(1, 'x0', 'a1');
  ctx.materialNames.set(baseVal.id, 'a1');

  const cases = [
    [TWO_POW_64, '*(uint64_t *)(uintptr_t)(a1)'],
    [TWO_POW_64 + 8n, '*(uint64_t *)((uintptr_t)(a1) + 8)'],
    [TWO_POW_64 - 16n, '*(uint64_t *)((uintptr_t)(a1) - 16)'],
    [NEG_TWO_POW_63, '*(uint64_t *)((uintptr_t)(a1) - 9223372036854775808ULL)'],
    [TWO_POW_63, '*(uint64_t *)((uintptr_t)(a1) - 9223372036854775808ULL)'],
    [0n, '*(uint64_t *)(uintptr_t)(a1)'],
  ];
  for (const [disp, expected] of cases) {
    const loc = { kind: MK.UNKNOWN, size: 8 };
    const inst = { size: 8, addr: { base: baseVal, size: 8, disp } };
    assert.equal(
      renderMemoryLocation(loc, inst, ctx),
      expected,
      `MK.UNKNOWN base+disp disp=${disp}`,
    );
  }
});

test('MK.FIELD normalizes 64-bit signed displacements and formats -2^63 with ULL', () => {
  const ctx = makeCtx();
  const baseVal = makeArgVal(1, 'x0', 'a1');
  ctx.materialNames.set(baseVal.id, 'a1');

  const cases = [
    [TWO_POW_64, '*(uint32_t *)(uintptr_t)(a1)'],
    [TWO_POW_64 + 8n, '*(uint32_t *)((uintptr_t)(a1) + 8)'],
    [TWO_POW_64 - 16n, '*(uint32_t *)((uintptr_t)(a1) - 16)'],
    [NEG_TWO_POW_63, '*(uint32_t *)((uintptr_t)(a1) - 9223372036854775808ULL)'],
    [TWO_POW_63, '*(uint32_t *)((uintptr_t)(a1) - 9223372036854775808ULL)'],
    [0n, '*(uint32_t *)(uintptr_t)(a1)'],
  ];
  for (const [disp, expected] of cases) {
    const loc = { kind: MK.FIELD, base: baseVal, disp, size: 4 };
    const inst = { size: 4, addr: { base: baseVal, disp, size: 4 } };
    assert.equal(
      renderMemoryLocation(loc, inst, ctx),
      expected,
      `MK.FIELD disp=${disp}`,
    );
  }
});
