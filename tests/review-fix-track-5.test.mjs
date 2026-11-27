import assert from 'node:assert/strict';
import test from 'node:test';

import { OP, VK } from '../js/ir.js';
import { lowerArm64RawAssembly } from '../js/decompiler/arm64-extra-semantics.js';
import { renderValue } from '../js/decompiler/semantic-core.js';

function mkFn(bodyLines, { sig = 'uint64_t f(uint64_t x0, uint64_t x1, uint64_t x2, double d0, double d1, double d2)' } = {}) {
  return lowerArm64RawAssembly({
    lines: [
      { kind: 'sig', indent: 0, text: sig },
      { kind: 'ctrl', indent: 0, text: '{' },
      ...bodyLines.map((text) => ({ kind: 'stmt', indent: 1, text })),
      { kind: 'ctrl', indent: 0, text: '}' },
    ],
  }, { standardC: true });
}

function val(id, reg, bits = 64, kind = VK.DEF, extra = {}) {
  return { id, reg, bits, kind, uses: [], def: null, const: null, ...extra };
}

function arg(id, reg, bits = 64, extra = {}) {
  return val(id, reg, bits, VK.ARG, extra);
}

function av(v) {
  return { value: v };
}

function makeCtx(ir) {
  return {
    ir,
    model: { calls: [], addressRefs: [], instructions: [] },
    opts: {},
    types: { values: new Map(), locations: new Map() },
    exprCache: new Map(),
    exprActive: new Set(),
    exprNodes: 0,
    callCache: new Map(),
    callByRow: new Map(),
    materialNames: new Map(),
    phiVarNames: new Map(),
    unknownCallArities: 0,
    runtime: null,
  };
}

function makeIr(args, values, insts) {
  return {
    arch: 'arm64',
    args,
    values: [...args, ...values],
    instructions: insts,
    blocks: [{
      index: 0,
      startRow: 0,
      endRow: Math.max(0, insts.length - 1),
      succ: [],
      pred: [],
      phis: [],
      insts,
    }],
  };
}

// ============================================================================
// P1-S03-001: arm64-extra-semantics.js fail-closed on missing cmpCtx or
//             unsupported condition codes
// ============================================================================

test('P1-S03-001: conditional select instructions fail closed to raw __asm when cmpCtx is missing', () => {
  const insns = [
    'csel x0, x1, x2, eq',
    'csinc x0, x1, x2, ne',
    'csinv x0, x1, x2, lt',
    'csneg x0, x1, x2, ge',
    'cset x0, hi',
    'csetm x0, ls',
    'fcsel d0, d1, d2, gt',
  ];

  for (const insn of insns) {
    const res = mkFn([`__asm("${insn}");`]);
    const asmLine = res.lines.find((l) => l.text.includes(`__asm("${insn}")`));
    assert.ok(asmLine, `expected ${insn} without cmpCtx to remain raw __asm, got:\n${res.pseudocode}`);
    assert.doesNotMatch(res.pseudocode || '', /cond:/, `must not synthesize constant 0 /* cond:... */ for ${insn}`);
  }
});

test('P1-S03-001: conditional select instructions fail closed when cmpCtx is invalidated before use', () => {
  const scenarios = [
    { label: 'C call', pre: ['/* cmp x1, x2 */', 'helper(x1);'], insn: 'cset x0, eq' },
    { label: 'bl asm', pre: ['/* cmp x1, x2 */', '__asm("bl helper");'], insn: 'csel x0, x1, x2, ne' },
    { label: 'operand write', pre: ['/* cmp x1, x2 */', 'x1 = x1 + 1;'], insn: 'csinc x0, x1, x2, lt' },
    { label: 'flag-setting adds', pre: ['/* cmp x1, x2 */', '__asm("adds x3, x4, #1");'], insn: 'csneg x0, x1, x2, gt' },
    { label: 'unguarded fccmp', pre: ['__asm("fccmp d0, d1, #0, eq");'], insn: 'fcsel d0, d1, d2, gt' },
  ];

  for (const { label, pre, insn } of scenarios) {
    const res = mkFn([...pre, `__asm("${insn}");`]);
    const asmLine = res.lines.find((l) => l.text.includes(`__asm("${insn}")`));
    assert.ok(asmLine, `${label}: expected ${insn} to remain raw __asm, got:\n${res.pseudocode}`);
    assert.doesNotMatch(res.pseudocode || '', /cond:/, `${label}: must not emit constant 0 /* cond:... */`);
  }
});

