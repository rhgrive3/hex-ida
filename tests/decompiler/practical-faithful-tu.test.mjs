import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { closeFunctionOutput } from '../../js/decompiler/c-output-closure.js';
import { buildCTranslationUnit } from '../../js/analysis/query/translation-unit.js';

function findCCompiler() {
  for (const cc of ['clang', 'gcc']) {
    try {
      execFileSync(cc, ['--version'], { stdio: ['ignore', 'ignore', 'ignore'] });
      return cc;
    } catch { /* try next */ }
  }
  return null;
}

const CC = findCCompiler();

function c11StrictCompileOk(code) {
  if (!CC) return { skipped: true, ok: true, stderr: '' };
  try {
    execFileSync(CC, ['-x', 'c', '-std=c11', '-Wall', '-Wextra', '-Werror', '-fsyntax-only', '-'], {
      input: code,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { skipped: false, ok: true, stderr: '' };
  } catch (err) {
    return { skipped: false, ok: false, stderr: String(err?.stderr ?? err?.message ?? err) };
  }
}

function makeClosureResult(lines, extra = {}) {
  return {
    lines,
    pseudocode: lines.map((l) => `${'    '.repeat(l.indent || 0)}${l.text}`).join('\n'),
    ...extra,
  };
}

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

function makeCallIr(target, name, callPrototype = null) {
  return { op: 'call', target, name, callPrototype };
}

test('hexIntrinsicHelperDef emits C11 warning-free __arm64_nzcv_fsub_(32|64) helpers and achieves faithful TU', () => {
  const res = makeClosureResult([
    { kind: 'sig', indent: 0, text: 'int cmp_fp(uint64 a, uint64 b)', row: 0, addr: 0x1000n },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'stmt', indent: 1, text: 'if (__arm64_nzcv_fsub_lt_64(a, b)) return 1;' },
    { kind: 'stmt', indent: 1, text: 'if (__arm64_nzcv_fsub_ge_32(a, b)) return 2;' },
    { kind: 'stmt', indent: 1, text: 'if (__arm64_nzcv_fsub_vs_64(a, b)) return 3;' },
    { kind: 'stmt', indent: 1, text: 'return 0;' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]);
  closeFunctionOutput(res);

  assert.match(res.pseudocode, /static inline int __arm64_nzcv_fsub_lt_64\(uint64_t a, uint64_t b\)/);
  assert.match(res.pseudocode, /union \{ uint64_t u; double f; \} ua = \{ a \}, ub = \{ b \};/);
  assert.match(res.pseudocode, /static inline int __arm64_nzcv_fsub_ge_32\(uint64_t a, uint64_t b\)/);
  assert.match(res.pseudocode, /union \{ uint32_t u; float f; \} ua = \{ \(uint32_t\)a \}, ub = \{ \(uint32_t\)b \};/);
  assert.match(res.pseudocode, /static inline int __arm64_nzcv_fsub_vs_64\(uint64_t a, uint64_t b\)/);

  const strictClosure = c11StrictCompileOk(res.pseudocode);
  assert.equal(strictClosure.ok, true, strictClosure.stderr);

  const unit = buildCTranslationUnit([makeFn(res.pseudocode, { name: 'cmp_fp' })]);
  assert.equal(unit.functions[0].syntaxOnly, false, JSON.stringify(unit.unresolved));
  assert.match(unit.source, /static inline int __arm64_nzcv_fsub_lt_64\(uint64_t a, uint64_t b\)/);

  const strictTu = c11StrictCompileOk(unit.source);
  assert.equal(strictTu.ok, true, strictTu.stderr);
});

test('hexIntrinsicHelperDef supports 8/16/32/64-bit integer add/sub/and NZCV helpers without warnings', () => {
  const res = makeClosureResult([
    { kind: 'sig', indent: 0, text: 'int cmp_int_widths(uint64 a, uint64 b)', row: 0, addr: 0x1100n },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'stmt', indent: 1, text: 'int r = 0;' },
    { kind: 'stmt', indent: 1, text: 'r += __arm64_nzcv_add_cs_8(a, b);' },
    { kind: 'stmt', indent: 1, text: 'r += __arm64_nzcv_sub_lt_16(a, b);' },
    { kind: 'stmt', indent: 1, text: 'r += __arm64_nzcv_and_eq_8(a, b);' },
    { kind: 'stmt', indent: 1, text: 'r += __arm64_nzcv_add_vs_16(a, b);' },
    { kind: 'stmt', indent: 1, text: 'r += __arm64_nzcv_sub_ge_32(a, b);' },
    { kind: 'stmt', indent: 1, text: 'r += __arm64_nzcv_and_ne_64(a, b);' },
    { kind: 'stmt', indent: 1, text: 'return r;' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]);
  closeFunctionOutput(res);

  assert.match(res.pseudocode, /static inline int __arm64_nzcv_add_cs_8\(uint64_t a, uint64_t b\) \{ uint8_t ua = \(uint8_t\)a, ub = \(uint8_t\)b;.*>> 7/);
  assert.match(res.pseudocode, /static inline int __arm64_nzcv_sub_lt_16\(uint64_t a, uint64_t b\) \{ uint16_t ua = \(uint16_t\)a, ub = \(uint16_t\)b;.*>> 15/);
  assert.match(res.pseudocode, /static inline int __arm64_nzcv_and_eq_8\(uint64_t a, uint64_t b\)/);

  const strictClosure = c11StrictCompileOk(res.pseudocode);
  assert.equal(strictClosure.ok, true, strictClosure.stderr);

  const unit = buildCTranslationUnit([makeFn(res.pseudocode, { name: 'cmp_int_widths' })]);
  assert.equal(unit.functions[0].syntaxOnly, false, JSON.stringify(unit.unresolved));

  const strictTu = c11StrictCompileOk(unit.source);
  assert.equal(strictTu.ok, true, strictTu.stderr);
});

test('applyLabelHygiene inserts empty statement for same-line labels before } and declarations without touching strings, comments, or ternaries', () => {
  const res = makeClosureResult([
    { kind: 'sig', indent: 0, text: 'int inline_labels(int a, int b)', row: 0, addr: 0x1200n },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'stmt', indent: 1, text: 'const char *msg = "loc_1: int x = 1;";' },
    { kind: 'stmt', indent: 1, text: '/* loc_fake: int y = 2; */' },
    { kind: 'stmt', indent: 1, text: 'int t = a ? b : 0;' },
    { kind: 'stmt', indent: 1, text: '(void)msg;' },
    { kind: 'stmt', indent: 1, text: 'if (a == 1) goto loc_1;' },
    { kind: 'stmt', indent: 1, text: 'if (a == 2) goto loc_expr;' },
    { kind: 'stmt', indent: 1, text: 'if (a == 3) goto loc_end;' },
    { kind: 'stmt', indent: 1, text: 'switch (a) {' },
    { kind: 'stmt', indent: 2, text: 'case 0: int x = 1; (void)x; break;' },
    { kind: 'stmt', indent: 2, text: 'default: }' },
    { kind: 'stmt', indent: 1, text: 'loc_1: int z = 2; (void)z;' },
    { kind: 'stmt', indent: 1, text: 'loc_expr: t += 1;' },
    { kind: 'stmt', indent: 1, text: 'return t;' },
    { kind: 'stmt', indent: 1, text: 'loc_end: }' },
  ]);
  closeFunctionOutput(res);

  assert.ok(res.pseudocode.includes('case 0: ; int x = 1; (void)x; break;'), res.pseudocode);
  assert.ok(res.pseudocode.includes('default: ; }'), res.pseudocode);
  assert.ok(res.pseudocode.includes('loc_1: ; int z = 2; (void)z;'), res.pseudocode);
  assert.ok(res.pseudocode.includes('loc_end: ; }'), res.pseudocode);
  // Untouched cases
  assert.ok(res.pseudocode.includes('const char *msg = "loc_1: int x = 1;";'));
  assert.ok(res.pseudocode.includes('/* loc_fake: int y = 2; */'));
  assert.ok(res.pseudocode.includes('int t = a ? b : 0;'));
  assert.ok(res.pseudocode.includes('loc_expr: t += 1;'));

  const syntax = CC
    ? (() => {
      try {
        execFileSync(CC, ['-x', 'c', '-std=c11', '-fsyntax-only', '-'], { input: res.pseudocode, stdio: ['pipe', 'pipe', 'pipe'] });
        return { ok: true, stderr: '' };
      } catch (err) {
        return { ok: false, stderr: String(err?.stderr ?? err?.message ?? err) };
      }
    })()
    : { ok: true, stderr: '' };
  assert.equal(syntax.ok, true, syntax.stderr);

  // Strictly idempotent on second call
  const once = res.pseudocode;
  closeFunctionOutput(res);
  assert.equal(res.pseudocode, once);
});

test('SAFE_COMPILER_BUILTINS permits __builtin_expect and __builtin_unreachable in faithful TU', () => {
  const src = [
    'int check_builtin(int x)',
    '{',
    '  if (__builtin_expect(x != 0, 1)) {',
    '    return x;',
    '  }',
    '  __builtin_unreachable();',
    '}',
  ].join('\n');
  const unit = buildCTranslationUnit([makeFn(src, { name: 'check_builtin' })]);
  assert.equal(unit.functions[0].syntaxOnly, false, JSON.stringify(unit.unresolved));
  assert.ok(!unit.source.includes('extern uint64_t __builtin_expect'));
  assert.ok(!unit.source.includes('extern uint64_t __builtin_unreachable'));
});

test('knownAliases permits __int128 and __fp16 without uncovered-identifier rejection', () => {
  const src = [
    'uint64 use_ext_types(uint64 a)',
    '{',
    '  __int128 wide = (__int128)a;',
    '  __fp16 *hp = (__fp16 *)0;',
    '  (void)hp;',
    '  return (uint64)wide;',
    '}',
  ].join('\n');
  const unit = buildCTranslationUnit([makeFn(src, { name: 'use_ext_types' })]);
  assert.equal(unit.functions[0].syntaxOnly, false, JSON.stringify(unit.unresolved));
});

test('zero-arg (void) callees are accepted in faithful TU while explicit /* arguments unknown */ and non-zero arity remain rejected', () => {
  const okSrc = [
    'uint64 call_zero(void)',
    '{',
    '  return get_zero() + helper_zero();',
    '}',
  ].join('\n');
  const helperSrc = [
    'uint64 helper_zero(void)',
    '{',
    '  return 42;',
    '}',
  ].join('\n');
  const okUnit = buildCTranslationUnit([
    makeFn(okSrc, {
      address: 0x2000n,
      name: 'call_zero',
      ir: {
        instructions: [
          makeCallIr(0x3000n, 'get_zero', { returnType: 'uint64_t', parameters: [], exact: true }),
          makeCallIr(0x2100n, 'helper_zero'),
        ],
      },
    }),
    makeFn(helperSrc, { address: 0x2100n, name: 'helper_zero' }),
  ]);
  assert.equal(okUnit.functions[0].syntaxOnly, false, JSON.stringify(okUnit.unresolved));
  assert.equal(okUnit.functions[1].syntaxOnly, false, JSON.stringify(okUnit.unresolved));

  // Explicit /* arguments unknown */ comment must still fail against (void) prototype
  const unknownCommentSrc = [
    'uint64 call_unknown(void)',
    '{',
    '  return get_zero(/* arguments unknown */);',
    '}',
  ].join('\n');
  const unknownUnit = buildCTranslationUnit([
    makeFn(unknownCommentSrc, {
      address: 0x2200n,
      name: 'call_unknown',
      ir: {
        instructions: [
          makeCallIr(0x3000n, 'get_zero', { returnType: 'uint64_t', parameters: [], exact: true }),
        ],
      },
    }),
  ]);
  assert.equal(unknownUnit.functions[0].syntaxOnly, true);
  assert.ok(unknownUnit.unresolved.some((u) => u.reason === 'arity-unknown-call-contradicts-prototype:get_zero'));

  // Non-zero arity prototype called with () must still fail
  const mismatchSrc = [
    'uint64 call_mismatch(void)',
    '{',
    '  return need_one();',
    '}',
  ].join('\n');
  const mismatchUnit = buildCTranslationUnit([
    makeFn(mismatchSrc, {
      address: 0x2300n,
      name: 'call_mismatch',
      ir: {
        instructions: [
          makeCallIr(0x3100n, 'need_one', { returnType: 'uint64_t', parameters: [{ type: 'uint64_t', name: 'a' }], exact: true }),
        ],
      },
    }),
  ]);
  assert.equal(mismatchUnit.functions[0].syntaxOnly, true);
  assert.ok(mismatchUnit.unresolved.some((u) => u.reason === 'arity-unknown-call-contradicts-prototype:need_one'));
});

test('fallbackArrayGlobals accepts & global_X, &(global_X), sizeof(global_X) while rejecting scalar assignment and && global_X', () => {
  const okSrc = [
    'uint64 addr_and_size(void)',
    '{',
    '  void *p1 = & global_5000;',
    '  void *p2 = &(global_5000);',
    '  uint64 sz = sizeof(global_5000);',
    '  (void)p1;',
    '  (void)p2;',
    '  return sz;',
    '}',
  ].join('\n');
  const okUnit = buildCTranslationUnit([makeFn(okSrc, { name: 'addr_and_size' })]);
  assert.equal(okUnit.functions[0].syntaxOnly, false, JSON.stringify(okUnit.unresolved));

  // Existing contract: untyped scalar assignment global_5000 = 1; must stay syntaxOnly
  const scalarAssignSrc = [
    'void write_untyped_global(void)',
    '{',
    '  global_5000 = 1;',
    '}',
  ].join('\n');
  const scalarUnit = buildCTranslationUnit([makeFn(scalarAssignSrc, { name: 'write_untyped_global' })]);
  assert.equal(scalarUnit.functions[0].syntaxOnly, true);
  assert.ok(scalarUnit.unresolved.some((u) => u.reason === 'global-byte-array-fallback-usage-unsupported:global_5000'));

  // Logical AND `&& global_5000` must NOT be misclassified as address-of
  const logicalAndSrc = [
    'int check_and(int cond)',
    '{',
    '  return cond && global_5000;',
    '}',
  ].join('\n');
  const logicalUnit = buildCTranslationUnit([makeFn(logicalAndSrc, { name: 'check_and' })]);
  assert.equal(logicalUnit.functions[0].syntaxOnly, true);
  assert.ok(logicalUnit.unresolved.some((u) => u.reason === 'global-byte-array-fallback-usage-unsupported:global_5000'));
});

test('hasRawObjcMessageSyntax skips C11 chained designated initializers while still rejecting real ObjC messages', () => {
  const chainedSrc = [
    'typedef struct { uint64 field; uint64 a; } hex_struct_entry;',
    'uint64 init_chained(void)',
    '{',
    '  hex_struct_entry arr[2] = { [0].field = 1, [(int)1].a = 2 };',
    '  return arr[0].field + arr[1].a;',
    '}',
  ].join('\n');
  const chainedUnit = buildCTranslationUnit([makeFn(chainedSrc, { name: 'init_chained' })]);
  assert.equal(chainedUnit.functions[0].syntaxOnly, false, JSON.stringify(chainedUnit.unresolved));

  const nestedArraySrc = [
    'uint64 init_nested_idx(void)',
    '{',
    '  uint64 mat[2][2] = { [(int)0][1] = 7 };',
    '  return mat[0][1];',
    '}',
  ].join('\n');
  const nestedUnit = buildCTranslationUnit([makeFn(nestedArraySrc, { name: 'init_nested_idx' })]);
  assert.equal(nestedUnit.functions[0].syntaxOnly, false, JSON.stringify(nestedUnit.unresolved));

  // Real ObjC message must still be rejected
  const objcSrc = [
    'uint64 call_objc(id obj)',
    '{',
    '  return [obj doWork:1];',
    '}',
  ].join('\n');
  const objcUnit = buildCTranslationUnit([makeFn(objcSrc, { name: 'call_objc' })]);
  assert.equal(objcUnit.functions[0].syntaxOnly, true);
  assert.ok(objcUnit.unresolved.some((u) => u.reason === 'objc-message-syntax-unavailable'));
});

test('hasStatementMacroCallShape permits qualified function pointer calls like (* const fp)(args)', () => {
  const src = [
    'uint64 call_qual_fp(uint64 a1)',
    '{',
    '  uint64 (*fp)(uint64) = 0;',
    '  return (* const fp)(a1);',
    '}',
  ].join('\n');
  const unit = buildCTranslationUnit([makeFn(src, { name: 'call_qual_fp' })]);
  assert.equal(unit.functions[0].syntaxOnly, false, JSON.stringify(unit.unresolved));
});

test('existing contract: undefined goto label remains syntaxOnly', () => {
  const src = [
    'uint64 bad_goto(uint64 a1)',
    '{',
    '  if (a1) goto somewhere;',
    '  return 0;',
    '}',
  ].join('\n');
  const unit = buildCTranslationUnit([makeFn(src, { name: 'bad_goto' })]);
  assert.equal(unit.functions[0].syntaxOnly, true);
  assert.ok(unit.unresolved.some((u) => u.reason === 'goto-syntax-unavailable'));
});
