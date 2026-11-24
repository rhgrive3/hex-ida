import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { closeFunctionOutput } from '../js/decompiler/c-output-closure.js';

function findGcc() {
  for (const cc of ['gcc', 'clang']) {
    try {
      execFileSync(cc, ['--version'], { stdio: ['ignore', 'ignore', 'ignore'] });
      return cc;
    } catch { /* try next */ }
  }
  return null;
}

const CC = findGcc();

function strictGccCompileOk(code, extraPrelude = '') {
  if (!CC) return { skipped: true, ok: true, stderr: '' };
  const source = extraPrelude ? `${extraPrelude}\n${code}` : code;
  try {
    execFileSync(CC, [
      '-x', 'c',
      '-std=gnu11',
      '-O0',
      '-c',
      '-Werror=int-conversion',
      '-Werror=implicit-function-declaration',
      '-Werror=incompatible-pointer-types',
      '-o', '/dev/null',
      '-',
    ], {
      input: source,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { skipped: false, ok: true, stderr: '' };
  } catch (err) {
    return { skipped: false, ok: false, stderr: String(err.stderr || err.message || '') };
  }
}

function makeResult(lines, extra = {}) {
  return {
    lines,
    pseudocode: lines.map((l) => `${'    '.repeat(l.indent || 0)}${l.text}`).join('\n'),
    ...extra,
  };
}

test('RC #1: bitwise ops wrap pointer and float operands while preserving string literals', () => {
  const res = makeResult([
    { kind: 'sig', indent: 0, text: 'uint64 rc1_bitwise(uint64 a1, double d1)', row: 0, addr: 0x1000n },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'decl', indent: 1, text: 'uint64 var_20 = a1;' },
    { kind: 'stmt', indent: 1, text: 'uint64 s1 = "immortal_str" - 32 | 0x8000000000000000ULL;' },
    { kind: 'stmt', indent: 1, text: 'uint64 s2 = &var_20 | global_10163D520;' },
    { kind: 'stmt', indent: 1, text: 'uint64 s3 = d1 & 0xFFULL;' },
    { kind: 'stmt', indent: 1, text: 'uint64 s4 = ~(&var_20);' },
    { kind: 'stmt', indent: 1, text: 'const char *msg = "keep | literal & intact";' },
    { kind: 'stmt', indent: 1, text: 'return s1 + s2 + s3 + s4 + (uintptr_t)msg;' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]);

  closeFunctionOutput(res);

  assert.match(res.pseudocode, /\(uintptr_t\)\("immortal_str" - 32\)\s*\|\s*0x8000000000000000ULL/);
  assert.match(res.pseudocode, /\(uintptr_t\)\(&var_20\)\s*\|\s*global_10163D520/);
  assert.match(res.pseudocode, /\(uint64\)\(d1\)\s*&\s*0xFFULL/);
  assert.match(res.pseudocode, /~\(uintptr_t\)\(\(&var_20\)\)/);
  assert.ok(res.pseudocode.includes('"keep | literal & intact"'), 'string literal containing | must remain unchanged');

  const chk = strictGccCompileOk(res.pseudocode);
  assert.equal(chk.ok, true, chk.stderr);
});

test('RC #2: single-line control braced blocks recurse into inner statements and preserve compound literals / initializers', () => {
  const res = makeResult([
    { kind: 'sig', indent: 0, text: 'uint64 rc2_control_blocks(uint64 c, void *p, uint64 i, uint64 x)', row: 0, addr: 0x2000n },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'decl', indent: 1, text: 'uint64 phi_1 = 0;' },
    { kind: 'decl', indent: 1, text: 'uint64 phi_2 = 0;' },
    { kind: 'decl', indent: 1, text: 'void *p2 = 0;' },
    { kind: 'decl', indent: 1, text: 'int arr[2] = { 1, 2 };' },
    { kind: 'stmt', indent: 1, text: 'double bitcast_val = (union { uint64_t u; double f; }){ .u = x }.f;' },
    { kind: 'stmt', indent: 1, text: 'if (c) { phi_1 = &global_2000; phi_2 = p; p2 = i; goto loc_done; }' },
    { kind: 'stmt', indent: 1, text: "if (c == ')') { phi_1 = &global_2000; }" },
    { kind: 'stmt', indent: 1, text: 'if (c /* ) */) { phi_2 = &global_2000; }' },
    { kind: 'stmt', indent: 1, text: 'if (c) { phi_1 = &global_2000; } else phi_2 = &global_2008;' },
    { kind: 'ctrl', indent: 1, text: 'switch (c) {' },
    { kind: 'stmt', indent: 2, text: 'case 1: { phi_1 = &global_2000; break; }' },
    { kind: 'stmt', indent: 2, text: 'default: { phi_2 = &global_2008; break; }' },
    { kind: 'ctrl', indent: 1, text: '}' },
    { kind: 'stmt', indent: 1, text: 'do { phi_1 = &global_2000; } while (0);' },
    { kind: 'label', indent: 0, text: 'loc_done:' },
    { kind: 'stmt', indent: 1, text: 'return phi_1 + phi_2 + (uintptr_t)p2 + (uint64)arr[0] + (uint64)bitcast_val;' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]);

  closeFunctionOutput(res);

  assert.ok(res.pseudocode.includes('int arr[2] = { 1, 2 };'), 'array initializer must remain intact');
  assert.ok(
    res.pseudocode.includes('(union { uint64_t u; double f; }){ .u = x }.f'),
    'anonymous union compound literal must remain intact',
  );
  assert.ok(
    res.pseudocode.includes('if (c) { phi_1 = (uintptr_t)(&global_2000); phi_2 = (uintptr_t)(p); p2 = (void *)(uintptr_t)(i); goto loc_done; }'),
    'if single-line block statements must all be coerced',
  );
  assert.ok(
    res.pseudocode.includes("if (c == ')') { phi_1 = (uintptr_t)(&global_2000); }"),
    "char literal ')' inside if condition must not break control block detection",
  );
  assert.ok(
    res.pseudocode.includes('if (c /* ) */) { phi_2 = (uintptr_t)(&global_2000); }'),
    'comment containing ) inside if condition must not break control block detection',
  );
  assert.ok(
    res.pseudocode.includes('if (c) { phi_1 = (uintptr_t)(&global_2000); } else phi_2 = (uintptr_t)(&global_2008);'),
    'trailing else statement after braced if block must preserve semicolon and coerce',
  );
  assert.ok(
    res.pseudocode.includes('case 1: { phi_1 = (uintptr_t)(&global_2000); break; }'),
    'case label followed by braced block must be coerced',
  );
  assert.ok(
    res.pseudocode.includes('default: { phi_2 = (uintptr_t)(&global_2008); break; }'),
    'default label followed by braced block must be coerced',
  );
  assert.ok(
    res.pseudocode.includes('do { phi_1 = (uintptr_t)(&global_2000); } while (0);'),
    'do-while single-line block must be coerced',
  );

  const chk = strictGccCompileOk(res.pseudocode);
  assert.equal(chk.ok, true, chk.stderr);
});

test('RC #3: memcmp mixed ternary harmonizes before pointer arg cast, and printf preserves trailing block comment', () => {
  const res = makeResult([
    { kind: 'sig', indent: 0, text: 'int rc3_builtin_args(void *a1, int32 x24, void *buf, uint64 n, uint64 phi_806)', row: 0, addr: 0x3000n },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'stmt', indent: 1, text: 'int cmp = memcmp((int32)(x24) < 0 ? *(uint64 *)(a1) : a1, buf, n);' },
    { kind: 'stmt', indent: 1, text: 'printf(phi_806 /* , varargs unknown */);' },
    { kind: 'stmt', indent: 1, text: 'printf("literal /* not a comment */");' },
    { kind: 'stmt', indent: 1, text: 'return cmp;' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]);

  closeFunctionOutput(res);

  assert.match(
    res.pseudocode,
    /memcmp\(\(const void \*\)\(uintptr_t\)\(\(int32\)\(x24\) < 0 \? \*\(uint64 \*\)\(a1\) : \(uintptr_t\)\(a1\)\), buf, n\)/,
  );
  assert.ok(
    res.pseudocode.includes('printf((const char *)(uintptr_t)(phi_806) /* , varargs unknown */);'),
    'printf integer arg with trailing block comment must cast core and preserve comment',
  );
  assert.ok(
    res.pseudocode.includes('printf("literal /* not a comment */");'),
    'string literal containing /* */ must not be misclassified or mutated',
  );

  const chk = strictGccCompileOk(res.pseudocode);
  assert.equal(chk.ok, true, chk.stderr);
});

test('RC #4: float/double deref store, scalar/decl assignment, and float return coerce pointer values cleanly', () => {
  const res = makeResult([
    { kind: 'sig', indent: 0, text: 'double rc4_float_ptr(uint64 sp)', row: 0, addr: 0x4000n },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'decl', indent: 1, text: 'double phi_651 = "submsg size changed";' },
    { kind: 'decl', indent: 1, text: 'float f_var = 0.0f;' },
    { kind: 'stmt', indent: 1, text: '*(double *)(uintptr_t)(sp - 112) = &global_100836738;' },
    { kind: 'stmt', indent: 1, text: '*(float *)(uintptr_t)(sp - 64) = &global_100836738;' },
    { kind: 'stmt', indent: 1, text: 'phi_651 = "stream full";' },
    { kind: 'stmt', indent: 1, text: 'f_var = "short";' },
    { kind: 'stmt', indent: 1, text: 'if (sp) return phi_651 + (double)f_var;' },
    { kind: 'stmt', indent: 1, text: 'return "x";' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]);

  closeFunctionOutput(res);

  assert.ok(
    res.pseudocode.includes('double phi_651 = (double)(uintptr_t)("submsg size changed");'),
    'double decl initializer with pointer RHS must cast via (double)(uintptr_t)',
  );
  assert.ok(
    res.pseudocode.includes('*(uint64_t *)(uintptr_t)(sp - 112) = (uintptr_t)(&global_100836738);'),
    'double pointer deref store must rewrite to *(uint64_t *) = (uintptr_t)(...)',
  );
  assert.ok(
    res.pseudocode.includes('*(uint32_t *)(uintptr_t)(sp - 64) = (uint32_t)(uintptr_t)(&global_100836738);'),
    'float pointer deref store must rewrite to *(uint32_t *) = (uint32_t)(uintptr_t)(...)',
  );
  assert.ok(
    res.pseudocode.includes('phi_651 = (double)(uintptr_t)("stream full");'),
    'double scalar assignment with pointer RHS must cast via (double)(uintptr_t)',
  );
  assert.ok(
    res.pseudocode.includes('f_var = (float)(uintptr_t)("short");'),
    'float scalar assignment with pointer RHS must cast via (float)(uintptr_t)',
  );
  assert.ok(
    res.pseudocode.includes('return (double)(uintptr_t)("x");'),
    'double function returning pointer must cast via (double)(uintptr_t)',
  );

  const chk = strictGccCompileOk(res.pseudocode);
  assert.equal(chk.ok, true, chk.stderr);
});

test('RC #5: STDLIB_REQUIRED_ARG_DEFAULTS fills 0-arg calls and does not pollute normal calls with selfCallSpec', () => {
  const res = makeResult([
    { kind: 'sig', indent: 0, text: 'uint64 rc5_stdlib_defaults(void *p1, uint64 n)', row: 0, addr: 0x5000n },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'stmt', indent: 1, text: 'uint64 r1 = arc4random_uniform(/* arguments unknown */);' },
    { kind: 'stmt', indent: 1, text: 'uint64 r2 = arc4random_uniform(10);' },
    { kind: 'stmt', indent: 1, text: 'void *m1 = malloc(/* arguments unknown */);' },
    { kind: 'stmt', indent: 1, text: 'void *m2 = malloc(64);' },
    { kind: 'stmt', indent: 1, text: 'free(/* arguments unknown */);' },
    { kind: 'stmt', indent: 1, text: 'return r1 + r2 + (uintptr_t)m1 + (uintptr_t)m2 + (uintptr_t)p1 + n;' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]);

  closeFunctionOutput(res);

  assert.ok(
    res.pseudocode.includes('arc4random_uniform(0 /* default arg */)'),
    'arc4random_uniform(/* arguments unknown */) must receive default arg',
  );
  assert.ok(
    res.pseudocode.includes('arc4random_uniform(10);'),
    'arc4random_uniform(10) must not fall through to selfCallSpec.params[0] (void *)',
  );
  assert.ok(
    res.pseudocode.includes('malloc(0 /* default arg */)'),
    'malloc(/* arguments unknown */) must receive default arg',
  );
  assert.ok(
    res.pseudocode.includes('malloc(64);'),
    'malloc(64) must not fall through to selfCallSpec.params[0] (void *)',
  );
  assert.ok(
    res.pseudocode.includes('free((void *)0 /* default arg */)'),
    'free(/* arguments unknown */) must receive default arg',
  );

  // Provide arc4random_uniform prototype in case host glibc predates 2.36
  const chk = strictGccCompileOk(res.pseudocode, '#include <stdint.h>\nuint32_t arc4random_uniform(uint32_t);');
  assert.equal(chk.ok, true, chk.stderr);
});

test('RC #6 defense: sanitizeOversizedIntLiterals wraps >2^64-1 literals without double ULL or touching decimals/strings', () => {
  const res = makeResult([
    { kind: 'sig', indent: 0, text: 'uint64 rc6_oversized(uint64 sp)', row: 0, addr: 0x6000n },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'stmt', indent: 1, text: 'uint64 a = sp + 18446744073709551616;' },
    { kind: 'stmt', indent: 1, text: 'uint64 b = sp + 18446744073709551624;' },
    { kind: 'stmt', indent: 1, text: 'uint64 c = 18446744073709551616ULL;' },
    { kind: 'stmt', indent: 1, text: 'uint64 d = 0x10000000000000008ULL;' },
    { kind: 'stmt', indent: 1, text: 'double frac = .123456789012345678901234;' },
    { kind: 'stmt', indent: 1, text: 'const char *s = "18446744073709551616";' },
    { kind: 'stmt', indent: 1, text: 'return a + b + c + d + (uint64)frac + (uintptr_t)s;' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]);

  closeFunctionOutput(res);

  assert.ok(res.pseudocode.includes('uint64 a = sp + 0ULL;'));
  assert.ok(res.pseudocode.includes('uint64 b = sp + 8ULL;'));
  assert.ok(res.pseudocode.includes('uint64 c = 0ULL;'), 'must consume existing ULL suffix and avoid 0ULLULL');
  assert.ok(!res.pseudocode.includes('ULLULL'), 'must never emit double ULL');
  assert.ok(res.pseudocode.includes('uint64 d = 0x8ULL;'));
  assert.ok(res.pseudocode.includes('double frac = .123456789012345678901234;'), 'decimal literal must remain untouched');
  assert.ok(res.pseudocode.includes('const char *s = "18446744073709551616";'), 'string literal must remain untouched');

  const chk = strictGccCompileOk(res.pseudocode);
  assert.equal(chk.ok, true, chk.stderr);
});

test('RC #7: parenthesized non-struct arrow accesses rewrite even when badArrowBases is empty, while protecting struct pointers', () => {
  // Case A: badArrowBases is completely empty (only a struct pointer parameter, no int/non-struct locals)
  const emptyBadBases = makeResult([
    { kind: 'decl', indent: 0, text: 'typedef struct { unsigned long long field_0; } hex_struct_foo;' },
    { kind: 'sig', indent: 0, text: 'uint64 rc7_empty_bad_bases(hex_struct_foo *p)', row: 0, addr: 0x7000n },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'stmt', indent: 1, text: 'if (!p) return (*(uint64_t *)(uintptr_t)((uintptr_t)p + 64))->field_10;' },
    { kind: 'stmt', indent: 1, text: 'return ((hex_struct_foo *)p)->field_0;' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]);

  closeFunctionOutput(emptyBadBases);

  assert.ok(
    emptyBadBases.pseudocode.includes('*(uint64 *)((uintptr_t)((*(uint64_t *)(uintptr_t)((uintptr_t)p + 64))) + 0x10)'),
    'parenthesized deref arrow after return keyword must rewrite even when badArrowBases is empty',
  );
  assert.ok(
    emptyBadBases.pseudocode.includes('((hex_struct_foo *)p)->field_0'),
    'legitimate struct pointer cast arrow access must be preserved',
  );

  const chkA = strictGccCompileOk(emptyBadBases.pseudocode);
  assert.equal(chkA.ok, true, chkA.stderr);

  // Case B: Shard 6 pattern, void_ptr, named field (chainKey = 'expr'), and nested call arg
  const fullCase = makeResult([
    { kind: 'sig', indent: 0, text: 'uint64 rc7_paren_arrows(uint64 sp, void *void_ptr, uint64 addr)', row: 0, addr: 0x7100n },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'stmt', indent: 1, text: 'uint64 v1 = (*(uint64_t *)(uintptr_t)((sp - 0xB0) + 64))->field_10;' },
    { kind: 'stmt', indent: 1, text: 'uint64 v2 = (void_ptr)->field_10;' },
    { kind: 'stmt', indent: 1, text: 'uint64 v3 = (addr + 8)->named_field;' },
    { kind: 'stmt', indent: 1, text: 'uint64 v4 = ((*(uint64_t *)(uintptr_t)addr)->field_10 + 1);' },
    { kind: 'stmt', indent: 1, text: 'if (v1) return (*(uint64_t *)(uintptr_t)addr)->field_10;' },
    { kind: 'stmt', indent: 1, text: 'return v1 + v2 + v3 + v4;' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]);

  closeFunctionOutput(fullCase);

  assert.ok(
    fullCase.pseudocode.includes('*(uint64 *)((uintptr_t)((*(uint64_t *)(uintptr_t)((sp - 0xB0) + 64))) + 0x10)'),
    'Shard 6 parenthesized uint64_t deref arrow must rewrite',
  );
  assert.ok(
    fullCase.pseudocode.includes('*(uint64 *)((uintptr_t)((void_ptr)) + 0x10)'),
    'parenthesized void_ptr arrow must rewrite',
  );
  assert.ok(
    fullCase.pseudocode.includes('((hex_struct_expr *)(uintptr_t)((addr + 8)))->named_field'),
    'parenthesized named_field arrow must synthesize hex_struct_expr',
  );
  assert.ok(
    fullCase.pseudocode.includes('typedef struct { uint64 named_field; } hex_struct_expr;'),
    'hex_struct_expr typedef must be emitted in prelude',
  );

  const chkB = strictGccCompileOk(fullCase.pseudocode);
  assert.equal(chkB.ok, true, chkB.stderr);
});