test('P1-S03-001: unsupported condition codes for tst/cmn/cmp fail closed to raw __asm', () => {
  const unsupportedCases = [
    { cmp: '/* tst x1, x2 */', insn: 'csel x0, x1, x2, gt' },
    { cmp: '/* tst x1, x2 */', insn: 'cset x0, hi' },
    { cmp: '/* tst x1, x2 */', insn: 'fcsel d0, d1, d2, lt' },
    { cmp: '/* cmn x1, x2 */', insn: 'csinv x0, x1, x2, lt' },
    { cmp: '/* cmn x1, x2 */', insn: 'csetm x0, ge' },
    { cmp: '/* cmp x1, x2 */', insn: 'csel x0, x1, x2, vs' },
    { cmp: '/* cmp x1, x2 */', insn: 'cset x0, vc' },
  ];

  for (const { cmp, insn } of unsupportedCases) {
    const res = mkFn([cmp, `__asm("${insn}");`]);
    const asmLine = res.lines.find((l) => l.text.includes(`__asm("${insn}")`));
    assert.ok(asmLine, `${cmp} + ${insn}: expected fail-closed raw __asm, got:\n${res.pseudocode}`);
    assert.doesNotMatch(res.pseudocode || '', /cond:/, `${cmp} + ${insn}: must not emit constant 0 /* cond:... */`);
  }

  // Unsupported guard condition on fccmp invalidates lastCmp so subsequent fcsel fails closed
  const fccmpUnsupportedGuard = mkFn([
    '/* tst x1, x2 */',
    '__asm("fccmp d0, d1, #4, gt");',
    '__asm("fcsel d0, d1, d2, eq");',
  ]);
  const rawFcsel = fccmpUnsupportedGuard.lines.find((l) => l.text.includes('__asm("fcsel d0, d1, d2, eq")'));
  assert.ok(rawFcsel, `expected fcsel after unresolvable fccmp guard to stay raw __asm, got:\n${fccmpUnsupportedGuard.pseudocode}`);
  assert.doesNotMatch(fccmpUnsupportedGuard.pseudocode || '', /cond:/);
});

test('P1-S03-001: valid cmp/tst/cmn/fccmp conditions and al/nv still lower accurately', () => {
  const validCases = [
    { pre: ['/* cmp x1, x2 */'], insn: 'csel x0, x1, x2, eq', expect: /x0 = \(\(\(uint64_t\)\(x1\) == \(uint64_t\)\(x2\)\) \? \(uint64_t\)\(x1\) : \(uint64_t\)\(x2\)\);/ },
    { pre: ['/* tst x1, x2 */'], insn: 'cset x0, ne', expect: /x0 = \(\(\(\(uint64_t\)\(x1\) & \(uint64_t\)\(x2\)\) != 0\) \? 1ULL : 0ULL\);/ },
    { pre: ['/* cmn x1, x2 */'], insn: 'csinc x0, x1, x2, eq', expect: /x0 = \(\(\(\(uint64_t\)\(x1\) \+ \(uint64_t\)\(x2\)\) == 0\) \? \(uint64_t\)\(x1\) : \(\(uint64_t\)\(x2\) \+ 1ULL\)\);/ },
    { pre: ['/* cmp x1, x2 */', '__asm("fccmp d0, d1, #4, eq");'], insn: 'fcsel d0, d1, d2, eq', expect: /d0 = \(\(\(uint64_t\)\(x1\) == \(uint64_t\)\(x2\)\) \? \(d0 == d1\) : 1\) \? d1 : d2;/ },
    { pre: [], insn: 'csel x0, x1, x2, al', expect: /x0 = \(1 \? \(uint64_t\)\(x1\) : \(uint64_t\)\(x2\)\);/ },
  ];

  for (const { pre, insn, expect } of validCases) {
    const res = mkFn([...pre, `__asm("${insn}");`]);
    assert.match(res.pseudocode, expect, `expected ${insn} to lower properly, got:\n${res.pseudocode}`);
  }
});

