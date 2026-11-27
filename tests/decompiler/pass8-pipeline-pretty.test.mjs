import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { semanticAbiAdapter } from '../../js/analysis/semantic-function.js';
import { AAPCS64_ABI } from '../../js/targets/abi/index.js';
import { enhanceSemanticDecompilation, buildExpressionForTesting } from '../../js/decompiler/pipeline-core.js';
import { expr } from '../../js/decompiler/ast/nodes.js';
import { printExpression, exprIsPointerTyped } from '../../js/decompiler/pretty/c.js';

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

function assertGccSyntaxValid(cSource) {
  const dir = mkdtempSync(join(tmpdir(), 'hex-ida-pass8-'));
  const file = join(dir, 'check.c');
  try {
    writeFileSync(file, cSource, 'utf8');
    execFileSync('gcc', ['-fsyntax-only', '-std=c11', file], { stdio: 'pipe' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('Fix 1: exprIsPointerTyped detects pointer vars, casts, and pointer arithmetic while excluding ptr-ptr and scalars', () => {
  const ptrs = new Set(['a1', 'a2']);
  const a1 = expr.variable('a1', 64, false);
  const a2 = expr.variable('a2', 64, false);
  const call547 = expr.variable('call_547', 64, false);
  const one = expr.constant(1n, 64, false);
  const zero = expr.constant(0n, 64, false);

  assert.equal(exprIsPointerTyped(a1, ptrs), true);
  assert.equal(exprIsPointerTyped(call547, ptrs), false);
  assert.equal(exprIsPointerTyped(expr.binary('add', a2, one, 64, false), ptrs), true);
  assert.equal(exprIsPointerTyped(expr.binary('add', one, a2, 64, false), ptrs), true);
  assert.equal(
    exprIsPointerTyped(
      expr.binary('add', expr.binary('add', a2, one, 64, false), expr.binary('sub', call547, one, 64, false), 64, false),
      ptrs,
    ),
    true,
  );
  assert.equal(exprIsPointerTyped(expr.binary('sub', a1, one, 64, false), ptrs), true);
  assert.equal(exprIsPointerTyped(expr.binary('sub', a1, a2, 64, false), ptrs), false);
  assert.equal(exprIsPointerTyped(expr.binary('sub', zero, a1, 64, false), ptrs), false);
  assert.equal(exprIsPointerTyped(expr.binary('add', a1, a2, 64, false), ptrs), false);
  assert.equal(exprIsPointerTyped({ kind: 'cast', type: 'const char *', arg: call547 }, ptrs), true);
  assert.equal(exprIsPointerTyped({ kind: 'cast', type: 'uintptr_t', arg: a1 }, ptrs), false);
});

test('Fix 1: printExpression casts pointer-typed operands to (uintptr_t) on integer-only operators and keeps valid pointer arithmetic clean', () => {
  const opts = { pointerVarNames: new Set(['a1', 'a2']) };
  const a1 = expr.variable('a1', 64, false);
  const a2 = expr.variable('a2', 64, false);
  const call547 = expr.variable('call_547', 64, false);
  const mask = expr.variable('mask', 64, false);
  const one = expr.constant(1n, 64, false);
  const zero = expr.constant(0n, 64, false);
  const two = expr.constant(2n, 64, false);

  // Pass 7 regression patterns: ~((a2 + 1) + (call_547 - 1)), 0 - a1, mask - a1, a1 & mask
  const bitNotPtrArith = expr.unary(
    'not',
    expr.binary('add', expr.binary('add', a2, one, 64, false), expr.binary('sub', call547, one, 64, false), 64, false),
    64,
    false,
  );
  const bitNotText = printExpression(bitNotPtrArith, 0, opts);
  assert.equal(bitNotText, '~(uintptr_t)(a2 + 1 + call_547 - 1)');

  const negPtrText = printExpression(expr.unary('neg', a1, 64, false), 0, opts);
  assert.equal(negPtrText, '-(uintptr_t)(a1)');

  const zeroMinusPtrText = printExpression(expr.binary('sub', zero, a1, 64, false), 0, opts);
  assert.equal(zeroMinusPtrText, '0 - (uintptr_t)(a1)');

  const intMinusPtrText = printExpression(expr.binary('sub', mask, a1, 64, false), 0, opts);
  assert.equal(intMinusPtrText, 'mask - (uintptr_t)(a1)');

  const andText = printExpression(expr.binary('and', a1, mask, 64, false), 0, opts);
  assert.equal(andText, '(uintptr_t)(a1) & mask');

  const orText = printExpression(expr.binary('or', a1, mask, 64, false), 0, opts);
  assert.equal(orText, '(uintptr_t)(a1) | mask');

  const xorText = printExpression(expr.binary('xor', a1, mask, 64, false), 0, opts);
  assert.equal(xorText, '(uintptr_t)(a1) ^ mask');

  const shlText = printExpression(expr.binary('shl', a1, two, 64, false), 0, opts);
  const lshrText = printExpression(expr.binary('lshr', a1, two, 64, false), 0, opts);
  const mulText = printExpression(expr.binary('mul', a1, two, 64, false), 0, opts);
  const udivText = printExpression(expr.binary('udiv', a1, two, 64, false), 0, opts);
  const umodText = printExpression(expr.binary('umod', a1, two, 64, false), 0, opts);
  const ptrPlusPtrText = printExpression(expr.binary('add', a1, a2, 64, false), 0, opts);
  assert.equal(ptrPlusPtrText, '(uintptr_t)(a1) + (uintptr_t)(a2)');

  // Normal ptr + int, ptr - int, ptr - ptr, !ptr stay clean (no unnecessary casts)
  assert.equal(printExpression(expr.binary('add', a1, one, 64, false), 0, opts), 'a1 + 1');
  assert.equal(printExpression(expr.binary('sub', a1, one, 64, false), 0, opts), 'a1 - 1');
  assert.equal(printExpression(expr.binary('sub', a1, a2, 64, false), 0, opts), 'a1 - a2');
  assert.equal(printExpression(expr.unary('lnot', a1, 1, false), 0, opts), '!a1');

  // Verify every emitted expression compiles cleanly under gcc -fsyntax-only
  const cProgram = `
#include <stdint.h>
#include <stddef.h>

uint64_t check_exprs(const char *a1, const char *a2, uint64_t call_547, uint64_t mask) {
  uint64_t acc = 0;
  acc += (uint64_t)(${bitNotText});
  acc += (uint64_t)(${negPtrText});
  acc += (uint64_t)(${zeroMinusPtrText});
  acc += (uint64_t)(${intMinusPtrText});
  acc += (uint64_t)(${andText});
  acc += (uint64_t)(${orText});
  acc += (uint64_t)(${xorText});
  acc += (uint64_t)(${shlText});
  acc += (uint64_t)(${lshrText});
  acc += (uint64_t)(${mulText});
  acc += (uint64_t)(${udivText});
  acc += (uint64_t)(${umodText});
  acc += (uint64_t)(${ptrPlusPtrText});
  return acc;
}
`;
  assertGccSyntaxValid(cProgram);
});

test('Fix 1: enhanceSemanticDecompilation threads pointerVarNames from signature/types into return and store statements', () => {
  const a1 = arg(1, 'x0', 64);
  const a2 = arg(2, 'x1', 64);
  const c1 = val(3, 'imm', 64, 'def', { const: 1n });
  const callRes = val(547, 'x0', 64);
  const p1 = val(4, 'x8', 64);
  const p2 = val(5, 'x9', 64);
  const sum = val(6, 'x10', 64);
  const inv = val(7, 'x0', 64);

  const callI = { id: 10, op: 'call', row: 0, block: 0, address: 0x1000n, dst: callRes, args: [av(a1)], extra: { name: 'strlen' } };
  callRes.def = callI;
  const add1 = { id: 11, op: 'bin', sub: 'add', row: 1, block: 0, address: 0x1004n, dst: p1, args: [av(a2), av(c1)] };
  p1.def = add1;
  const sub1 = { id: 12, op: 'bin', sub: 'sub', row: 2, block: 0, address: 0x1008n, dst: p2, args: [av(callRes), av(c1)] };
  p2.def = sub1;
  const addSum = { id: 13, op: 'bin', sub: 'add', row: 3, block: 0, address: 0x100cn, dst: sum, args: [av(p1), av(p2)] };
  sum.def = addSum;
  const notI = { id: 14, op: 'un', sub: 'not', row: 4, block: 0, address: 0x1010n, dst: inv, args: [av(sum)] };
  inv.def = notI;
  const retI = { id: 15, op: 'ret', row: 5, block: 0, address: 0x1014n, dst: null, args: [av(inv)] };

  const enhanced = makeSingleBlockEnhance({
    args: [a1, a2],
    values: [c1, callRes, p1, p2, sum, inv],
    insts: [callI, add1, sub1, addSum, notI, retI],
    types: {
      values: new Map(),
      locations: new Map(),
      args: [
        { reg: 'x0', index: 0, valueId: a1.id, type: 'const char *', semanticType: { kind: 'pointer', name: 'const char *' } },
        { reg: 'x1', index: 1, valueId: a2.id, type: 'const char *', semanticType: { kind: 'pointer', name: 'const char *' } },
      ],
    },
    lines: [
      { kind: 'sig', indent: 0, text: 'uint64_t func_874(const char *a1, const char *a2)', row: 0, addr: 0x1000n },
      { kind: 'ctrl', indent: 0, text: '{' },
      { kind: 'stmt', indent: 1, text: 'return ~((a2 + 1) + (call_547 - 1));', row: 5, addr: 0x1014n },
      { kind: 'ctrl', indent: 0, text: '}' },
    ],
  });

  assert.ok(
    enhanced.pseudocode.includes('return ~(uintptr_t)(a2 + 1 + call_547 - 1);'),
    `Expected cast return expression, got:\n${enhanced.pseudocode}`,
  );
  assertGccSyntaxValid(`
#include <stdint.h>
uint64_t func_874(const char *a1, const char *a2) {
  uint64_t call_547 = 0;
  (void)a1;
  return ~(uintptr_t)((a2 + 1) + (call_547 - 1));
}
`);
});

test('Fix 2: folded const with extra.addressDerived resolves .rodata strings (including "", "NO", "YES", "No", "Yes") and .bss globals across const, mov/cast, PHI, select, and return', () => {
  const rodataBytes = Uint8Array.from([
    0x00,                               // "" at 0x20000
    0x4e, 0x4f, 0x00,                   // "NO" at 0x20001
    0x59, 0x45, 0x53, 0x00,             // "YES" at 0x20004
    0x4e, 0x6f, 0x00,                   // "No" at 0x20008
    0x59, 0x65, 0x73, 0x00,             // "Yes" at 0x2000b
  ]);
  const rodataSec = { name: '.rodata', addr: 0x20000n, size: BigInt(rodataBytes.length), bytes: rodataBytes, perm: 'r--' };
  const bssSec = { name: '.bss', addr: 0x20040n, size: 0x80n, bytes: new Uint8Array(0x80), perm: 'rw-' };

  // 2a. Direct folded const with extra.addressDerived === true
  for (const [addr, expected] of [
    [0x20000n, '""'],
    [0x20001n, '"NO"'],
    [0x20004n, '"YES"'],
    [0x20008n, '"No"'],
    [0x2000bn, '"Yes"'],
    [0x20048n, '&global_20048'],
  ]) {
    const v = val(1, 'x0', 64, 'def', { const: addr });
    const cI = { id: 10, op: 'const', row: 0, block: 0, address: 0x1000n, dst: v, args: [], extra: { value: addr, addressDerived: true } };
    v.def = cI;
    const st = makeState(
      { values: [v], instructions: [cI], args: new Map(), blocks: [] },
      { opts: { sections: [rodataSec, bssSec] } },
    );
    assert.equal(printExpression(buildExpressionForTesting(v, st)), expected);
  }

  // 2b. Select (csel) with folded addressDerived arms (YES vs NO, and empty string "" vs Yes)
  {
    const a1 = arg(1, 'x0', 64);
    const zero = val(2, 'imm', 64, 'def', { const: 0n });
    const flags = val(3, 'nzcv', 32);
    const yesV = val(4, 'x8', 64, 'def', { const: 0x20004n });
    const noV = val(5, 'x9', 64, 'def', { const: 0x20001n });
    const selV = val(6, 'x0', 64);

    const cmpI = { id: 20, op: 'cmp', sub: 'sub', row: 0, block: 0, address: 0x1100n, dst: flags, args: [av(a1), av(zero)] };
    flags.def = cmpI;
    const yesI = { id: 21, op: 'const', row: 1, block: 0, address: 0x1104n, dst: yesV, args: [], extra: { value: 0x20004n, addressDerived: true } };
    yesV.def = yesI;
    const noI = { id: 22, op: 'const', row: 2, block: 0, address: 0x1108n, dst: noV, args: [], extra: { value: 0x20001n, addressDerived: true } };
    noV.def = noI;
    const selI = { id: 23, op: 'sel', sub: 'sel', cond: 'ne', row: 3, block: 0, address: 0x110cn, dst: selV, args: [av(yesV), av(noV), av(flags)] };
    selV.def = selI;
    const retI = { id: 24, op: 'ret', row: 4, block: 0, address: 0x1110n, dst: null, args: [av(selV)] };

    const enhanced = makeSingleBlockEnhance({
      args: [a1],
      values: [zero, flags, yesV, noV, selV],
      insts: [cmpI, yesI, noI, selI, retI],
      opts: { sections: [rodataSec, bssSec] },
      lines: [
        { kind: 'sig', indent: 0, text: 'const char *func_yesno(int32_t a1)', row: 0, addr: 0x1100n },
        { kind: 'ctrl', indent: 0, text: '{' },
        { kind: 'stmt', indent: 1, text: 'return 0;', row: 4, addr: 0x1110n },
        { kind: 'ctrl', indent: 0, text: '}' },
      ],
    });
    assert.ok(
      enhanced.pseudocode.includes('? "YES" : "NO"'),
      `Expected resolved select return, got:\n${enhanced.pseudocode}`,
    );
  }

  // 2c. PHI collapsing folded addressDerived constant via mov/cast chain
  {
    const rawC = val(1, 'x8', 64, 'def', { const: 0x20048n });
    const moved = val(2, 'x9', 64, 'def', { const: 0x20048n });
    const phiV = val(3, 'x0', 64);

    const cI = { id: 30, op: 'const', row: 0, block: 0, address: 0x1200n, dst: rawC, args: [], extra: { value: 0x20048n, addressDerived: true } };
    rawC.def = cI;
    const movI = { id: 31, op: 'mov', row: 1, block: 0, address: 0x1204n, dst: moved, args: [av(rawC)] };
    moved.def = movI;
    const phiI = { id: 32, op: 'phi', row: 2, block: 0, address: 0x1208n, dst: phiV, incoming: [{ block: 0, value: moved }], args: [av(moved)] };
    phiV.def = phiI;

    const st = makeState(
      { values: [rawC, moved, phiV], instructions: [cI, movI, phiI], args: new Map(), blocks: [] },
      { opts: { sections: [rodataSec, bssSec] } },
    );
    assert.equal(printExpression(buildExpressionForTesting(phiV, st)), '&global_20048');
  }
});

test('Fix 2: folded const without addressDerived tag resolves via model.addressRefs (row match through mov/cast and function-wide data-section match), while plain numeric constants stay numeric', () => {
  const rodataBytes = Uint8Array.from([
    0x4e, 0x6f, 0x00, // "No" at 0x20010
    0x00,             // "" at 0x20013
  ]);
  const rodataSec = { name: '.rodata', addr: 0x20010n, size: BigInt(rodataBytes.length), bytes: rodataBytes, perm: 'r--' };
  const dataSec = { name: '.data', addr: 0x20080n, size: 0x40n, bytes: new Uint8Array(0x40), perm: 'rw-' };

  // (a) Exact row+addr match through a mov chain
  {
    const baseC = val(1, 'x8', 64, 'def', { const: 0x20010n });
    const moved = val(2, 'x0', 64, 'def', { const: 0x20010n });
    const cI = { id: 40, op: 'const', row: 3, block: 0, address: 0x1300n, dst: baseC, args: [], extra: { value: 0x20010n } };
    baseC.def = cI;
    const movI = { id: 41, op: 'mov', row: 4, block: 0, address: 0x1304n, dst: moved, args: [av(baseC)] };
    moved.def = movI;

    const st = makeState(
      { values: [baseC, moved], instructions: [cI, movI], args: new Map(), blocks: [] },
      {
        model: { calls: [], addressRefs: [{ row: 3, addr: 0x20010n }] },
        opts: { sections: [rodataSec, dataSec] },
      },
    );
    assert.equal(printExpression(buildExpressionForTesting(moved, st)), '"No"');
  }

  // (b) Folded const whose row differs from adrp row, matching .data addressRef -> &global_20088
  {
    const folded = val(1, 'x0', 64, 'def', { const: 0x20088n });
    const cI = { id: 42, op: 'const', row: 9, block: 0, address: 0x1310n, dst: folded, args: [], extra: { value: 0x20088n } };
    folded.def = cI;

    const st = makeState(
      { values: [folded], instructions: [cI], args: new Map(), blocks: [] },
      {
        model: { calls: [], addressRefs: [{ row: 2, addr: 0x20088n }] },
        opts: { sections: [rodataSec, dataSec] },
      },
    );
    assert.equal(printExpression(buildExpressionForTesting(folded, st)), '&global_20088');
  }

  // (c) Plain numeric constant NOT in addressRefs and NOT addressDerived stays numeric
  {
    const num = val(1, 'x0', 64, 'def', { const: 0x20010n });
    const cI = { id: 43, op: 'const', row: 5, block: 0, address: 0x1320n, dst: num, args: [], extra: { value: 0x20010n } };
    num.def = cI;

    const st = makeState(
      { values: [num], instructions: [cI], args: new Map(), blocks: [] },
      {
        model: { calls: [], addressRefs: [] },
        opts: { sections: [rodataSec, dataSec], stringFor: () => 'MUST_NOT_RESOLVE' },
      },
    );
    assert.equal(printExpression(buildExpressionForTesting(num, st)), '0x20010');
  }
});
