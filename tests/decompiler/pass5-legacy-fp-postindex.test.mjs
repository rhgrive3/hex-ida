import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { buildSemanticModel } from '../../js/blocks.js';
import { decompile as decompileLegacy, decompiledText } from '../../js/decompile-legacy.js';

function makeLegacyModel(lines, opts = {}) {
  const base = opts.addr ?? 0x760n;
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
      beginner: false,
      ...opts,
    },
  };
}

function checkGccSyntax(cCode, label, headers = [], extraPreamble = '') {
  const inc = headers.map((h) => `#include <${h}>`).join('\n');
  const wrapped = `${inc}\n#include <stdint.h>\n#define __asm(x) ((void)0)\ntypedef unsigned long long uint64;\ntypedef long long int64;\ntypedef unsigned int uint32;\ntypedef int int32;\ntypedef unsigned short uint16;\ntypedef short int16;\ntypedef unsigned char uint8;\ntypedef signed char int8;\ntypedef unsigned __int128 uint128;\n${extraPreamble}\n${cCode}\n`;
  try {
    execFileSync('gcc', ['-fsyntax-only', '-x', 'c', '-'], {
      input: wrapped,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    if (err.code === 'ENOENT') return;
    assert.fail(`GCC syntax check failed for ${label}:\n${err.stderr?.toString() || err.message}\n--- C ---\n${wrapped}`);
  }
}

test('1. fcmpe uses 2-operand indices and lowers b.mi/b.pl/b.gt against right operand (idx 658 pattern)', () => {
  const { model, opts } = makeLegacyModel([
    'cmp w1, #0x0',
    'b.le #0x7a8',
    'sub x4, x0, #0x4',
    'mov x3, #0x1',
    'cmp w1, w3',
    'b.le #0x7a8',
    'ldr s2, [x4, x3, lsl #2]',
    'mov x2, x3',
    'ldr s1, [x0, x2, lsl #2]',
    'add x2, x2, #0x1',
    'fabd s1, s2, s1',
    'fcmpe s1, s0',
    'b.mi #0x7b0',
    'cmp w1, w2',
    'b.gt #0x780',
    'add x3, x3, #0x1',
    'cmp w1, w3',
    'b.gt #0x778',
    'mov w0, #0x0',
    'ret',
    'mov w0, #0x1',
    'ret',
  ]);
  const res = decompileLegacy(model, opts);
  const code = decompiledText(res);
  assert.match(code, /if \(v1 < a3\) goto loc_7B0;/, `expected fcmpe s1, s0; b.mi -> v1 < a3:\n${code}`);
  assert.doesNotMatch(code, /if \(v0 < 0\)/, `must not compare ops[1] against 0:\n${code}`);
  assert.match(code, /v1 = fabsf\(\(v2\) - \(v1\)\);/, `expected fabd lowered to fabsf:\n${code}`);
  assert.doesNotMatch(code, /__asm\("fabd/, `fabd must not remain raw __asm:\n${code}`);
  assert.match(code, /float\s+[^;]*\bv1\b/, `expected scalar float local declaration for v1:\n${code}`);
  assert.match(code, /\*\(float \*\)\(/, `expected float* dereference for ldr sN:\n${code}`);
  checkGccSyntax(code, 'fcmpe_idx_658', ['math.h'], 'uint64 x2, x3, x4;');

  // Double-precision fcmpe with b.gt and b.pl
  {
    const { model: m2, opts: o2 } = makeLegacyModel([
      'fabs d1, d0',
      'fcmpe d1, d2',
      'b.pl #0x774',
      'mov w0, #1',
      'ret',
      'mov w0, #0',
      'ret',
    ]);
    const r2 = decompileLegacy(m2, o2);
    const c2 = decompiledText(r2);
    assert.match(c2, /v1 = fabs\(a1\);/, `expected double fabs:\n${c2}`);
    assert.match(c2, /if \(v1 >= a2\) goto loc_774;/, `expected fcmpe b.pl -> v1 >= a2:\n${c2}`);
    assert.match(c2, /double\s+[^;]*\bv1\b/, `expected double local declaration for v1:\n${c2}`);
  }
});

test('2. post-index ldr/str writeback updates base after access without inlining past writeback (idx 674 & 742 patterns)', () => {
  // idx 674: two post-index ldr loops (x1 and x0/a1) + fabd + fdiv before ret
  {
    const { model, opts } = makeLegacyModel([
      'scvtf s3, w1',
      'cmp w1, #0x0',
      'b.le #0x7ac',
      'movi v1.2s, #0x0',
      'add x2, x0, w1, sxtw #2',
      'mov x1, x0',
      'ldr s2, [x1], #4',
      'fadd s1, s1, s2',
      'cmp x2, x1',
      'b.ne #0x778',
      'fdiv s2, s1, s3',
      'movi v0.2s, #0x0',
      'ldr s1, [x0], #4',
      'fabd s1, s1, s2',
      'fadd s0, s0, s1',
      'cmp x2, x0',
      'b.ne #0x790',
      'fdiv s0, s0, s3',
      'ret',
      'movi v0.2s, #0x0',
      'fdiv s0, s0, s3',
      'ret',
    ]);
    const res = decompileLegacy(model, opts);
    const code = decompiledText(res);
    assert.match(code, /v2 = \*\(float \*\)\(x1\);\s*\n\s*x1 = x1 \+ 4;\s*\n\s*v1 = v1 \+ v2;/,
      `expected post-index ldr writeback after load and before fadd using v2:\n${code}`);
    assert.match(code, /v1 = \*\(float \*\)\(a1\);\s*\n\s*a1 = a1 \+ 4;\s*\n\s*v1 = fabsf\(\(v1\) - \(v2\)\);/,
      `expected post-index ldr writeback on a1 followed by fabsf:\n${code}`);
    assert.match(code, /if \(x2 != a1\) goto loc_790;/, `expected loop condition against updated a1:\n${code}`);
    assert.match(code, /v0 = v0 \/ v3;\s*\n\s*return \(float\)v0;/, `expected fdiv before ret preserved:\n${code}`);
    assert.equal(res.types.ret.type, 'float', `expected float return type for idx 674:\n${code}`);
    checkGccSyntax(code, 'postindex_idx_674', ['math.h'], 'uint64 x1, x2;');
  }

  // idx 742: post-index str s0, [x0], #4 in loop + fcmpe b.mi / b.gt
  {
    const { model, opts } = makeLegacyModel([
      'ldr s1, [x0]',
      'cmp w1, #0x1',
      'b.le #0x7cc',
      'fmov s2, s1',
      'mov x2, #0x1',
      'nop',
      'ldr s0, [x0, x2, lsl #2]',
      'fcmpe s0, s1',
      'b.mi #0x7c4',
      'fcmpe s0, s2',
      'b.gt #0x7bc',
      'add x2, x2, #0x1',
      'cmp w1, w2',
      'b.gt #0x778',
      'fsub s2, s2, s1',
      'add x1, x0, w1, sxtw #2',
      'ldr s0, [x0]',
      'fsub s0, s0, s1',
      'fdiv s0, s0, s2',
      'str s0, [x0], #4',
      'cmp x1, x0',
      'b.ne #0x7a0',
      'ret',
      'fmov s2, s0',
      'b #0x78c',
      'fmov s1, s0',
      'b #0x784',
      'b.ne #0x7b8',
      'fmov s2, s1',
      'b #0x798',
    ]);
    const res = decompileLegacy(model, opts);
    const code = decompiledText(res);
    assert.match(code, /if \(v0 < v1\) goto loc_7C4;/, `expected fcmpe s0, s1; b.mi -> v0 < v1:\n${code}`);
    assert.match(code, /if \(v0 > v2\) goto loc_7BC;/, `expected fcmpe s0, s2; b.gt -> v0 > v2:\n${code}`);
    assert.match(code, /\*\(float \*\)\(a1\) = v0;\s*\n\s*a1 = a1 \+ 4;/,
      `expected post-index str writeback a1 = a1 + 4 after store:\n${code}`);
    assert.match(code, /if \(x1 != a1\) goto loc_7A0;/, `expected loop exit check against a1:\n${code}`);
  }
});

test('3. pre-index ldr/str writeback updates base before access without double-adding disp, and sp writeback stays suppressed', () => {
  // Pre-index positive & negative offsets on non-sp base
  {
    const { model, opts } = makeLegacyModel([
      'ldr x2, [x1, #8]!',
      'str x2, [x3, #-8]!',
      'mov x0, x2',
      'ret',
    ]);
    const res = decompileLegacy(model, opts);
    const code = decompiledText(res);
    assert.match(code, /a2 = a2 \+ 8;\s*\n\s*x2 = \*\(uint64 \*\)\(a2\);/,
      `expected pre-index ldr to update a2 before load without double-adding 8:\n${code}`);
    assert.match(code, /a4 = a4 - 8;\s*\n\s*\*\(uint64 \*\)\(a4\) = x2;/,
      `expected pre-index str to decrement a4 before store without double-subtracting 8:\n${code}`);
    assert.doesNotMatch(code, /\+ 8\)\s*;/, `must not double-add pre-index displacement:\n${code}`);
  }

  // Prologue/epilogue sp writeback must NOT emit sp = sp +/- N
  {
    const { model, opts } = makeLegacyModel([
      'stp x29, x30, [sp, #-0x10]!',
      'mov x29, sp',
      'add x0, x0, #1',
      'ldp x29, x30, [sp], #0x10',
      'ret',
    ]);
    const res = decompileLegacy(model, opts);
    const code = decompiledText(res);
    assert.doesNotMatch(code, /\bsp\s*=\s*sp\b/, `sp frame writeback must not be emitted:\n${code}`);
  }
});

test('4. fsub/fadd/fmul/fdiv before ret is preserved and updates return value (idx 666 pattern)', () => {
  const { model, opts } = makeLegacyModel([
    'fcvtzs s1, s0',
    'scvtf s1, s1',
    'fsub s0, s0, s1',
    'ret',
  ]);
  const res = decompileLegacy(model, opts);
  const code = decompiledText(res);
  assert.equal(res.signature, 'float func0(float a1)', `unexpected signature:\n${code}`);
  assert.match(code, /float\s+v1;/, `expected float local declaration for v1:\n${code}`);
  assert.match(code, /a1 = a1 - v1;\s*\n\s*return \(float\)a1;/,
    `expected fsub to update a1 before returning (float)a1:\n${code}`);
  checkGccSyntax(code, 'fsub_ret_idx_666');

  // Verify double fadd before ret
  {
    const { model: m2, opts: o2 } = makeLegacyModel([
      'fadd d0, d0, d1',
      'ret',
    ]);
    const r2 = decompileLegacy(m2, o2);
    const c2 = decompiledText(r2);
    assert.equal(r2.signature, 'double func0(double a1, double a2)');
    assert.match(c2, /a1 = a1 \+ a2;\s*\n\s*return \(double\)a1;/, `expected fadd before ret:\n${c2}`);
    checkGccSyntax(c2, 'fadd_ret_double');
  }

  // Vector fabd must not be mis-lowered to scalar fabsf
  {
    const { model: m3, opts: o3 } = makeLegacyModel([
      'fabd v0.4s, v1.4s, v2.4s',
      'ret',
    ]);
    const r3 = decompileLegacy(m3, o3);
    const c3 = decompiledText(r3);
    assert.doesNotMatch(c3, /\bfabsf?\(/, `vector fabd must not lower to scalar fabsf/fabs:\n${c3}`);
  }
});