// ============================================================================
// P1-S03-002: semantic-core.js OP.SEL rendering & selectAsMinMax sub handling
// ============================================================================

test('P1-S03-002: OP.SEL with inc/inv/neg/cinc/cinv/cneg preserves arithmetic/bitwise ops and does not fold to min/max', () => {
  const cases = [
    { sub: 'inc', cond: 'gt', expected: '((int64_t)a1 > (int64_t)a2 ? a1 : (a2 + 1))' },
    { sub: 'inv', cond: 'gt', expected: '((int64_t)a1 > (int64_t)a2 ? a1 : ~a2)' },
    { sub: 'neg', cond: 'gt', expected: '((int64_t)a1 > (int64_t)a2 ? a1 : -a2)' },
    { sub: 'cinc', cond: 'gt', expected: '((int64_t)a1 > (int64_t)a2 ? (a1 + 1) : a1)' },
    { sub: 'cinv', cond: 'gt', expected: '((int64_t)a1 > (int64_t)a2 ? ~a1 : a1)' },
    { sub: 'cneg', cond: 'gt', expected: '((int64_t)a1 > (int64_t)a2 ? -a1 : a1)' },
  ];

  for (const { sub, cond, expected } of cases) {
    const a1 = arg(1, 'x0', 64);
    const a2 = arg(2, 'x1', 64);
    const flags = val(3, 'nzcv', 4);
    const cmpI = { id: 10, op: OP.CMP, sub: 'sub', row: 0, block: 0, address: 0x1000n, bits: 64, dst: flags, args: [av(a1), av(a2)] };
    flags.def = cmpI;

    const selOut = val(4, 'x0', 64);
    const selI = { id: 11, op: OP.SEL, sub, cond, row: 1, block: 0, address: 0x1004n, bits: 64, dst: selOut, args: [av(a1), av(a2), av(flags)] };
    selOut.def = selI;

    const ir = makeIr([a1, a2], [flags, selOut], [cmpI, selI]);
    const ctx = makeCtx(ir);
    const rendered = renderValue(selOut, ctx);

    assert.equal(rendered, expected, `sub=${sub} must render with its modifier and not fold to min/max`);
    assert.doesNotMatch(rendered, /^(min|max)\(/, `sub=${sub} must never fold to min/max`);
  }
});

test('P1-S03-002: plain OP.SEL (sel/csel/fcsel/undefined) still folds to min/max when pattern matches', () => {
  for (const sub of ['sel', 'csel', 'fcsel', undefined]) {
    const a1 = arg(1, 'x0', 64);
    const a2 = arg(2, 'x1', 64);
    const flags = val(3, 'nzcv', 4);
    const cmpI = { id: 10, op: OP.CMP, sub: 'sub', row: 0, block: 0, address: 0x2000n, bits: 64, dst: flags, args: [av(a1), av(a2)] };
    flags.def = cmpI;

    const maxOut = val(4, 'x0', 64);
    const maxI = { id: 11, op: OP.SEL, ...(sub !== undefined ? { sub } : {}), cond: 'gt', row: 1, block: 0, address: 0x2004n, bits: 64, dst: maxOut, args: [av(a1), av(a2), av(flags)] };
    maxOut.def = maxI;

    const minOut = val(5, 'x0', 64);
    const minI = { id: 12, op: OP.SEL, ...(sub !== undefined ? { sub } : {}), cond: 'lt', row: 2, block: 0, address: 0x2008n, bits: 64, dst: minOut, args: [av(a1), av(a2), av(flags)] };
    minOut.def = minI;

    const ir = makeIr([a1, a2], [flags, maxOut, minOut], [cmpI, maxI, minI]);
    const ctx = makeCtx(ir);

    assert.equal(renderValue(maxOut, ctx), 'max(a1, a2)', `sub=${String(sub)} gt should fold to max`);
    assert.equal(renderValue(minOut, ctx), 'min(a1, a2)', `sub=${String(sub)} lt should fold to min`);
  }
});
