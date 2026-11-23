import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  closeFunctionOutput,
  inferPointerTypedLocals,
  localDeclarationTypeFor,
  STANDARD_C_LIBRARY_HEADERS,
  isHelperPreludeLine,
  extractHelperPreludeBlocks,
} from '../../js/decompiler/c-output-closure.js';
import { buildCTranslationUnit } from '../../js/analysis/query/translation-unit.js';
import {
  createGCaseRunner,
  reconstructSource,
  reconstructTranslationUnit,
} from '../../tools/validation/direct-recompilability/measure-g.mjs';

function makeResult(lines) {
  return {
    lines,
    pseudocode: lines.map((l) => `${'    '.repeat(l.indent || 0)}${l.text}`).join('\n'),
  };
}

const AARCH64_GCC = (() => {
  const probe = spawnSync('aarch64-linux-gnu-gcc', ['--version'], { encoding: 'utf8' });
  return !probe.error && probe.status === 0 ? 'aarch64-linux-gnu-gcc' : null;
})();

const HOST_CC = (() => {
  for (const cc of ['clang', 'gcc']) {
    const probe = spawnSync(cc, ['--version'], { encoding: 'utf8' });
    if (!probe.error && probe.status === 0) return cc;
  }
  return null;
})();

test('localDeclarationTypeFor and inferPointerTypedLocals are both exported and functional', () => {
  assert.equal(typeof localDeclarationTypeFor, 'function');
  assert.equal(typeof inferPointerTypedLocals, 'function');
  assert.equal(localDeclarationTypeFor('w0', {}), 'uint32');
  assert.equal(localDeclarationTypeFor('x1', {}), 'uint64');
  const ptrs = inferPointerTypedLocals('{\n  p = "hello";\n  return p;\n}', 'const void * f(void)');
  assert.ok(ptrs.has('p'));
});

test('deeply nested parenthesized bitwise and ternary expressions complete in O(N) (< 50ms)', () => {
  const depth = 32;
  const open = '('.repeat(depth);
  const close = ')'.repeat(depth);
  const bitExpr = `${open}((d & 1) | (x ^ 3))${close}`;
  const ternExpr = `${open}(c ? p : 1)${close}`;

  const result = makeResult([
    { kind: 'sig', indent: 0, text: 'uint64 perf_fn(double d, uint64 x, int c, const char * p)', row: 0, addr: 0x1000n },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'stmt', indent: 1, text: `uint64 a = ${bitExpr};` },
    { kind: 'stmt', indent: 1, text: `uint64 b = ${ternExpr};` },
    { kind: 'ctrl', indent: 1, text: 'return a + b;' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]);

  const t0 = performance.now();
  closeFunctionOutput(result);
  const elapsed = performance.now() - t0;

  assert.ok(elapsed < 50, `Expected O(N) closure < 50ms, took ${elapsed.toFixed(1)}ms`);
  assert.match(result.pseudocode, /\(uint64\)\(d\)/);
  assert.match(result.pseudocode, /\(uintptr_t\)\(p\)/);

  // Also verify fast short-circuit when no floats exist.
  const noFloat = makeResult([
    { kind: 'sig', indent: 0, text: 'uint64 fast_int(uint64 x)', row: 0, addr: 0x1100n },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'stmt', indent: 1, text: `return ${open}(x & 0xff)${close};` },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]);
  const t1 = performance.now();
  closeFunctionOutput(noFloat);
  assert.ok(performance.now() - t1 < 50);
});

