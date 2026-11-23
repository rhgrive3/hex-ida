import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  closeFunctionOutput,
  isStandaloneGlobalPreludeDeclaration,
} from '../../js/decompiler/c-output-closure.js';
import { knownCallPrototype, knownCallSignature } from '../../js/decompiler/call-prototypes.js';
import { buildCTranslationUnit } from '../../js/analysis/query/translation-unit.js';

function makeResult(lines) {
  return {
    lines,
    pseudocode: lines.map((l) => `${'    '.repeat(l.indent || 0)}${l.text}`).join('\n'),
  };
}

function compileAndRunAarch64(cSource, label = 'aarch64-test') {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-track3-test-'));
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

test('Fix 1: stack_chk_fail emits __stack_chk_fail alias without null include, is idempotent, and compiles+links under aarch64-linux-gnu-gcc', () => {
  const result = makeResult([
    { kind: 'sig', indent: 0, text: 'uint64 checked_add(uint64 a, uint64 b)', row: 0, addr: 0x1000n },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'stmt', indent: 1, text: 'uint64 canary = 0x1234ULL;' },
    { kind: 'stmt', indent: 1, text: 'if (canary != 0x1234ULL) {' },
    { kind: 'stmt', indent: 2, text: 'stack_chk_fail();' },
    { kind: 'stmt', indent: 1, text: '}' },
    { kind: 'ctrl', indent: 1, text: 'return a + b;' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]);

  closeFunctionOutput(result);

  assert.match(result.pseudocode, /extern void __stack_chk_fail\(void\);/);
  assert.match(result.pseudocode, /#define stack_chk_fail __stack_chk_fail/);
  assert.doesNotMatch(result.pseudocode, /#include null/);
  assert.doesNotMatch(result.pseudocode, /uint64 stack_chk_fail/);

  const once = result.pseudocode;
  closeFunctionOutput(result);
  assert.equal(result.pseudocode, once);

  const direct = makeResult([
    { kind: 'sig', indent: 0, text: 'void direct_chk(int bad)', row: 0, addr: 0x1100n },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'stmt', indent: 1, text: 'if (bad) __stack_chk_fail();' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]);
  closeFunctionOutput(direct);
  assert.match(direct.pseudocode, /extern void __stack_chk_fail\(void\);/);
  assert.doesNotMatch(direct.pseudocode, /uint64 __stack_chk_fail/);
  const directOnce = direct.pseudocode;
  closeFunctionOutput(direct);
  assert.equal(direct.pseudocode, directOnce);

  const harness = `
#include <stdio.h>
${result.pseudocode}
int main(void) {
  uint64 r = checked_add(19ULL, 23ULL);
  printf("%llu\\n", (unsigned long long)r);
  return r == 42ULL ? 0 : 1;
}
`;
  const out = compileAndRunAarch64(harness, 'stack-chk-fail-compile-link');
  assert.equal(out, '42');
});

test('Fix 2: stpcpy is recognized in call-prototypes and c-output-closure without conflicting declaration', () => {
  const proto = knownCallPrototype('stpcpy');
  assert.equal(proto?.arity, 2);
  assert.equal(proto?.variadic, false);
  const sig = knownCallSignature('stpcpy');
  assert.equal(sig?.retType, 'ptr');
  assert.deepEqual(sig?.paramTypes, ['ptr', 'ptr']);

  const result = makeResult([
    { kind: 'sig', indent: 0, text: 'uint64 copy_and_end(uint64 dst, uint64 src)', row: 0, addr: 0x2000n },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'stmt', indent: 1, text: 'call_1 = stpcpy(dst, src);' },
    { kind: 'ctrl', indent: 1, text: 'return (uint64)(uintptr_t)call_1;' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]);

  closeFunctionOutput(result);

  assert.match(result.pseudocode, /#include <string\.h>/);
  assert.doesNotMatch(result.pseudocode, /uint64 stpcpy/);
  assert.match(result.pseudocode, /(?:void|char) \* call_1;/);

  const once = result.pseudocode;
  closeFunctionOutput(result);
  assert.equal(result.pseudocode, once);

  const harness = `
#define _POSIX_C_SOURCE 200809L
#include <stddef.h>
#include <stdio.h>
${result.pseudocode}
int main(void) {
  char out[32] = {0};
  uint64 end_addr = copy_and_end((uint64)(uintptr_t)out, (uint64)(uintptr_t)"hello");
  ptrdiff_t len = (char *)(uintptr_t)end_addr - out;
  printf("%s:%td\\n", out, len);
  return len == 5 ? 0 : 1;
}
`;
  const out = compileAndRunAarch64(harness, 'stpcpy-compile-link');
  assert.equal(out, 'hello:5');
});

test('Fix 3: inferMutablePtrReturnLocals rejects subscript, unary ~, and uncast enclosing arithmetic/bitwise contexts while preserving cast/call contexts', () => {
  const rejectedCases = makeResult([
    { kind: 'sig', indent: 0, text: 'uint64 ptr_arith_guards(uint64 n, const uint8_t * arr)', row: 0, addr: 0x3000n },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'stmt', indent: 1, text: 'c_sub = malloc(n);' },
    { kind: 'stmt', indent: 1, text: 'c_tilde = malloc(n);' },
    { kind: 'stmt', indent: 1, text: 'c_enc_tilde = malloc(n);' },
    { kind: 'stmt', indent: 1, text: 'c_enc_and = malloc(n);' },
    { kind: 'stmt', indent: 1, text: 'c_enc_sub = malloc(n);' },
    { kind: 'stmt', indent: 1, text: 'c_enc_idx = malloc(n);' },
    { kind: 'stmt', indent: 1, text: 'c_cast_ok = malloc(n);' },
    { kind: 'stmt', indent: 1, text: 'c_call_ok = malloc(n);' },
    { kind: 'stmt', indent: 1, text: 'r1 = arr[c_sub];' },
    { kind: 'stmt', indent: 1, text: 'r2 = ~c_tilde;' },
    { kind: 'stmt', indent: 1, text: 'r3 = ~(c_enc_tilde + 4);' },
    { kind: 'stmt', indent: 1, text: 'r4 = (c_enc_and + 4) & 7;' },
    { kind: 'stmt', indent: 1, text: 'r5 = (c_enc_sub + 4) - 1;' },
    { kind: 'stmt', indent: 1, text: 'r6 = arr[(c_enc_idx + 1)];' },
    { kind: 'stmt', indent: 1, text: 'r7 = (uintptr_t)(c_cast_ok + 4) & 7;' },
    { kind: 'stmt', indent: 1, text: 'r8 = strlen(c_call_ok + 1) & 7;' },
    { kind: 'ctrl', indent: 1, text: 'return r1 + r2 + r3 + r4 + r5 + r6 + r7 + r8;' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]);

  closeFunctionOutput(rejectedCases);

  assert.match(rejectedCases.pseudocode, /\buint64 c_sub;/);
  assert.match(rejectedCases.pseudocode, /\buint64 c_tilde;/);
  assert.match(rejectedCases.pseudocode, /\buint64 c_enc_tilde;/);
  assert.match(rejectedCases.pseudocode, /\buint64 c_enc_and;/);
  assert.match(rejectedCases.pseudocode, /\buint64 c_enc_sub;/);
  assert.match(rejectedCases.pseudocode, /\buint64 c_enc_idx;/);
  assert.match(rejectedCases.pseudocode, /\bchar \* c_cast_ok;/);
  assert.match(rejectedCases.pseudocode, /\bchar \* c_call_ok;/);

  const harness = `
#include <stdio.h>
${rejectedCases.pseudocode}
int main(void) {
  (void)ptr_arith_guards;
  puts("ok");
  return 0;
}
`;
  const out = compileAndRunAarch64(harness, 'infer-mutable-ptr-return-locals');
  assert.equal(out, 'ok');
});

test('Fix 4: standalone global_* emits linkable static = 0, is recognized and stripped by TU packager, and links cleanly', () => {
  assert.equal(isStandaloneGlobalPreludeDeclaration('extern uint64 global_1FFE8;'), true);
  assert.equal(isStandaloneGlobalPreludeDeclaration('static uint64 global_1FFE8 = 0;'), true);
  assert.equal(isStandaloneGlobalPreludeDeclaration('static uint64 global_1FFE8 = 1;'), false);

  const result = makeResult([
    { kind: 'sig', indent: 0, text: 'uint64 bump_global(uint64 delta)', row: 0, addr: 0x4000n },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'stmt', indent: 1, text: 'global_1FFE8 = global_1FFE8 + delta;' },
    { kind: 'ctrl', indent: 1, text: 'return global_1FFE8;' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]);

  closeFunctionOutput(result);

  assert.match(result.pseudocode, /static uint64 global_1FFE8 = 0;/);
  assert.doesNotMatch(result.pseudocode, /extern uint64 global_1FFE8;/);

  const once = result.pseudocode;
  closeFunctionOutput(result);
  assert.equal(result.pseudocode, once);

  const unit = buildCTranslationUnit([
    { address: 0x4000n, name: 'bump_global', signature: 'uint64 bump_global(uint64 delta)', pseudocode: result.pseudocode },
  ]);
  assert.doesNotMatch(unit.source, /static uint64 global_1FFE8 = 0;/);
  assert.ok(unit.unresolved.some((row) => row.kind === 'unresolved-global' && row.subject === 'global_1FFE8'));

  const harness = `
#include <stdio.h>
${result.pseudocode}
int main(void) {
  uint64 a = bump_global(10ULL);
  uint64 b = bump_global(5ULL);
  printf("%llu,%llu\\n", (unsigned long long)a, (unsigned long long)b);
  return (a == 10ULL && b == 15ULL) ? 0 : 1;
}
`;
  const out = compileAndRunAarch64(harness, 'static-global-compile-link');
  assert.equal(out, '10,15');
});

test('Fix 5: escaped local sp gets synthetic __hex_stack_frame buffer (sized & clamped), skips param sp, and runs under qemu-aarch64 without SIGSEGV', () => {
  const result = makeResult([
    { kind: 'sig', indent: 0, text: 'uint64 stack_roundtrip(uint64 v)', row: 0, addr: 0x5000n },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'stmt', indent: 1, text: '*(uint64 *)(uintptr_t)(sp - 0x20) = v + 7;' },
    { kind: 'ctrl', indent: 1, text: 'return *(uint64 *)(uintptr_t)(sp - 0x20);' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]);

  closeFunctionOutput(result);

  assert.match(result.pseudocode, /typedef __UINT8_TYPE__ uint8_t;/);
  assert.match(result.pseudocode, /typedef __UINTPTR_TYPE__ uintptr_t;/);
  assert.match(result.pseudocode, /uint8_t __hex_stack_frame\[4096\] = \{0\};/);
  assert.match(result.pseudocode, /uint64 sp = \(uintptr_t\)\(__hex_stack_frame \+ sizeof\(__hex_stack_frame\)\);/);

  const once = result.pseudocode;
  closeFunctionOutput(result);
  assert.equal(result.pseudocode, once);

  // Large frame sizing (5000 + 256 = 5256 -> rounded up to 16 = 5264)
  const large = makeResult([
    { kind: 'sig', indent: 0, text: 'uint64 large_frame(void)', row: 0, addr: 0x5100n },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'ctrl', indent: 1, text: 'return *(uint64 *)(uintptr_t)(sp - 5000);' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]);
  closeFunctionOutput(large);
  assert.match(large.pseudocode, /uint8_t __hex_stack_frame\[5264\] = \{0\};/);

  // Cap at 65536
  const capped = makeResult([
    { kind: 'sig', indent: 0, text: 'uint64 capped_frame(void)', row: 0, addr: 0x5200n },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'ctrl', indent: 1, text: 'return *(uint64 *)(uintptr_t)(sp - 100000);' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]);
  closeFunctionOutput(capped);
  assert.match(capped.pseudocode, /uint8_t __hex_stack_frame\[65536\] = \{0\};/);

  // Parameter sp must NOT synthesize a stack buffer
  const paramSp = makeResult([
    { kind: 'sig', indent: 0, text: 'uint64 param_sp(uint64 sp)', row: 0, addr: 0x5300n },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'ctrl', indent: 1, text: 'return sp - 16;' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]);
  closeFunctionOutput(paramSp);
  assert.doesNotMatch(paramSp.pseudocode, /__hex_stack_frame/);

  const harness = `
#include <stdio.h>
${result.pseudocode}
int main(void) {
  uint64 r = stack_roundtrip(35ULL);
  printf("%llu\\n", (unsigned long long)r);
  return r == 42ULL ? 0 : 1;
}
`;
  const out = compileAndRunAarch64(harness, 'synthetic-sp-stack-frame');
  assert.equal(out, '42');
});
