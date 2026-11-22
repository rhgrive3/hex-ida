import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { closeFunctionOutput } from '../../js/decompiler/c-output-closure.js';

function makeResult(lines) {
  return {
    lines,
    pseudocode: lines.map((l) => `${'    '.repeat(l.indent || 0)}${l.text}`).join('\n'),
  };
}

function compileAndRunAarch64(cSource, label = 'aarch64-test') {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-closure-test-'));
  const srcPath = path.join(tmpDir, 'test.c');
  const binPath = path.join(tmpDir, 'test.bin');
  try {
    fs.writeFileSync(srcPath, cSource, 'utf8');
    execFileSync('aarch64-linux-gnu-gcc', ['-O0', '-Wall', '-Wextra', '-o', binPath, srcPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const qemuArgs = fs.existsSync('/usr/aarch64-linux-gnu/lib')
      ? ['-L', '/usr/aarch64-linux-gnu', binPath]
      : [binPath];
    const stdout = execFileSync('qemu-aarch64', qemuArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    return stdout.trim();
  } catch (err) {
    const stderr = String(err.stderr || err.message || '');
    const stdout = String(err.stdout || '');
    assert.fail(`${label} failed:\n--- C source ---\n${cSource}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

test('Hex IR intrinsics, __arm64_nzcv_*, and glibc aliases emit guarded definitions, skip __HEX_ANY_ARGS, compile+link with aarch64-linux-gnu-gcc -O0, and run accurately under qemu-aarch64', () => {
  const sigSource = { addresses: [0x1000n], rows: [0] };
  const result = makeResult([
    { kind: 'sig', indent: 0, text: 'uint64 test_intrinsics(uint64 a1, uint64 a2)', row: 0, addr: 0x1000n, source: sigSource },
    { kind: 'ctrl', indent: 0, text: '{', row: 0, addr: 0x1000n, source: sigSource },
    { kind: 'stmt', indent: 1, text: 'int64 s = sext(0xFFFFFFFFULL);' },
    { kind: 'stmt', indent: 1, text: 'uint64 z = zext(0x123456789ABCDEF0ULL);' },
    { kind: 'stmt', indent: 1, text: 'uint64 be = bit_extract(0xABCD1234ULL, 8, 12);' },
    { kind: 'stmt', indent: 1, text: 'uint64 bi = bit_insert(0xFF00FF00ULL, 0xABULL, 8, 8);' },
    { kind: 'stmt', indent: 1, text: 'int iz0 = is_zero(0);' },
    { kind: 'stmt', indent: 1, text: 'int iz1 = is_zero(a1);' },
    { kind: 'stmt', indent: 1, text: 'int64 mn = min(-5, 10);' },
    { kind: 'stmt', indent: 1, text: 'int64 mx = max(-5, 10);' },
    { kind: 'stmt', indent: 1, text: 'uint64 rr = ror(0x8000000000000001ULL, 1);' },
    { kind: 'stmt', indent: 1, text: 'uint64 rl = rol(0x8000000000000001ULL, 1);' },
    { kind: 'stmt', indent: 1, text: 'uint64 bs = bswap16(0x1234) + bswap32(0x12345678U) + bswap64(0x0102030405060708ULL);' },
    { kind: 'stmt', indent: 1, text: 'uint64 bc = clz(0) + clz32(0x00800000U) + clz64(1ULL) + ctz(0) + ctz32(8U) + ctz64(16ULL) + popcnt(0xF0F0ULL);' },
    { kind: 'stmt', indent: 1, text: 'int nz1 = __arm64_nzcv_add_mi_32(0x7FFFFFFFULL, 1ULL);' },
    { kind: 'stmt', indent: 1, text: 'int nz2 = __arm64_nzcv_add_mi_32(1ULL, 2ULL);' },
    { kind: 'stmt', indent: 1, text: 'int nz3 = __arm64_nzcv_sub_lt_32(0x80000000ULL, 1ULL);' },
    { kind: 'stmt', indent: 1, text: 'int nz4 = __arm64_nzcv_sub_cs_64(10ULL, 5ULL);' },
    { kind: 'stmt', indent: 1, text: 'int nz5 = __arm64_nzcv_and_eq_64(0xF0ULL, 0x0FULL);' },
    { kind: 'stmt', indent: 1, text: 'int is_a = ((*ctype_b_loc())[(unsigned char)\'A\'] & 0x0400) != 0;' },
    { kind: 'stmt', indent: 1, text: 'int lo_a = (*ctype_tolower_loc())[(unsigned char)\'A\'];' },
    { kind: 'stmt', indent: 1, text: 'int up_a = (*ctype_toupper_loc())[(unsigned char)\'a\'];' },
    { kind: 'stmt', indent: 1, text: '*errno_location() = 0;' },
    { kind: 'stmt', indent: 1, text: 'if (s != -1 || z != 0x9ABCDEF0ULL) return 101;' },
    { kind: 'stmt', indent: 1, text: 'if (be != 0xD12ULL || bi != 0xFF00AB00ULL) return 102;' },
    { kind: 'stmt', indent: 1, text: 'if (iz0 != 1 || iz1 != 0 || mn != -5 || mx != 10) return 103;' },
    { kind: 'stmt', indent: 1, text: 'if (rr != 0xC000000000000000ULL || rl != 3ULL) return 104;' },
    { kind: 'stmt', indent: 1, text: 'if (bs != (0x3412ULL + 0x78563412ULL + 0x0807060504030201ULL)) return 105;' },
    { kind: 'stmt', indent: 1, text: 'if (bc != (64ULL + 8ULL + 63ULL + 64ULL + 3ULL + 4ULL + 8ULL)) return 106;' },
    { kind: 'stmt', indent: 1, text: 'if (nz1 != 1 || nz2 != 0 || nz3 != 1 || nz4 != 1 || nz5 != 1) return 107;' },
    { kind: 'stmt', indent: 1, text: 'if (!is_a || lo_a != \'a\' || up_a != \'A\' || *errno_location() != 0) return 108;' },
    { kind: 'ctrl', indent: 1, text: 'return a1 + a2;' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]);

  closeFunctionOutput(result);

  // Zero __HEX_ANY_ARGS prototypes emitted for intrinsics or glibc aliases.
  assert.doesNotMatch(result.pseudocode, /__HEX_ANY_ARGS/);
  assert.doesNotMatch(result.pseudocode, /standalone external prototypes/);
  assert.match(result.pseudocode, /#include <ctype\.h>/);
  assert.match(result.pseudocode, /#include <errno\.h>/);
  assert.match(result.pseudocode, /#define ctype_b_loc __ctype_b_loc/);
  assert.match(result.pseudocode, /#define ctype_tolower_loc __ctype_tolower_loc/);
  assert.match(result.pseudocode, /#define ctype_toupper_loc __ctype_toupper_loc/);
  assert.match(result.pseudocode, /#define errno_location __errno_location/);
  assert.match(result.pseudocode, /static inline int64_t sext\(uint64_t v\)/);
  assert.match(result.pseudocode, /static inline uint64_t bit_extract\(uint64_t v, unsigned lsb, unsigned width\)/);
  assert.match(result.pseudocode, /static inline uint64_t bit_insert\(uint64_t dst, uint64_t src, unsigned lsb, unsigned width\)/);
  assert.match(result.pseudocode, /static inline int is_zero\(uint64_t v\)/);
  assert.match(result.pseudocode, /static inline int64_t min\(int64_t a, int64_t b\)/);
  assert.match(result.pseudocode, /static inline int64_t max\(int64_t a, int64_t b\)/);
  assert.match(result.pseudocode, /static inline int __arm64_nzcv_add_mi_32\(uint64_t a, uint64_t b\)/);

  // Strictly idempotent on second pass.
  const once = result.pseudocode;
  const onceLines = result.lines.length;
  closeFunctionOutput(result);
  assert.equal(result.pseudocode, once);
  assert.equal(result.lines.length, onceLines);

  // Compile + link + run under qemu-aarch64.
  const harness = `
#include <stdio.h>
${result.pseudocode}
int main(void) {
  uint64 r = test_intrinsics(20ULL, 22ULL);
  printf("%llu\\n", (unsigned long long)r);
  return r == 42ULL ? 0 : 1;
}
`;
  const out = compileAndRunAarch64(harness, 'intrinsics+nzcv+glibc');
  assert.equal(out, '42');
});

test('only actually-called helpers are emitted (no unused helper bloat)', () => {
  const result = makeResult([
    { kind: 'sig', indent: 0, text: 'int64 only_sext(uint64 a1)', row: 0, addr: 0x2000n },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'ctrl', indent: 1, text: 'return sext(a1);' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]);

  closeFunctionOutput(result);
  assert.match(result.pseudocode, /static inline int64_t sext\(uint64_t v\)/);
  assert.doesNotMatch(result.pseudocode, /\bzext\(/);
  assert.doesNotMatch(result.pseudocode, /\bbit_extract\(/);
  assert.doesNotMatch(result.pseudocode, /\bmin\(/);
  assert.doesNotMatch(result.pseudocode, /#include <ctype\.h>/);
  assert.doesNotMatch(result.pseudocode, /#include <errno\.h>/);
});

test('signature scalar/void* parameters and scalar locals using -> synthesize hex_struct_<name>, rewrite -> safely, compile+link with aarch64-linux-gnu-gcc -O0, and run under qemu-aarch64', () => {
  const sigSource = { addresses: [0x3000n], rows: [0] };
  const result = makeResult([
    { kind: 'sig', indent: 0, text: 'uint64 func0(uint64 a1, uint64 a2, void * a3)', row: 0, addr: 0x3000n, source: sigSource },
    { kind: 'ctrl', indent: 0, text: '{', row: 0, addr: 0x3000n, source: sigSource },
    { kind: 'stmt', indent: 1, text: '/* a1->field_0 inside comment stays untouched */' },
    { kind: 'stmt', indent: 1, text: 'const char * msg = "a2->field_0";' },
    { kind: 'stmt', indent: 1, text: '(void)msg;' },
    { kind: 'stmt', indent: 1, text: 'uint64 local_ptr = a1;' },
    { kind: 'stmt', indent: 1, text: 'uint64 v1 = a1->field_0 + a1->field_8;' },
    { kind: 'stmt', indent: 1, text: 'uint64 v2 = a2->field_0 + a3->field_0;' },
    { kind: 'stmt', indent: 1, text: 'uint64 v3 = local_ptr->field_0;' },
    { kind: 'ctrl', indent: 1, text: 'return v1 + v2 + v3;' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]);

  closeFunctionOutput(result);

  assert.match(result.pseudocode, /typedef __UINTPTR_TYPE__ uintptr_t;/);
  assert.match(result.pseudocode, /typedef struct hex_struct_a1 \{ uint64 field_0; uint64 field_8; \} hex_struct_a1;/);
  assert.match(result.pseudocode, /typedef struct hex_struct_a2 \{ uint64 field_0; \} hex_struct_a2;/);
  assert.match(result.pseudocode, /typedef struct hex_struct_a3 \{ uint64 field_0; \} hex_struct_a3;/);
  assert.match(result.pseudocode, /typedef struct hex_struct_local_ptr \{ uint64 field_0; \} hex_struct_local_ptr;/);
  assert.match(result.pseudocode, /\(\(hex_struct_a1 \*\)\(uintptr_t\)\(a1\)\)->field_0/);
  assert.match(result.pseudocode, /\(\(hex_struct_a1 \*\)\(uintptr_t\)\(a1\)\)->field_8/);
  assert.match(result.pseudocode, /\(\(hex_struct_a2 \*\)\(uintptr_t\)\(a2\)\)->field_0/);
  assert.match(result.pseudocode, /\(\(hex_struct_a3 \*\)\(uintptr_t\)\(a3\)\)->field_0/);
  assert.match(result.pseudocode, /\(\(hex_struct_local_ptr \*\)\(uintptr_t\)\(local_ptr\)\)->field_0/);
  // Comments and string literals must remain untouched.
  assert.match(result.pseudocode, /\/\* a1->field_0 inside comment stays untouched \*\//);
  assert.match(result.pseudocode, /"a2->field_0"/);

  // Strictly idempotent on second pass.
  const once = result.pseudocode;
  const onceLines = result.lines.length;
  closeFunctionOutput(result);
  assert.equal(result.pseudocode, once);
  assert.equal(result.lines.length, onceLines);

  // Compile + link + run under qemu-aarch64.
  const harness = `
#include <stdio.h>
${result.pseudocode}
int main(void) {
  hex_struct_a1 s1 = { 10ULL, 20ULL };
  hex_struct_a2 s2 = { 30ULL };
  hex_struct_a3 s3 = { 40ULL };
  uint64 r = func0((uint64)(uintptr_t)&s1, (uint64)(uintptr_t)&s2, (void *)&s3);
  printf("%llu\\n", (unsigned long long)r);
  return r == 110ULL ? 0 : 1;
}
`;
  const out = compileAndRunAarch64(harness, 'scalar-arrow-rewrite');
  assert.equal(out, '110');
});