test('scalar arrow rewrite does not misparse -> as minus and recursively rewrites nested arrows', () => {
  const result = makeResult([
    { kind: 'sig', indent: 0, text: 'uint64 nested_arrows(uint64 a1, uint64 a2)', row: 0, addr: 0x2000n },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'stmt', indent: 1, text: 'uint64 v1 = (a1->x)->y;' },
    { kind: 'stmt', indent: 1, text: 'uint64 v2 = (a1 + a2->f)->g;' },
    { kind: 'ctrl', indent: 1, text: 'return v1 + v2;' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]);

  closeFunctionOutput(result);

  // `y` must NOT be added to hex_struct_a1 as a field of a1.
  const structA1 = /typedef struct hex_struct_a1 \{([^}]+)\} hex_struct_a1;/.exec(result.pseudocode);
  assert.ok(structA1, `expected hex_struct_a1 typedef in:\n${result.pseudocode}`);
  assert.match(structA1[1], /\bx\b/);
  assert.match(structA1[1], /\bg\b/);
  assert.doesNotMatch(structA1[1], /\by\b/);

  // Nested arrow inside pointer arithmetic `(a1 + a2->f)->g` must rewrite both a2->f and the outer arrow.
  assert.match(
    result.pseudocode,
    /\(\(hex_struct_a1 \*\)\(uintptr_t\)\(a1 \+ \(\(hex_struct_a2 \*\)\(uintptr_t\)\(a2\)\)->f\)\)->g/,
  );
  // `(a1->x)->y` must rewrite inner `a1->x` without treating `a1->x` as `a1 - >x`.
  assert.match(
    result.pseudocode,
    /\(\(\(hex_struct_a1 \*\)\(uintptr_t\)\(a1\)\)->x\)->y/,
  );
});

test('id local variable does not emit typedef void * id, while id type usage does', () => {
  const localId = makeResult([
    { kind: 'sig', indent: 0, text: 'uint64 use_id_var(uint64 x)', row: 0, addr: 0x3000n },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'stmt', indent: 1, text: 'id = x + 1;' },
    { kind: 'ctrl', indent: 1, text: 'return (id);' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]);
  closeFunctionOutput(localId);
  assert.doesNotMatch(localId.pseudocode, /typedef void \* id;/);
  assert.match(localId.pseudocode, /uint64 id;/);

  // TU packager must also NOT emit typedef void * id for parenthesized variable `(id)` or `if (id)`.
  const unitLocalId = buildCTranslationUnit([
    { address: 0x3000n, name: 'use_id_var', signature: 'uint64 use_id_var(uint64 x)', pseudocode: localId.pseudocode },
  ]);
  assert.doesNotMatch(unitLocalId.source, /typedef void \* id;/);
  assert.equal(unitLocalId.functions[0].syntaxOnly, false, JSON.stringify(unitLocalId.unresolved));

  // Explicit id type usage in signature or cast DOES emit typedef void * id and skips local decl.
  const objcId = makeResult([
    { kind: 'sig', indent: 0, text: 'id objc_ret(id self, uint64 x)', row: 0, addr: 0x3100n },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'ctrl', indent: 1, text: 'return (id)x;' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]);
  closeFunctionOutput(objcId);
  assert.match(objcId.pseudocode, /typedef void \* id;/);
  assert.doesNotMatch(objcId.pseudocode, /uint64 id;/);

  const unitObjcId = buildCTranslationUnit([
    { address: 0x3100n, name: 'objc_ret', signature: 'id objc_ret(id self, uint64 x)', pseudocode: objcId.pseudocode },
  ]);
  assert.match(unitObjcId.source, /typedef void \* id;/);
});

