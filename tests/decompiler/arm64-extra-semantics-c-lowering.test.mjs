import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { lowerArm64RawAssembly } from '../../js/decompiler/arm64-extra-semantics.js';
import { evaluateArm64Bitfield } from '../../js/targets/architecture/arm64/effects/integer-core.js';

function lowerInFunction(bodyLines, { sig = 'uint64_t test_fn(uint64_t x0, uint64_t x1, uint64_t x2)' } = {}) {
  const result = lowerArm64RawAssembly({
    lines: [
      { kind: 'sig', indent: 0, text: sig },
      { kind: 'ctrl', indent: 0, text: '{' },
      ...bodyLines.map((text) => ({ kind: 'stmt', indent: 1, text })),
      { kind: 'stmt', indent: 1, text: 'return x0;' },
      { kind: 'ctrl', indent: 0, text: '}' },
    ],
  });
  return result;
}

function lowerOneStandardC(payload, extraPreLines = []) {
  const res = lowerInFunction([...extraPreLines, `__asm("${payload}");`]);
  const lowered = res.lines.find((l) => l.note === 'Exact ARM64 instruction semantics lowered from the raw fallback.');
  return { result: res, stmt: lowered?.text ?? null, text: res.pseudocode };
}

function gccAvailable() {
  const probe = spawnSync('gcc', ['--version'], { stdio: 'ignore' });
  return probe.status === 0;
}

