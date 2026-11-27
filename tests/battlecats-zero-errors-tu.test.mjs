import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildCTranslationUnit, parseSignatureArity } from '../js/analysis/query/translation-unit.js';

const FIXED_WIDTH_PRELUDE = [
  '/* hex: fixed-width integer types (self-contained; standard names stay identical to <stdint.h>). */',
  'typedef __UINT64_TYPE__ uint64;',
].join('\n');

const HEX_ANY_ARGS_PRELUDE = [
  '/* hex: standalone external prototypes (stripped by translation unit packager). */',
  '#ifndef __HEX_ANY_ARGS',
  '#if defined(__STDC_VERSION__) && __STDC_VERSION__ >= 202311L',
  '#define __HEX_ANY_ARGS ...',
  '#else',
  '#define __HEX_ANY_ARGS',
  '#endif',
  '#endif',
].join('\n');

function makeFn(pseudocode, extra = {}) {
  const sigLine = pseudocode
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => /^[A-Za-z_][A-Za-z0-9_\s*]*\s+[A-Za-z_][A-Za-z0-9_]*\s*\([^;{}]*\)\s*$/.test(l));
  return {
    address: 0x1000n,
    name: 'sample',
    signature: sigLine ?? pseudocode.split(/\r?\n/, 1)[0],
    pseudocode,
    ...extra,
  };
}