test('min/max static inline helpers are only emitted when all call sites are 2-arg', () => {
  const twoArg = makeResult([
    { kind: 'sig', indent: 0, text: 'int64_t use_min2(int64_t a, int64_t b)', row: 0, addr: 0x4000n },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'ctrl', indent: 1, text: 'return min(a, b) + max(a, b);' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]);
  closeFunctionOutput(twoArg);
  assert.match(twoArg.pseudocode, /static inline int64_t min\(/);
  assert.match(twoArg.pseudocode, /static inline int64_t max\(/);

  const threeArg = makeResult([
    { kind: 'sig', indent: 0, text: 'uint64 use_min3(uint64 a, uint64 b, uint64 c)', row: 0, addr: 0x4100n },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'ctrl', indent: 1, text: 'return min(a, b, c) + max(a);' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]);
  closeFunctionOutput(threeArg);
  assert.doesNotMatch(threeArg.pseudocode, /static inline int64_t min\(/);
  assert.doesNotMatch(threeArg.pseudocode, /static inline int64_t max\(/);
  assert.match(threeArg.pseudocode, /uint64 min \(__HEX_ANY_ARGS\);/);
  assert.match(threeArg.pseudocode, /uint64 max \(__HEX_ANY_ARGS\);/);
});

test('STANDARD_C_LIBRARY_HEADERS includes math classification macros, drops index/rindex, and wraps glibc aliases', () => {
  for (const fn of ['isnan', 'isinf', 'isfinite', 'signbit', 'fpclassify']) {
    assert.equal(STANDARD_C_LIBRARY_HEADERS.get(fn), '<math.h>');
  }
  assert.equal(STANDARD_C_LIBRARY_HEADERS.has('index'), false);
  assert.equal(STANDARD_C_LIBRARY_HEADERS.has('rindex'), false);

  const result = makeResult([
    { kind: 'sig', indent: 0, text: 'int check_glibc_aliases(void)', row: 0, addr: 0x5000n },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'stmt', indent: 1, text: 'int e = *errno_location();' },
    { kind: 'stmt', indent: 1, text: 'const unsigned short * tbl = *ctype_b_loc();' },
    { kind: 'ctrl', indent: 1, text: 'return e + (int)tbl[0];' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]);
  closeFunctionOutput(result);
  assert.match(result.pseudocode, /#include <ctype\.h>/);
  assert.match(result.pseudocode, /#include <errno\.h>/);
  assert.match(result.pseudocode, /#if defined\(__GLIBC__\)\n#ifndef errno_location\n#define errno_location __errno_location\n#endif\n#endif/);
  assert.match(result.pseudocode, /#if defined\(__GLIBC__\)\n#ifndef ctype_b_loc\n#define ctype_b_loc __ctype_b_loc\n#endif\n#endif/);
});

test('classifyExprType treats pointer-returning stdlib calls as ptr', () => {
  const result = makeResult([
    { kind: 'sig', indent: 0, text: 'uint64 ptr_stdlib_calls(const char * s, int cond)', row: 0, addr: 0x6000n },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'stmt', indent: 1, text: 'char * buf = malloc(32);' },
    { kind: 'stmt', indent: 1, text: 'uint64 addr = strchr(s, 65);' },
    { kind: 'stmt', indent: 1, text: 'uint64 t = cond ? getenv("HOME") : 1;' },
    { kind: 'ctrl', indent: 1, text: 'return addr + t + (uintptr_t)buf;' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]);
  closeFunctionOutput(result);
  // char * buf = malloc(32) must NOT be wrapped with (void *)(uintptr_t)(...)
  assert.match(result.pseudocode, /char \* buf = malloc\(32\);/);
  // uint64 addr = strchr(...) MUST be coerced with (uintptr_t)(...)
  assert.match(result.pseudocode, /uint64 addr = \(uintptr_t\)\(strchr\(s, 65\)\);/);
  // mixed ternary with pointer-returning getenv() MUST wrap the ptr arm
  assert.match(result.pseudocode, /cond \? \(uintptr_t\)\(getenv\("HOME"\)\) : 1/);
});

test('HumanEval *_chk glibc aliases emit guarded declarations and compile + link with aarch64-linux-gnu-gcc', () => {
  const result = makeResult([
    { kind: 'sig', indent: 0, text: 'int use_chk_fns(char * dst, const char * src, size_t n)', row: 0, addr: 0x7000n },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'stmt', indent: 1, text: 'memcpy_chk(dst, src, n, n);' },
    { kind: 'stmt', indent: 1, text: 'memmove_chk(dst, src, n, n);' },
    { kind: 'stmt', indent: 1, text: 'memset_chk(dst, 0, n, n);' },
    { kind: 'stmt', indent: 1, text: 'strcpy_chk(dst, src, n);' },
    { kind: 'stmt', indent: 1, text: 'strncpy_chk(dst, src, n, n);' },
    { kind: 'stmt', indent: 1, text: 'strcat_chk(dst, src, n);' },
    { kind: 'stmt', indent: 1, text: 'strncat_chk(dst, src, n, n);' },
    { kind: 'stmt', indent: 1, text: 'sprintf_chk(dst, 1, n, "%s", src);' },
    { kind: 'stmt', indent: 1, text: 'snprintf_chk(dst, n, 1, n, "%s", src);' },
    { kind: 'stmt', indent: 1, text: 'printf_chk(1, "%s", src);' },
    { kind: 'stmt', indent: 1, text: 'fprintf_chk(stdout, 1, "%s", src);' },
    { kind: 'ctrl', indent: 1, text: 'return 0;' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]);

  closeFunctionOutput(result);
  assert.match(result.pseudocode, /#include <stdio\.h>/);
  assert.match(result.pseudocode, /#include <string\.h>/);
  assert.match(result.pseudocode, /#if defined\(__GLIBC__\)/);
  assert.match(result.pseudocode, /#define sprintf_chk __sprintf_chk/);
  assert.match(result.pseudocode, /#define memcpy_chk __memcpy_chk/);
  assert.doesNotMatch(result.pseudocode, /uint64 sprintf_chk \(__HEX_ANY_ARGS\);/);

  // Idempotent on second pass.
  const once = result.pseudocode;
  closeFunctionOutput(result);
  assert.equal(result.pseudocode, once);

  if (AARCH64_GCC) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-chk-link-'));
    try {
      const cFile = path.join(tmpDir, 'chk.c');
      const outO0 = path.join(tmpDir, 'chk_o0');
      const outO2 = path.join(tmpDir, 'chk_o2');
      fs.writeFileSync(cFile, `${result.pseudocode}\nint main(void) { return 0; }\n`);
      execFileSync(AARCH64_GCC, ['-O0', '-std=gnu11', '-Wall', '-Werror=implicit-function-declaration', cFile, '-o', outO0], { stdio: 'pipe' });
      execFileSync(AARCH64_GCC, ['-O2', '-std=gnu11', '-Wall', '-Werror=implicit-function-declaration', cFile, '-o', outO2], { stdio: 'pipe' });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
});

test('buildCTranslationUnit hoists and deduplicates shared helper preludes (sext, atomic, glibc)', () => {
  const fn1 = makeResult([
    { kind: 'sig', indent: 0, text: 'int64_t f1(uint64_t a, uint64_t * p)', row: 0, addr: 0x8000n },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'stmt', indent: 1, text: 'uint64_t v = __atomic_load(p);' },
    { kind: 'ctrl', indent: 1, text: 'return sext(a + v);' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]);
  const fn2 = makeResult([
    { kind: 'sig', indent: 0, text: 'int64_t f2(uint64_t b, char * dst, const char * src, size_t n)', row: 0, addr: 0x8100n },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'stmt', indent: 1, text: 'sprintf_chk(dst, 1, n, "%s", src);' },
    { kind: 'ctrl', indent: 1, text: 'return sext(b);' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]);
  closeFunctionOutput(fn1);
  closeFunctionOutput(fn2);

  assert.equal(isHelperPreludeLine('#ifndef __hex_helper_sext_defined'), true);
  assert.ok(extractHelperPreludeBlocks(fn1.pseudocode).some((b) => b.names.includes('sext')));

  const unit = buildCTranslationUnit([
    { address: 0x8000n, name: 'f1', signature: 'int64_t f1(uint64_t a, uint64_t * p)', pseudocode: fn1.pseudocode },
    { address: 0x8100n, name: 'f2', signature: 'int64_t f2(uint64_t b, char * dst, const char * src, size_t n)', pseudocode: fn2.pseudocode },
  ]);

  assert.equal(unit.functions[0].syntaxOnly, false, JSON.stringify(unit.unresolved));
  assert.equal(unit.functions[1].syntaxOnly, false, JSON.stringify(unit.unresolved));
  assert.equal(unit.source.split('#ifndef __hex_helper_sext_defined').length - 1, 1);
  assert.equal(unit.source.split('#ifndef __hex_atomic_load_defined').length - 1, 1);
  assert.equal(unit.source.split('#define sprintf_chk __sprintf_chk').length - 1, 1);
  assert.equal(unit.unresolved.length, 0, JSON.stringify(unit.unresolved));

  if (HOST_CC) {
    const check = spawnSync(HOST_CC, ['-std=gnu11', '-x', 'c', '-fsyntax-only', '-'], {
      input: unit.source,
      encoding: 'utf8',
    });
    assert.equal(check.status, 0, `TU failed ${HOST_CC} -fsyntax-only:\n${unit.source}\n${check.stderr}`);
  }
});

test('faithfulBodyEligibility only covers stdlibHeaderFunctions in call or &/fn-ptr position', () => {
  const scalarUse = [
    '#include <stdlib.h>',
    'int bad_scalar_free(void)',
    '{',
    '    return free + 1;',
    '}',
  ].join('\n');
  const unitBad = buildCTranslationUnit([
    { address: 0x9000n, name: 'bad_scalar_free', signature: 'int bad_scalar_free(void)', pseudocode: scalarUse },
  ]);
  assert.equal(unitBad.functions[0].syntaxOnly, true);
  assert.ok(unitBad.unresolved.some((u) => u.reason === 'uncovered-identifier:free'));

  const fnPtrUse = [
    '#include <stdlib.h>',
    'void * take_free_ptr(void)',
    '{',
    '    return (void *)&free;',
    '}',
  ].join('\n');
  const unitGood = buildCTranslationUnit([
    { address: 0x9100n, name: 'take_free_ptr', signature: 'void * take_free_ptr(void)', pseudocode: fnPtrUse },
  ]);
  assert.equal(unitGood.functions[0].syntaxOnly, false, JSON.stringify(unitGood.unresolved));
});

test('measure-g skips static inline helpers in inferInlineSignature and rejects placeholder-only cases', async () => {
  const fnWithHelper = makeResult([
    { kind: 'sig', indent: 0, text: 'int64_t real_target(uint64_t x)', row: 0, addr: 0xa000n },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'ctrl', indent: 1, text: 'return sext(x);' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]);
  closeFunctionOutput(fnWithHelper);

  // Brace-on-signature-line after static inline helper exercises inferInlineSignature skipping static inline.
  const braceOnSig = fnWithHelper.pseudocode.replace('int64_t real_target(uint64_t x)\n{', 'int64_t real_target(uint64_t x) {');
  const meta = {};
  const source = reconstructSource([{ address: '0xa000', pseudocode: braceOnSig }], meta);
  assert.equal(typeof source, 'string');
  assert.match(source, /int64_t real_target\(uint64_t x\)/);
  assert.equal(meta.syntaxOnlyCount, 0);
  assert.equal(meta.faithfulCount, 1);

  const placeholderOnly = reconstructTranslationUnit([
    { address: '0xa100', name: 'unfaith', pseudocode: 'int unfaith(void)\n{\n  return undeclared_xyz + 1;\n}' },
  ]);
  assert.equal(placeholderOnly.syntaxOnlyCount, 1);
  assert.equal(placeholderOnly.faithfulCount, 0);

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-measure-g-placeholder-'));
  try {
    const runCase = createGCaseRunner({
      clang: HOST_CC || 'clang',
      tmpRoot,
      runSubject: async () => ({
        row: {
          state: 'PASS',
          reason: null,
          functions: [
            { address: '0xa100', name: 'unfaith', state: 'PASS', pseudocode: 'int unfaith(void)\n{\n  return undeclared_xyz + 1;\n}' },
          ],
        },
      }),
    });
    const outcome = await runCase({ id: 'placeholder-only', path: '/unused' });
    assert.equal(outcome.state, 'FAIL');
    assert.equal(outcome.reason, 'syntax-only-placeholders');
    assert.equal(outcome.functions.extra.syntaxOnlyCount, 1);
    assert.equal(outcome.functions.extra.faithfulCount, 0);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