function assertGccSyntaxOnly(source, label) {
  const run = spawnSync('gcc', ['-x', 'c', '-std=gnu11', '-fsyntax-only', '-Werror', '-Wno-unused-variable', '-Wno-unused-but-set-variable', '-Wno-unused-parameter', '-'], {
    input: source,
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, `${label}: gcc -fsyntax-only failed:\n${run.stderr}\n--- SOURCE ---\n${source}`);
}

test('standard-C lowering removes __a64_* function calls and passes gcc -x c -fsyntax-only', () => {
  const instructions = [
    // Bitfield insert / extract / move (64-bit & 32-bit, including edge widths)
    'ubfiz x0, x1, #0, #1',
    'ubfiz x0, x1, #4, #31',
    'ubfiz x0, x1, #32, #32',
    'ubfiz x0, x1, #0, #64',
    'ubfiz x0, x1, #1, #63',
    'sbfiz x0, x1, #0, #1',
    'sbfiz x0, x1, #4, #31',
    'sbfiz x0, x1, #32, #32',
    'sbfiz x0, x1, #0, #64',
    'sbfiz x0, x1, #1, #63',
    'ubfiz w0, w1, #0, #1',
    'ubfiz w0, w1, #4, #16',
    'ubfiz w0, w1, #0, #32',
    'sbfiz w0, w1, #0, #1',
    'sbfiz w0, w1, #4, #16',
    'sbfiz w0, w1, #0, #32',
    'ubfx x0, x1, #0, #1',
    'ubfx x0, x1, #4, #32',
    'ubfx x0, x1, #0, #64',
    'sbfx x0, x1, #0, #1',
    'sbfx x0, x1, #4, #32',
    'sbfx x0, x1, #32, #32',
    'sbfx x0, x1, #0, #64',
    'ubfx w0, w1, #4, #8',
    'sbfx w0, w1, #4, #8',
    'bfi x0, x1, #4, #8',
    'bfxil x0, x1, #8, #12',
    'bfm x0, x1, #4, #11',
    'bfm x0, x1, #60, #7',
    'bfm w0, w1, #4, #11',
    'bfm w0, w1, #28, #7',
    // Extract / rotate / bit & byte manipulation
    'extr x0, x1, x2, #0',
    'extr x0, x1, x2, #17',
    'extr w0, w1, w2, #5',
    'rbit x0, x1',
    'rbit w0, w1',
    'rev x0, x1',
    'rev w0, w1',
    'rev16 x0, x1',
    'rev16 w0, w1',
    'rev32 x0, x1',
    'clz x0, x1',
    'clz w0, w1',
    'cls x0, x1',
    'cls w0, w1',
    // Rounding & conditional selection
    'fcvtas x0, d0',
    'fcvtas w0, s0',
    'csel x0, x1, x2, eq',
    'csinc x0, x1, x2, ne',
    'csinv x0, x1, x2, lt',
    'csneg x0, x1, x2, ge',
    'cset x0, hi',
    'csetm w0, ls',
    'fccmp d0, d1, #0, le',
    'fcsel d0, d1, d2, gt',
    // Vector immediates & SIMD helpers
    'movi v0.2d, #0xff00ff00ff00ff00',
    'movi v0.16b, #0x41',
    'movi v0.8b, #0x7f',
    'movi v0.4h, #0x12, lsl #8',
    'movi v0.8h, #0x34',
    'movi v0.2s, #0x56, lsl #16',
    'movi v0.4s, #0x4',
    'bit v0.16b, v1.16b, v2.16b',
    'bit v0.8b, v1.8b, v2.8b',
    'ushll v0.8h, v1.8b, #3',
    'ushll2 v0.4s, v1.8h, #5',
    'uaddw v0.4s, v0.4s, v1.4h',
    'uaddw2 v0.2d, v0.2d, v1.4s',
    'addv s0, v1.4s',
    'addv b0, v1.8b',
    'addv h0, v1.4h',
  ];

  const body = [
    '/* cmp x1, x2 — 次の分岐のための比較 */',
    ...instructions.map((insn) => `__asm("${insn}");`),
  ];
  const res = lowerInFunction(body);
  const text = res.pseudocode;

  assert.doesNotMatch(text, /__asm\(/, `all listed instructions must lower:\n${text}`);
  assert.doesNotMatch(text, /__a64_[a-z0-9_]+\s*\(/, `no __a64_*() calls may remain in standard C output:\n${text}`);

  if (gccAvailable()) {
    assertGccSyntaxOnly(text, 'all-lowered-instructions');
  }
});

test('GCC runtime execution matches ARM64 bit-level specification across boundary values', (t) => {
  if (!gccAvailable()) {
    t.skip('gcc not available');
    return;
  }

  const cases = [];

  // 1. SBFIZ / UBFIZ 64-bit exhaustive boundary matrix against evaluateArm64Bitfield
  const u64Inputs = [
    0n, 1n, 2n, 0xfn, 0x7fffffffn, 0x80000000n, 0xffffffffn,
    0x7fffffffffffffffn, 0x8000000000000000n, 0xffffffffffffffffn,
    0xfffffffffffffff0n, 0x123456789abcdef0n, 0xdeadbeefcafebaben,
  ];
  for (const mn of ['ubfiz', 'sbfiz']) {
    const kind = mn === 'sbfiz' ? 'sbfm' : 'ubfm';
    const pairs = [
      [0, 1], [0, 31], [0, 32], [0, 63], [0, 64],
      [1, 1], [1, 63], [4, 1], [4, 31], [4, 32], [4, 60],
      [32, 1], [32, 31], [32, 32], [63, 1],
    ];
    for (const [lsb, width] of pairs) {
      const { stmt } = lowerOneStandardC(`${mn} x0, x1, #${lsb}, #${width}`);
      assert.ok(stmt && !stmt.includes('__a64_'), `expected standard C for ${mn} #${lsb}, #${width}: ${stmt}`);
      const immr = (-lsb) & 63;
      const imms = width - 1;
      for (const x1 of u64Inputs) {
        const expected = BigInt.asUintN(64, evaluateArm64Bitfield(kind, x1, 0n, 64, immr, imms));
        cases.push({ label: `${mn}64(${lsb},${width},0x${x1.toString(16)})`, stmt, x1, x2: 0n, expected, bits: 64 });
      }
    }
  }

  // 2. SBFX / UBFX 64-bit boundary matrix against evaluateArm64Bitfield
  for (const mn of ['ubfx', 'sbfx']) {
    const kind = mn === 'sbfx' ? 'sbfm' : 'ubfm';
    const pairs = [
      [0, 1], [0, 31], [0, 32], [0, 63], [0, 64],
      [4, 1], [4, 8], [4, 32], [32, 32], [63, 1],
    ];
    for (const [lsb, width] of pairs) {
      const { stmt } = lowerOneStandardC(`${mn} x0, x1, #${lsb}, #${width}`);
      assert.ok(stmt && !stmt.includes('__a64_'), `expected standard C for ${mn} #${lsb}, #${width}: ${stmt}`);
      const immr = lsb;
      const imms = lsb + width - 1;
      for (const x1 of u64Inputs) {
        const expected = BigInt.asUintN(64, evaluateArm64Bitfield(kind, x1, 0n, 64, immr, imms));
        cases.push({ label: `${mn}64(${lsb},${width},0x${x1.toString(16)})`, stmt, x1, x2: 0n, expected, bits: 64 });
      }
    }
  }

  // 3. 32-bit SBFIZ / UBFIZ / SBFX / UBFX against evaluateArm64Bitfield
  const u32Inputs = [0n, 1n, 0x7fn, 0x80n, 0x7fffffffn, 0x80000000n, 0xffffffffn, 0xdeadbeefn];
  for (const mn of ['ubfiz', 'sbfiz', 'ubfx', 'sbfx']) {
    const isInsert = mn.endsWith('iz');
    const kind = mn.startsWith('s') ? 'sbfm' : 'ubfm';
    const pairs = [[0, 1], [0, 31], [0, 32], [4, 8], [16, 16], [31, 1]];
    for (const [lsb, width] of pairs) {
      const { stmt } = lowerOneStandardC(`${mn} w0, w1, #${lsb}, #${width}`);
      assert.ok(stmt && !stmt.includes('__a64_'), `expected standard C for ${mn}32: ${stmt}`);
      const immr = isInsert ? ((-lsb) & 31) : lsb;
      const imms = isInsert ? (width - 1) : (lsb + width - 1);
      for (const w1 of u32Inputs) {
        const expected = BigInt.asUintN(32, evaluateArm64Bitfield(kind, w1, 0n, 32, immr, imms));
        cases.push({ label: `${mn}32(${lsb},${width},0x${w1.toString(16)})`, stmt, x1: w1, x2: 0n, expected, bits: 32 });
      }
    }
  }

  // 4. BFM / BFI / BFXIL 64-bit against evaluateArm64Bitfield
  for (const [immr, imms] of [[0, 0], [4, 11], [60, 7], [32, 31], [0, 63]]) {
    const { stmt } = lowerOneStandardC(`bfm x0, x1, #${immr}, #${imms}`);
    assert.ok(stmt, `expected lowering for bfm #${immr}, #${imms}`);
    for (const x1 of [0n, 0x123456789abcdef0n, 0xffffffffffffffffn]) {
      const x0Init = 0xa5a5a5a55a5a5a5an;
      const expected = BigInt.asUintN(64, evaluateArm64Bitfield('bfm', x1, x0Init, 64, immr, imms));
      cases.push({ label: `bfm64(${immr},${imms})`, stmt, x0Init, x1, x2: 0n, expected, bits: 64 });
    }
  }

  // 5. EXTR, RBIT, REV16, REV32, CLZ, CLS
  {
    const { stmt: extr0 } = lowerOneStandardC('extr x0, x1, x2, #0');
    cases.push({ label: 'extr64(0)', stmt: extr0, x1: 0x1122334455667788n, x2: 0x99aabbccddeeff00n, expected: 0x99aabbccddeeff00n, bits: 64 });
    const { stmt: extr16 } = lowerOneStandardC('extr x0, x1, x2, #16');
    cases.push({ label: 'extr64(16)', stmt: extr16, x1: 0x1122334455667788n, x2: 0x99aabbccddeeff00n, expected: 0x778899aabbccddeen, bits: 64 });

    const { stmt: rbit64 } = lowerOneStandardC('rbit x0, x1');
    cases.push({ label: 'rbit64(1)', stmt: rbit64, x1: 0x8000000000000001n, x2: 0n, expected: 0x8000000000000001n, bits: 64 });
    cases.push({ label: 'rbit64(0xf0)', stmt: rbit64, x1: 0x00000000000000f0n, x2: 0n, expected: 0x0f00000000000000n, bits: 64 });

    const { stmt: rev16 } = lowerOneStandardC('rev16 w0, w1');
    cases.push({ label: 'rev16_32', stmt: rev16, x1: 0x12345678n, x2: 0n, expected: 0x34127856n, bits: 32 });

    const { stmt: rev32 } = lowerOneStandardC('rev32 x0, x1');
    cases.push({ label: 'rev32_64', stmt: rev32, x1: 0x0102030405060708n, x2: 0n, expected: 0x0403020108070605n, bits: 64 });

    const { stmt: clz64 } = lowerOneStandardC('clz x0, x1');
    cases.push({ label: 'clz64(0)', stmt: clz64, x1: 0n, x2: 0n, expected: 64n, bits: 64 });
    cases.push({ label: 'clz64(1)', stmt: clz64, x1: 1n, x2: 0n, expected: 63n, bits: 64 });
    cases.push({ label: 'clz64(msb)', stmt: clz64, x1: 0x8000000000000000n, x2: 0n, expected: 0n, bits: 64 });

    const { stmt: cls32 } = lowerOneStandardC('cls w0, w1');
    cases.push({ label: 'cls32(0)', stmt: cls32, x1: 0n, x2: 0n, expected: 31n, bits: 32 });
    cases.push({ label: 'cls32(-1)', stmt: cls32, x1: 0xffffffffn, x2: 0n, expected: 31n, bits: 32 });
    cases.push({ label: 'cls32(0x80000000)', stmt: cls32, x1: 0x80000000n, x2: 0n, expected: 0n, bits: 32 });
    cases.push({ label: 'cls32(0xc0000000)', stmt: cls32, x1: 0xc0000000n, x2: 0n, expected: 1n, bits: 32 });
    cases.push({ label: 'cls32(0x1fffffff)', stmt: cls32, x1: 0x1fffffffn, x2: 0n, expected: 2n, bits: 32 });
  }

  // 6. CSEL / CSINC / CSINV / CSNEG / CSET / CSETM with preceding cmp context
  {
    const cmpLine = '/* cmp x1, x2 — 次の分岐のための比較 */';
    const { stmt: cselLt } = lowerOneStandardC('csel x0, x1, x2, lt', [cmpLine]);
    cases.push({ label: 'csel_lt_true', stmt: cselLt, x1: 0xffffffffffffffffn, x2: 1n, expected: 0xffffffffffffffffn, bits: 64 });
    cases.push({ label: 'csel_lt_false', stmt: cselLt, x1: 5n, x2: 1n, expected: 1n, bits: 64 });

    const { stmt: csincEq } = lowerOneStandardC('csinc x0, x1, x2, eq', [cmpLine]);
    cases.push({ label: 'csinc_eq_false', stmt: csincEq, x1: 10n, x2: 20n, expected: 21n, bits: 64 });

    const { stmt: csetGe } = lowerOneStandardC('cset x0, ge', [cmpLine]);
    cases.push({ label: 'cset_ge_true', stmt: csetGe, x1: 5n, x2: 5n, expected: 1n, bits: 64 });
    cases.push({ label: 'cset_ge_false', stmt: csetGe, x1: 0xffffffffffffffffn, x2: 0n, expected: 0n, bits: 64 });
  }

  // Build C harness, compile with gcc -O2 -Werror, execute, and check every case.
  const cLines = [
    '#include <stdint.h>',
    '#include <stdio.h>',
    'int main(void) {',
    '    int failures = 0;',
  ];
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    if (c.bits === 32) {
      cLines.push(
        `    { uint32_t w0 = 0x${(c.x0Init ?? 0n).toString(16)}U, w1 = 0x${c.x1.toString(16)}U, w2 = 0x${c.x2.toString(16)}U;`,
        `      ${c.stmt}`,
        `      if (w0 != 0x${c.expected.toString(16)}U) { fprintf(stderr, "FAIL %s: got 0x%x expected 0x%x\\n", ${JSON.stringify(c.label)}, w0, 0x${c.expected.toString(16)}U); failures++; } }`,
      );
    } else {
      cLines.push(
        `    { uint64_t x0 = 0x${(c.x0Init ?? 0n).toString(16)}ULL, x1 = 0x${c.x1.toString(16)}ULL, x2 = 0x${c.x2.toString(16)}ULL;`,
        `      ${c.stmt}`,
        `      if (x0 != 0x${c.expected.toString(16)}ULL) { fprintf(stderr, "FAIL %s: got 0x%llx expected 0x%llx\\n", ${JSON.stringify(c.label)}, (unsigned long long)x0, (unsigned long long)0x${c.expected.toString(16)}ULL); failures++; } }`,
      );
    }
  }

  // Also test MOVI, BIT, USHLL, UADDW, ADDV, and FCVTAS in the same compiled binary
  const { stmt: movi4s } = lowerOneStandardC('movi v0.4s, #0x4');
  const { stmt: movi2d } = lowerOneStandardC('movi v0.2d, #0xff00ff00ff00ff00');
  const { stmt: bit8b } = lowerOneStandardC('bit v0.8b, v1.8b, v2.8b');
  const { stmt: addv4s } = lowerOneStandardC('addv s0, v1.4s');
  const { stmt: fcvtas64 } = lowerOneStandardC('fcvtas x0, d0');
  cLines.push(
    `    { unsigned __int128 v0 = 0; ${movi4s}`,
    '      unsigned __int128 exp = (((unsigned __int128)0x0000000400000004ULL << 64) | 0x0000000400000004ULL);',
    '      if (v0 != exp) { fprintf(stderr, "FAIL movi.4s\\n"); failures++; } }',
    `    { unsigned __int128 v0 = 0; ${movi2d}`,
    '      unsigned __int128 exp = (((unsigned __int128)0xff00ff00ff00ff00ULL << 64) | 0xff00ff00ff00ff00ULL);',
    '      if (v0 != exp) { fprintf(stderr, "FAIL movi.2d\\n"); failures++; } }',
    `    { unsigned __int128 v0 = (((unsigned __int128)0xdeadbeefULL << 64) | 0x1122334455667788ULL);`,
    '      unsigned __int128 v1 = 0xaabbccddeeff0011ULL; unsigned __int128 v2 = 0x00ff00ff00ff00ffULL;',
    `      ${bit8b}`,
    '      if (v0 != (unsigned __int128)0x11bb33dd55ff7711ULL) { fprintf(stderr, "FAIL bit.8b\\n"); failures++; } }',
    `    { unsigned __int128 v0 = 0; unsigned __int128 v1 = (((unsigned __int128)0x0000000400000003ULL << 64) | 0x0000000200000001ULL);`,
    `      ${addv4s}`,
    '      if (v0 != (unsigned __int128)10U) { fprintf(stderr, "FAIL addv.4s\\n"); failures++; } }',
    `    { double d0 = 2.5; int64_t x0 = 0; ${fcvtas64} if (x0 != 3) { fprintf(stderr, "FAIL fcvtas +2.5\\n"); failures++; } }`,
    `    { double d0 = -2.5; int64_t x0 = 0; ${fcvtas64} if (x0 != -3) { fprintf(stderr, "FAIL fcvtas -2.5\\n"); failures++; } }`,
    '    return failures ? 1 : 0;',
    '}',
  );

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-a64-lowering-'));
  try {
    const srcPath = path.join(tmpDir, 'verify.c');
    const binPath = path.join(tmpDir, 'verify');
    fs.writeFileSync(srcPath, cLines.join('\n'), 'utf8');
    execFileSync('gcc', ['-std=gnu11', '-O2', '-Wall', '-Wextra', '-Werror', '-Wno-unused-variable', srcPath, '-o', binPath], { encoding: 'utf8' });
    execFileSync(binPath, [], { encoding: 'utf8' });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('invalid operand shapes stay fail-closed as raw __asm even in standard-C mode', () => {
  for (const bad of [
    'ubfiz x0, x1, #0, #0',
    'sbfiz x0, x1, #40, #32',
    'ubfiz w0, w1, #20, #16',
    'sbfx x0, x1, #60, #8',
    'extr x0, x1, x2, #64',
    'extr w0, w1, w2, #32',
    'bfm x0, x1, #64, #0',
    'fcsel d0, d1, d2, zz',
    'fcsel d0, d1, d2, al',
    'movi v0.2d, #0x1234',
    'rev32 w0, w1',
  ]) {
    const { stmt } = lowerOneStandardC(bad);
    assert.equal(stmt, null, `invalid instruction must stay raw: ${bad}`);
  }
});