function compileStrictGcc(source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-tu-zero-err-'));
  const cPath = path.join(dir, 'unit.c');
  const oPath = path.join(dir, 'unit.o');
  try {
    fs.writeFileSync(cPath, source, 'utf8');
    execFileSync(
      'gcc',
      [
        '-std=gnu11',
        '-O0',
        '-c',
        '-Werror=int-conversion',
        '-Werror=implicit-function-declaration',
        '-Werror=incompatible-pointer-types',
        cPath,
        '-o',
        oPath,
      ],
      { stdio: 'pipe', encoding: 'utf8' },
    );
    return { ok: true, stderr: '' };
  } catch (err) {
    return { ok: false, stderr: String(err?.stderr ?? err?.message ?? err) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('§5.3 parseSignatureArity handles fixed, void, variadic, unprototyped, __HEX_ANY_ARGS, and function-pointer param/return declarations', () => {
  assert.deepEqual(parseSignatureArity('uint64 callee(uint64 a1, uint64 a2);', 'callee'), { min: 2, max: 2 });
  assert.deepEqual(parseSignatureArity('void fallback_fn(void);', 'fallback_fn'), { min: 0, max: 0 });
  assert.equal(parseSignatureArity('uint64 unproto_fn();', 'unproto_fn'), null);
  assert.equal(parseSignatureArity('uint64 any_fn(__HEX_ANY_ARGS);', 'any_fn'), null);
  assert.deepEqual(parseSignatureArity('int var_log(const char *fmt, ...);', 'var_log'), { min: 1, max: Infinity });
  assert.deepEqual(parseSignatureArity('int var_two(const char *fmt, int n, ...);', 'var_two'), { min: 2, max: Infinity });
  assert.deepEqual(
    parseSignatureArity('uint64 with_cb(uint64 a1, void (*cb)(int, int));', 'with_cb'),
    { min: 2, max: 2 },
  );
  assert.deepEqual(
    parseSignatureArity('void (*ret_fp(uint64 a1, uint64 a2))(int, int, int);', 'ret_fp'),
    { min: 2, max: 2 },
  );
  assert.deepEqual(
    parseSignatureArity('void (*signal(int sig, void (*func)(int)))(int);', 'signal'),
    { min: 2, max: 2 },
  );
});

test('§5.3 selected sibling 4-arg and 1-arg calls to 2-arg callee fail closed with call-arity-mismatch and compile cleanly under strict GCC', () => {
  const calleeSrc = [
    FIXED_WIDTH_PRELUDE,
    'uint64 callee(uint64 a1, uint64 a2)',
    '{',
    '  return a1 + a2;',
    '}',
  ].join('\n');
  const tooManyCallerSrc = [
    FIXED_WIDTH_PRELUDE,
    'uint64 caller_many(uint64 x0, uint64 x1, uint64 x2, uint64 x3)',
    '{',
    '  return callee(x0, x1, x2, x3);',
    '}',
  ].join('\n');
  const tooFewCallerSrc = [
    FIXED_WIDTH_PRELUDE,
    'uint64 caller_few(uint64 x0)',
    '{',
    '  return callee(x0);',
    '}',
  ].join('\n');
  const okCallerSrc = [
    FIXED_WIDTH_PRELUDE,
    'uint64 caller_ok(uint64 x0, uint64 x1)',
    '{',
    '  return callee(x0, x1);',
    '}',
  ].join('\n');

  const unit = buildCTranslationUnit([
    makeFn(calleeSrc, { address: 0x1000n, name: 'callee' }),
    makeFn(tooManyCallerSrc, { address: 0x1100n, name: 'caller_many' }),
    makeFn(tooFewCallerSrc, { address: 0x1200n, name: 'caller_few' }),
    makeFn(okCallerSrc, { address: 0x1300n, name: 'caller_ok' }),
  ]);

  const byName = new Map(unit.functions.map((f) => [f.name, f]));
  assert.equal(byName.get('callee').syntaxOnly, false);
  assert.equal(byName.get('caller_ok').syntaxOnly, false);
  assert.equal(byName.get('caller_many').syntaxOnly, true);
  assert.equal(byName.get('caller_few').syntaxOnly, true);
  assert.ok(
    unit.unresolved.some((u) => u.subject === 'caller_many' && u.reason === 'call-arity-mismatch:callee'),
    JSON.stringify(unit.unresolved),
  );
  assert.ok(
    unit.unresolved.some((u) => u.subject === 'caller_few' && u.reason === 'call-arity-mismatch:callee'),
    JSON.stringify(unit.unresolved),
  );

  const gcc = compileStrictGcc(unit.source);
  assert.equal(gcc.ok, true, `GCC failed:\n${gcc.stderr}\n--- SOURCE ---\n${unit.source}`);
});

test('§5.3 fallback void fallback_fn(void) selected function rejects 1-arg call with call-arity-mismatch and compiles cleanly under strict GCC', () => {
  const fallbackSrc = [
    'unknown_type fallback_fn(bad_type x)',
    '{',
    '  return x;',
    '}',
  ].join('\n');
  const callerSrc = [
    FIXED_WIDTH_PRELUDE,
    'uint64 caller_of_fallback(uint64 a1)',
    '{',
    '  fallback_fn(a1);',
    '  return a1;',
    '}',
  ].join('\n');

  const unit = buildCTranslationUnit([
    makeFn(fallbackSrc, { address: 0x2000n, name: 'fallback_fn', signature: 'unknown_type fallback_fn(bad_type x)' }),
    makeFn(callerSrc, { address: 0x2100n, name: 'caller_of_fallback' }),
  ]);

  const byName = new Map(unit.functions.map((f) => [f.name, f]));
  assert.equal(byName.get('fallback_fn').syntaxOnly, true);
  assert.equal(byName.get('caller_of_fallback').syntaxOnly, true);
  assert.ok(
    unit.unresolved.some((u) => u.subject === 'caller_of_fallback' && u.reason === 'call-arity-mismatch:fallback_fn'),
    JSON.stringify(unit.unresolved),
  );
  assert.match(unit.source, /void fallback_fn\(void\);/);

  const gcc = compileStrictGcc(unit.source);
  assert.equal(gcc.ok, true, `GCC failed:\n${gcc.stderr}\n--- SOURCE ---\n${unit.source}`);
});

test('§5.3 single string literal and char literal arguments stay faithful and do not false-trigger arityUnknownCalls or knownArityBounds', () => {
  const calleeStrSrc = [
    FIXED_WIDTH_PRELUDE,
    'uint64 callee_str(const char * s)',
    '{',
    '  return (uint64)(s != 0);',
    '}',
  ].join('\n');
  const calleeChSrc = [
    FIXED_WIDTH_PRELUDE,
    'uint64 callee_ch(int c)',
    '{',
    '  return (uint64)c;',
    '}',
  ].join('\n');
  const calleeTwoSrc = [
    FIXED_WIDTH_PRELUDE,
    'uint64 callee_two(const char * s, uint64 n)',
    '{',
    '  return n + (uint64)(s != 0);',
    '}',
  ].join('\n');
  const goodCallerSrc = [
    FIXED_WIDTH_PRELUDE,
    'uint64 caller_literals(void)',
    '{',
    '  uint64 a = callee_str("hello");',
    '  uint64 b = callee_str(/* prefix */ "/* not a comment */" /* suffix */);',
    '  uint64 c = callee_ch(\'a\');',
    '  printf("ok");',
    '  return a + b + c;',
    '}',
  ].join('\n');
  const badCallerSrc = [
    FIXED_WIDTH_PRELUDE,
    'uint64 caller_literal_too_few(void)',
    '{',
    '  return callee_two("only_one");',
    '}',
  ].join('\n');

  const unit = buildCTranslationUnit([
    makeFn(calleeStrSrc, { address: 0x3000n, name: 'callee_str' }),
    makeFn(calleeChSrc, { address: 0x3100n, name: 'callee_ch' }),
    makeFn(calleeTwoSrc, { address: 0x3200n, name: 'callee_two' }),
    makeFn(goodCallerSrc, { address: 0x3300n, name: 'caller_literals' }),
    makeFn(badCallerSrc, { address: 0x3400n, name: 'caller_literal_too_few' }),
  ]);

  const byName = new Map(unit.functions.map((f) => [f.name, f]));
  assert.equal(byName.get('caller_literals').syntaxOnly, false, JSON.stringify(unit.unresolved));
  assert.equal(byName.get('caller_literal_too_few').syntaxOnly, true);
  assert.ok(
    unit.unresolved.some((u) => u.subject === 'caller_literal_too_few' && u.reason === 'call-arity-mismatch:callee_two'),
    JSON.stringify(unit.unresolved),
  );

  const gcc = compileStrictGcc(unit.source);
  assert.equal(gcc.ok, true, `GCC failed:\n${gcc.stderr}\n--- SOURCE ---\n${unit.source}`);
});

test('§5.3 nested callee(other(/* arguments unknown */), 1, 2) detects outer callee arity mismatch while matching arity stays faithful', () => {
  const calleeSrc = [
    FIXED_WIDTH_PRELUDE,
    'uint64 callee(uint64 a1, uint64 a2)',
    '{',
    '  return a1 + a2;',
    '}',
  ].join('\n');
  const nestedBadSrc = [
    FIXED_WIDTH_PRELUDE,
    'uint64 caller_nested_bad(void)',
    '{',
    '  return callee(other(/* arguments unknown */), 1, 2);',
    '}',
  ].join('\n');
  const nestedOkSrc = [
    FIXED_WIDTH_PRELUDE,
    'uint64 caller_nested_ok(void)',
    '{',
    '  return callee(other(/* arguments unknown */), 1);',
    '}',
  ].join('\n');

  const unit = buildCTranslationUnit([
    makeFn(calleeSrc, { address: 0x4000n, name: 'callee' }),
    makeFn(nestedBadSrc, { address: 0x4100n, name: 'caller_nested_bad' }),
    makeFn(nestedOkSrc, { address: 0x4200n, name: 'caller_nested_ok' }),
  ]);

  const byName = new Map(unit.functions.map((f) => [f.name, f]));
  assert.equal(byName.get('caller_nested_bad').syntaxOnly, true);
  assert.ok(
    unit.unresolved.some((u) => u.subject === 'caller_nested_bad' && u.reason === 'call-arity-mismatch:callee'),
    JSON.stringify(unit.unresolved),
  );
  assert.equal(byName.get('caller_nested_ok').syntaxOnly, false, JSON.stringify(unit.unresolved));

  const gcc = compileStrictGcc(unit.source);
  assert.equal(gcc.ok, true, `GCC failed:\n${gcc.stderr}\n--- SOURCE ---\n${unit.source}`);
});

test('§5.3 variadic, unprototyped (), __HEX_ANY_ARGS, and function-pointer casts stay faithful without false rejections', () => {
  const unprotoSelectedSrc = [
    FIXED_WIDTH_PRELUDE,
    'uint64 unproto_fn()',
    '{',
    '  return 7;',
    '}',
  ].join('\n');
  const callerFlexibleSrc = [
    FIXED_WIDTH_PRELUDE,
    HEX_ANY_ARGS_PRELUDE,
    'uint64 any_fn(__HEX_ANY_ARGS);',
    'uint64 caller_flex(uint64 a1)',
    '{',
    '  uint64 (*fp)(__HEX_ANY_ARGS) = (uint64 (*)(__HEX_ANY_ARGS))a1;',
    '  uint64 r1 = unproto_fn(a1, 1, 2, 3);',
    '  uint64 r2 = any_fn(a1, 1, 2, 3, 4);',
    '  uint64 r3 = var_log("msg", a1, 2);',
    '  uint64 r4 = var_log("only_fmt");',
    '  return r1 + r2 + r3 + r4 + fp(a1, 1, 2);',
    '}',
  ].join('\n');
  const callerVariadicTooFewSrc = [
    FIXED_WIDTH_PRELUDE,
    'uint64 caller_var_too_few(void)',
    '{',
    '  return var_two("only_one");',
    '}',
  ].join('\n');

  const unit = buildCTranslationUnit([
    makeFn(unprotoSelectedSrc, { address: 0x5000n, name: 'unproto_fn' }),
    makeFn(callerFlexibleSrc, {
      address: 0x5100n,
      name: 'caller_flex',
      ir: {
        instructions: [

          {
            op: 'call',
            target: 0x9000n,
            name: 'var_log',
            prototype: {
              returnType: 'uint64_t',
              parameters: [{ type: 'const char *', name: 'fmt' }],
              variadic: true,
            },
          },
          {
            op: 'call',
            target: 0x9100n,
            name: 'var_two',
            prototype: {
              returnType: 'uint64_t',
              parameters: [
                { type: 'const char *', name: 'fmt' },
                { type: 'uint64_t', name: 'n' },
              ],
              variadic: true,
            },
          },
        ],
      },
    }),
    makeFn(callerVariadicTooFewSrc, { address: 0x5200n, name: 'caller_var_too_few' }),
  ]);

  const byName = new Map(unit.functions.map((f) => [f.name, f]));
  assert.equal(byName.get('unproto_fn').syntaxOnly, false, JSON.stringify(unit.unresolved));
  assert.equal(byName.get('caller_flex').syntaxOnly, false, JSON.stringify(unit.unresolved));
  assert.equal(byName.get('caller_var_too_few').syntaxOnly, true);
  assert.ok(
    unit.unresolved.some((u) => u.subject === 'caller_var_too_few' && u.reason === 'call-arity-mismatch:var_two'),
    JSON.stringify(unit.unresolved),
  );

  const gcc = compileStrictGcc(unit.source);
  assert.equal(gcc.ok, true, `GCC failed:\n${gcc.stderr}\n--- SOURCE ---\n${unit.source}`);
});

test('§5.3 /* arguments unknown */ preserves existing arity-unknown-call-contradicts-selected-signature contract', () => {
  const calleeSrc = [
    FIXED_WIDTH_PRELUDE,
    'uint64 callee(uint64 a1, uint64 a2)',
    '{',
    '  return a1 + a2;',
    '}',
  ].join('\n');
  const callerSrc = [
    FIXED_WIDTH_PRELUDE,
    'uint64 caller_unknown(void)',
    '{',
    '  return callee(/* arguments unknown */);',
    '}',
  ].join('\n');

  const unit = buildCTranslationUnit([
    makeFn(calleeSrc, { address: 0x6000n, name: 'callee' }),
    makeFn(callerSrc, { address: 0x6100n, name: 'caller_unknown' }),
  ]);

  const byName = new Map(unit.functions.map((f) => [f.name, f]));
  assert.equal(byName.get('caller_unknown').syntaxOnly, true);
  assert.ok(
    unit.unresolved.some(
      (u) => u.subject === 'caller_unknown' && u.reason === 'arity-unknown-call-contradicts-selected-signature:callee',
    ),
    JSON.stringify(unit.unresolved),
  );

  const gcc = compileStrictGcc(unit.source);
  assert.equal(gcc.ok, true, `GCC failed:\n${gcc.stderr}\n--- SOURCE ---\n${unit.source}`);
});

test('§5.3 selected unprototyped () clears prior prototype knownArityBounds entry', () => {
  const unprotoSelectedSrc = [
    FIXED_WIDTH_PRELUDE,
    'uint64 unproto_override()',
    '{',
    '  return 7;',
    '}',
  ].join('\n');
  const callerSrc = [
    FIXED_WIDTH_PRELUDE,
    'uint64 caller_override(uint64 a1)',
    '{',
    '  return unproto_override(a1, 1, 2, 3);',
    '}',
  ].join('\n');
  const unit = buildCTranslationUnit([
    makeFn(unprotoSelectedSrc, { address: 0x5500n, name: 'unproto_override' }),
    makeFn(callerSrc, {
      address: 0x5600n,
      name: 'caller_override',
      ir: {
        instructions: [
          {
            op: 'call',
            target: 0x5500n,
            name: 'unproto_override',
            prototype: {
              returnType: 'uint64_t',
              parameters: [{ type: 'uint64_t', name: 'a1' }],
            },
          },
        ],
      },
    }),
  ]);
  const byName = new Map(unit.functions.map((f) => [f.name, f]));
  assert.equal(byName.get('caller_override').syntaxOnly, false, JSON.stringify(unit.unresolved));
});
