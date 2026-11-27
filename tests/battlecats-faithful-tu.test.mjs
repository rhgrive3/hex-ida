import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildCTranslationUnit } from '../js/analysis/query/translation-unit.js';

const FIXED_WIDTH_PRELUDE_COMMENT = '/* hex: fixed-width integer types (self-contained; standard names stay identical to <stdint.h>). */';
const STANDALONE_BINARY_GLOBALS_COMMENT = '/* hex: binary-backed global declarations (self-contained C output). */';
const STANDALONE_GLOBALS_COMMENT = '/* hex: standalone external globals (stripped by translation unit packager). */';
const STANDALONE_PROTOTYPES_COMMENT = '/* hex: standalone external prototypes (stripped by translation unit packager). */';

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

function compileWithGcc(source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-tu-track1-'));
  const cPath = path.join(dir, 'unit.c');
  const oPath = path.join(dir, 'unit.o');
  try {
    fs.writeFileSync(cPath, source, 'utf8');
    execFileSync(
      'gcc',
      ['-std=gnu11', '-Werror=int-conversion', '-Werror=implicit-function-declaration', '-O0', '-c', cPath, '-o', oPath],
      { stdio: 'pipe', encoding: 'utf8' },
    );
    return { ok: true, stderr: '' };
  } catch (err) {
    return { ok: false, stderr: String(err?.stderr ?? err?.message ?? err) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('§1.1 accepts defined labels and gotos, rejects undefined goto, duplicate label, computed goto, VLA+goto, and value misuse of label', () => {
  const validSource = [
    'uint64 sample(uint64 a1)',
    '{',
    '  if (a1 == 0) goto loc_done;',
    '  a1 = a1 + 1;',
    'loc_done:',
    '  return a1;',
    '}',
  ].join('\n');
  const validUnit = buildCTranslationUnit([makeFn(validSource)]);
  assert.equal(validUnit.functions[0].syntaxOnly, false, JSON.stringify(validUnit.unresolved));
  assert.match(validUnit.source, /goto loc_done;/);
  assert.match(validUnit.source, /loc_done:/);

  // Undefined goto -> goto-syntax-unavailable
  const undefSource = 'uint64 sample(uint64 a1)\n{\n  if (a1) goto somewhere;\n  return 0;\n}';
  const undefUnit = buildCTranslationUnit([makeFn(undefSource)]);
  assert.equal(undefUnit.functions[0].syntaxOnly, true);
  assert.ok(undefUnit.unresolved.some((u) => u.reason === 'goto-syntax-unavailable'));

  // Duplicate label -> duplicate-label-unavailable
  const dupSource = 'uint64 sample(uint64 a1)\n{\nloc_1:\n  a1++;\nloc_1:\n  return a1;\n}';
  const dupUnit = buildCTranslationUnit([makeFn(dupSource)]);
  assert.equal(dupUnit.functions[0].syntaxOnly, true);
  assert.ok(dupUnit.unresolved.some((u) => u.reason === 'duplicate-label-unavailable'));

  // Computed goto -> goto-syntax-unavailable
  const compSource = 'uint64 sample(void * p)\n{\n  goto *p;\n}';
  const compUnit = buildCTranslationUnit([makeFn(compSource)]);
  assert.equal(compUnit.functions[0].syntaxOnly, true);
  assert.ok(compUnit.unresolved.some((u) => u.reason === 'goto-syntax-unavailable'));

  // VLA + goto -> goto-syntax-unavailable
  const vlaGotoSource = [
    'uint64 sample(uint64 n)',
    '{',
    '  if (n == 0) goto loc_end;',
    '  uint8_t buf[n];',
    '  buf[0] = 1;',
    'loc_end:',
    '  return n;',
    '}',
  ].join('\n');
  const vlaUnit = buildCTranslationUnit([makeFn(vlaGotoSource)]);
  assert.equal(vlaUnit.functions[0].syntaxOnly, true);
  assert.ok(vlaUnit.unresolved.some((u) => u.reason === 'goto-syntax-unavailable'));

  // Label misused as value -> uncovered-identifier:loc_100
  const misuseSource = 'uint64 sample(uint64 a1)\n{\nloc_100:\n  return loc_100;\n}';
  const misuseUnit = buildCTranslationUnit([makeFn(misuseSource)]);
  assert.equal(misuseUnit.functions[0].syntaxOnly, true);
  assert.ok(misuseUnit.unresolved.some((u) => u.reason === 'uncovered-identifier:loc_100'));
});

test('§1.1 switch case/default do not trigger bitfield or label false positives, support chained label after case, and reject goto default', () => {
  const switchSource = [
    'uint64 sample(uint64 a1)',
    '{',
    '  switch (a1) {',
    '  case 0:',
    '  loc_100:',
    '    return 10;',
    '  case 1:',
    '    goto loc_100;',
    '  default:',
    '    return 99;',
    '  }',
    '}',
  ].join('\n');
  const unit = buildCTranslationUnit([makeFn(switchSource)]);
  assert.equal(unit.functions[0].syntaxOnly, false, JSON.stringify(unit.unresolved));

  // goto default; must be rejected because default is NOT registered in definedLabels
  const gotoDefaultSource = [
    'uint64 sample(uint64 a1)',
    '{',
    '  switch (a1) {',
    '  case 0:',
    '    goto default;',
    '  default:',
    '    return 1;',
    '  }',
    '}',
  ].join('\n');
  const gotoDefaultUnit = buildCTranslationUnit([makeFn(gotoDefaultSource)]);
  assert.equal(gotoDefaultUnit.functions[0].syntaxOnly, true);
  assert.ok(gotoDefaultUnit.unresolved.some((u) => u.reason === 'goto-syntax-unavailable'));
});

test('§1.1 rejects labels/case/default before closing brace or local declaration, accepts empty statement before brace and sizeof expr', () => {
  const cases = [
    ['normal label before }', 'void sample(void)\n{\nloc_end:\n}'],
    ['default before }', 'void sample(uint64 a1)\n{\n  switch (a1) {\n  default:\n  }\n}'],
    ['case before }', 'void sample(uint64 a1)\n{\n  switch (a1) {\n  case 0:\n  }\n}'],
    ['normal label before const decl', 'uint64 sample(uint64 a1)\n{\nloc_1:\n  const uint64 *p = 0;\n  return (uint64)p;\n}'],
    ['case before int decl', 'uint64 sample(uint64 a1)\n{\n  switch (a1) {\n  case 0:\n    int x = 1;\n    return (uint64)x;\n  default:\n    return 0;\n  }\n}'],
  ];
  for (const [label, src] of cases) {
    const unit = buildCTranslationUnit([makeFn(src)]);
    assert.equal(unit.functions[0].syntaxOnly, true, `${label} should fail closed`);
    assert.ok(
      unit.unresolved.some((u) => u.reason === 'label-syntax-unavailable'),
      `${label}: expected label-syntax-unavailable, got ${JSON.stringify(unit.unresolved)}`,
    );
  }

  // Empty statement before `}` is valid C11
  const emptyStmtSource = 'void sample(uint64 a1)\n{\n  if (a1) goto loc_end;\nloc_end:\n  ;\n}';
  const emptyStmtUnit = buildCTranslationUnit([makeFn(emptyStmtSource)]);
  assert.equal(emptyStmtUnit.functions[0].syntaxOnly, false, JSON.stringify(emptyStmtUnit.unresolved));

  // `sizeof x;` after label is NOT a local declaration and does NOT register `x` as local
  const sizeofAfterLabel = 'uint64 sample(uint64 a1)\n{\nloc_1:\n  sizeof a1;\n  return a1;\n}';
  const sizeofUnit = buildCTranslationUnit([makeFn(sizeofAfterLabel)]);
  assert.equal(sizeofUnit.functions[0].syntaxOnly, false, JSON.stringify(sizeofUnit.unresolved));

  const sizeofUnbound = 'uint64 sample(void)\n{\n  sizeof ghost_var;\n  return ghost_var;\n}';
  const sizeofUnboundUnit = buildCTranslationUnit([makeFn(sizeofUnbound)]);
  assert.equal(sizeofUnboundUnit.functions[0].syntaxOnly, true);
  assert.ok(sizeofUnboundUnit.unresolved.some((u) => u.reason === 'uncovered-identifier:ghost_var'));
});

test('§1.2 accepts uint128/int128/vector128 with FIXED_WIDTH_PRELUDE_COMMENT, rejects bare uint128 without leaking typedef, and hoists before synthesized structs', () => {
  // With marker -> accepted & typedef emitted
  const markedSource = [
    FIXED_WIDTH_PRELUDE_COMMENT,
    'typedef __UINT64_TYPE__ uint64;',
    'typedef unsigned __int128 uint128;',
    'typedef __int128 int128;',
    'typedef unsigned __int128 vector128;',
    'uint64 sample(uint64 a1)',
    '{',
    '  uint128 u = (uint128)a1;',
    '  int128 s = (int128)a1;',
    '  vector128 v = u + (vector128)s;',
    '  return (uint64)v;',
    '}',
  ].join('\n');
  const markedUnit = buildCTranslationUnit([makeFn(markedSource)]);
  assert.equal(markedUnit.functions[0].syntaxOnly, false, JSON.stringify(markedUnit.unresolved));
  assert.ok(markedUnit.typeDeclarations.includes('typedef unsigned __int128 uint128;'));
  assert.ok(markedUnit.typeDeclarations.includes('typedef __int128 int128;'));
  assert.ok(markedUnit.typeDeclarations.includes('typedef unsigned __int128 vector128;'));

  // Bare uint128 without marker -> body-prefix-unaccounted AND no leaked uint128 typedef
  const bareSource = [
    'typedef unsigned __int128 uint128;',
    'uint64 sample(uint64 a1)',
    '{',
    '  uint128 u = (uint128)a1;',
    '  return (uint64)u;',
    '}',
  ].join('\n');
  const bareUnit = buildCTranslationUnit([makeFn(bareSource)]);
  assert.equal(bareUnit.functions[0].syntaxOnly, true);
  assert.ok(bareUnit.unresolved.some((u) => u.reason === 'body-prefix-unaccounted'));
  assert.ok(!bareUnit.typeDeclarations.some((d) => d.includes('uint128')));

  // Synthesized struct + syntaxOnly signature using uint128: typedef must appear BEFORE synthesizedStructDecls
  const structSource = [
    FIXED_WIDTH_PRELUDE_COMMENT,
    'typedef __UINT64_TYPE__ uint64;',
    'typedef unsigned __int128 uint128;',
    '/* hex: synthesized member-base structs. */',
    'typedef struct { uint128 field_0; } hex_struct_a1;',
    'uint128 sample(hex_struct_a1 * a1)',
    '{',
    '  goto missing_label;',
    '  return a1->field_0;',
    '}',
  ].join('\n');
  const structUnit = buildCTranslationUnit([makeFn(structSource)]);
  assert.equal(structUnit.functions[0].syntaxOnly, true);
  const u128Idx = structUnit.source.indexOf('typedef unsigned __int128 uint128;');
  const structIdx = structUnit.source.indexOf('typedef struct { uint128 field_0; } hex_struct_a1;');
  assert.ok(u128Idx >= 0, 'uint128 typedef should be emitted');
  assert.ok(structIdx > u128Idx, 'uint128 typedef must precede synthesized struct typedef');
});

test('§1.2 hoists 7-line __HEX_ANY_ARGS guard immediately after includes and before declaredPrototypes, plus NULL/true/false/NAN/INFINITY headers', () => {
  const source = [
    FIXED_WIDTH_PRELUDE_COMMENT,
    'typedef __UINT64_TYPE__ uint64;',
    STANDALONE_PROTOTYPES_COMMENT,
    '#ifndef __HEX_ANY_ARGS',
    '#if defined(__STDC_VERSION__) && __STDC_VERSION__ >= 202311L',
    '#define __HEX_ANY_ARGS ...',
    '#else',
    '#define __HEX_ANY_ARGS',
    '#endif',
    '#endif',
    'uint64 ext_fn(__HEX_ANY_ARGS);',
    'uint64 sample(uint64 a1)',
    '{',
    '  void *p = NULL;',
    '  bool flag = true;',
    '  double d = NAN + INFINITY;',
    '  uint64 (*fp)(__HEX_ANY_ARGS) = (uint64 (*)(__HEX_ANY_ARGS))a1;',
    '  return (flag && p == NULL && d != 0.0) ? fp(a1) : ext_fn(a1);',
    '}',
  ].join('\n');
  const unit = buildCTranslationUnit([
    makeFn(source, {
      ir: {
        instructions: [
          {
            op: 'call',
            target: 0x2000n,
            name: 'ext_fn',
            callPrototype: { returnType: 'uint64', parameters: [{ type: 'uint64', name: 'x' }] },
          },
        ],
      },
    }),
  ]);
  assert.equal(unit.functions[0].syntaxOnly, false, JSON.stringify(unit.unresolved));
  assert.ok(unit.includes.includes('<stddef.h>'));
  assert.ok(unit.includes.includes('<stdbool.h>'));
  assert.ok(unit.includes.includes('<math.h>'));

  const lastIncludeIdx = unit.source.lastIndexOf('#include ');
  const guardIdx = unit.source.indexOf('#ifndef __HEX_ANY_ARGS');
  const protoIdx = unit.source.indexOf('uint64_t ext_fn(uint64_t x);');
  assert.ok(lastIncludeIdx >= 0 && guardIdx > lastIncludeIdx, '__HEX_ANY_ARGS guard must follow includes');
  assert.ok(protoIdx > guardIdx, '__HEX_ANY_ARGS guard must precede declaredPrototypes');

  // Verify exact 7-line guard with dual #endif
  const guardBlock = [
    '#ifndef __HEX_ANY_ARGS',
    '#if defined(__STDC_VERSION__) && __STDC_VERSION__ >= 202311L',
    '#define __HEX_ANY_ARGS ...',
    '#else',
    '#define __HEX_ANY_ARGS',
    '#endif',
    '#endif',
  ].join('\n');
  assert.ok(unit.source.includes(guardBlock));
});

test('§1.3 allows return cast and function pointer cast/decl while rejecting true statement-macro-call-shape MACRO(a)(b)', () => {
  const okSource = [
    'void * sample(uint64 a1)',
    '{',
    '  uint64 (*fp)(uint64) = (uint64 (*)(uint64))a1;',
    '  uint64 r = fp(a1);',
    '  return (void *)(uintptr_t)(r);',
    '}',
  ].join('\n');
  const okUnit = buildCTranslationUnit([makeFn(okSource)]);
  assert.equal(okUnit.functions[0].syntaxOnly, false, JSON.stringify(okUnit.unresolved));

  const badSource = [
    'uint64 sample(uint64 a1)',
    '{',
    '  return MACRO(a1)(1);',
    '}',
  ].join('\n');
  const badUnit = buildCTranslationUnit([makeFn(badSource)]);
  assert.equal(badUnit.functions[0].syntaxOnly, true);
  assert.ok(badUnit.unresolved.some((u) => u.reason === 'statement-macro-call-shape'));
});

test('§1.4 parses array locals, function pointer locals, per-declarator pointerLocals, for-init locals, and SAFE_COMPILER_BUILTINS', () => {
  // Array local + fn ptr local + for-init local + compound int modifiers + SAFE_COMPILER_BUILTINS
  const richSource = [
    'uint64 sample(uint64 a1)',
    '{',
    '  uint8_t __hex_stack_frame[4096];',
    '  uint64 (*fp)(uint64) = (uint64 (*)(uint64))a1;',
    '  unsigned acc = 0;',
    '  long long sum = 0;',
    '  for (int i = 0; i < 4; i++) {',
    '    __hex_stack_frame[i] = (uint8_t)i;',
    '    acc += (unsigned)i;',
    '    sum += i;',
    '  }',
    '  uint64 sw = __builtin_bswap64(a1) + (uint64)__builtin_clzll(a1 | 1) + (uint64)__builtin_popcountll(a1);',
    '  return fp(sw + acc + (uint64)sum + __hex_stack_frame[0]);',
    '}',
  ].join('\n');
  const richUnit = buildCTranslationUnit([makeFn(richSource)]);
  assert.equal(richUnit.functions[0].syntaxOnly, false, JSON.stringify(richUnit.unresolved));
  assert.ok(!richUnit.unresolved.some((u) => u.subject.startsWith('__builtin_')));
  assert.ok(!richUnit.helpers.some((h) => h.name.startsWith('__builtin_')));

  // Per-declarator pointerLocals: `int *p = 0, q;` -> p is pointer, q is non-pointer
  const calleeProto = {
    op: 'call',
    target: 0x3000n,
    name: 'take_ptr',
    callPrototype: { returnType: 'void', parameters: [{ type: 'void *', name: 'ptr' }] },
  };
  const ptrOkSource = [
    'void sample(void)',
    '{',
    '  int *p = 0, q = 1;',
    '  take_ptr(p);',
    '  (void)q;',
    '}',
  ].join('\n');
  const ptrOkUnit = buildCTranslationUnit([makeFn(ptrOkSource, { ir: { instructions: [calleeProto] } })]);
  assert.equal(ptrOkUnit.functions[0].syntaxOnly, false, JSON.stringify(ptrOkUnit.unresolved));

  const ptrBadSource = [
    'void sample(void)',
    '{',
    '  int *p = 0, q = 1;',
    '  take_ptr(q);',
    '  (void)p;',
    '}',
  ].join('\n');
  const ptrBadUnit = buildCTranslationUnit([makeFn(ptrBadSource, { ir: { instructions: [calleeProto] } })]);
  assert.equal(ptrBadUnit.functions[0].syntaxOnly, true);
  assert.ok(ptrBadUnit.unresolved.some((u) => u.reason === 'call-pointer-arg-mismatch:take_ptr'));
});

test('§1.5 parses all 4 STANDALONE_BINARY_GLOBALS_COMMENT forms (excluding _buf/_backing), rejects bare global_5000, preserves IR priority, and fails closed on array/scalar mix or conflict', () => {
  // All 4 binary-backed forms
  const bin4Source = [
    FIXED_WIDTH_PRELUDE_COMMENT,
    'typedef __UINT64_TYPE__ uint64;',
    'typedef unsigned __int128 uint128;',
    STANDALONE_BINARY_GLOBALS_COMMENT,
    'static uint64 __hex_global_1000_buf[512] = { 0x1ULL };',
    '#define global_1000 (__hex_global_1000_buf[0])',
    'static uint64 __hex_global_2000_buf[2] = { 0x2ULL, 0x3ULL };',
    '#define global_2000 (*(uint128 *)&__hex_global_2000_buf[0])',
    'static uint128 global_3000 = 0;',
    'static uint64 __hex_global_4000_backing = 0;',
    'static uint64 global_4000 = (uint64)(uintptr_t)&__hex_global_4000_backing;',
    'uint64 sample(void)',
    '{',
    '  global_1000 = 1;',
    '  uint128 a = global_2000 + global_3000;',
    '  return (uint64)a + global_4000;',
    '}',
  ].join('\n');
  const bin4Unit = buildCTranslationUnit([makeFn(bin4Source)]);
  assert.equal(bin4Unit.functions[0].syntaxOnly, false, JSON.stringify(bin4Unit.unresolved));
  assert.equal(bin4Unit.unresolved.length, 0);
  assert.ok(!bin4Unit.globals.some((g) => g.name.includes('_buf') || g.name.includes('_backing')));
  const byName = new Map(bin4Unit.globals.map((g) => [g.name, g]));
  assert.equal(byName.get('global_1000')?.declaration, 'static uint64_t global_1000;');
  assert.equal(byName.get('global_2000')?.declaration, 'static unsigned __int128 global_2000;');
  assert.equal(byName.get('global_3000')?.declaration, 'static unsigned __int128 global_3000;');
  assert.equal(byName.get('global_4000')?.declaration, 'static uint64_t global_4000;');
  assert.equal(byName.get('global_1000')?.certainty, 'evidence-backed-nonexact');
  assert.ok(byName.get('global_1000')?.provenance.includes('closure-binary-data'));

  // Bare global_5000 without binary marker -> byte-array fallback & global-byte-array-fallback-usage-unsupported
  const bareGlobalSource = 'uint64 sample(void)\n{\n  global_5000 = 1;\n  return global_5000;\n}';
  const bareGlobalUnit = buildCTranslationUnit([makeFn(bareGlobalSource)]);
  assert.equal(bareGlobalUnit.functions[0].syntaxOnly, true);
  assert.ok(bareGlobalUnit.unresolved.some((u) => u.reason === 'global-byte-array-fallback-usage-unsupported:global_5000'));

  // IR recovered type must NOT be shadowed by closure-binary-data in globalEvidence
  const irPrioritySource = 'uint32_t sample(void)\n{\n  return global_6000;\n}';
  const irPriorityUnit = buildCTranslationUnit([
    makeFn(irPrioritySource, {
      ir: { instructions: [{ op: 'load', loc: { kind: 'global', address: 0x6000n, key: 'g6000' } }] },
      types: { locations: { g6000: 'uint32_t' } },
      globalEvidence: [{ name: 'global_6000', address: 0x6000n, type: 'uint64_t', provenance: 'closure-binary-data' }],
    }),
  ]);
  assert.equal(irPriorityUnit.functions[0].syntaxOnly, false, JSON.stringify(irPriorityUnit.unresolved));
  const g6000 = irPriorityUnit.globals.find((g) => g.name === 'global_6000');
  assert.equal(g6000?.declaration, 'extern uint32_t global_6000;');
  assert.equal(g6000?.type, 'uint32_t');

  // Conflicting closure-binary-data types across functions -> fail-closed
  const conflictFn1 = makeFn(
    [
      FIXED_WIDTH_PRELUDE_COMMENT,
      'typedef __UINT64_TYPE__ uint64;',
      STANDALONE_BINARY_GLOBALS_COMMENT,
      'static uint64 global_7000 = 0;',
      'uint64 f1(void)',
      '{',
      '  return global_7000;',
      '}',
    ].join('\n'),
    { address: 0x1000n, name: 'f1' },
  );
  const conflictFn2 = makeFn(
    [
      FIXED_WIDTH_PRELUDE_COMMENT,
      'typedef __UINT64_TYPE__ uint64;',
      'typedef unsigned __int128 uint128;',
      STANDALONE_BINARY_GLOBALS_COMMENT,
      'static uint128 global_7000 = 0;',
      'uint64 f2(void)',
      '{',
      '  return (uint64)global_7000;',
      '}',
    ].join('\n'),
    { address: 0x1100n, name: 'f2' },
  );
  const conflictUnit = buildCTranslationUnit([conflictFn1, conflictFn2]);
  assert.ok(conflictUnit.unresolved.some((u) => u.kind === 'unresolved-global' && u.reason === 'conflicting-global-type-evidence'));
  assert.equal(conflictUnit.functions[0].syntaxOnly, true);
  assert.equal(conflictUnit.functions[1].syntaxOnly, true);

  // Mixed array/scalar usage across functions -> fail-closed to byte-array fallback
  const arrayMixFn1 = makeFn(
    [
      FIXED_WIDTH_PRELUDE_COMMENT,
      'typedef __UINT64_TYPE__ uint64;',
      STANDALONE_BINARY_GLOBALS_COMMENT,
      'static uint64 global_8000 = 0;',
      'uint64 f_scalar(void)',
      '{',
      '  return global_8000;',
      '}',
    ].join('\n'),
    { address: 0x1200n, name: 'f_scalar' },
  );
  const arrayMixFn2 = makeFn(
    [
      STANDALONE_GLOBALS_COMMENT,
      'static uint8_t global_8000[64] = {0};',
      'uint64 f_array(void)',
      '{',
      '  return global_8000[0];',
      '}',
    ].join('\n'),
    { address: 0x1300n, name: 'f_array' },
  );
  const arrayMixUnit = buildCTranslationUnit([arrayMixFn1, arrayMixFn2]);
  assert.ok(arrayMixUnit.unresolved.some((u) => u.kind === 'unresolved-global' && u.subject === 'global_8000'));
  assert.ok(arrayMixUnit.fallbackDeclarations.some((d) => d.includes('extern uint8_t global_8000[];')));
  const scalarFn = arrayMixUnit.functions.find((f) => f.name === 'f_scalar');
  assert.equal(scalarFn?.syntaxOnly, true);
});

test('§1.6 accepts all 4 anonymous union bitcast forms including nested parens/bitcasts, and rejects invalid constructs inside <val>', () => {
  const validBitcastSource = [
    'uint64 sample(uint32_t a1, uint64_t a2, float f1, double d1)',
    '{',
    '  float x1 = (union { uint32_t u; float f; }){ .u = (a1 + 1U) }.f;',
    '  double x2 = (union { uint64_t u; double f; }){ .u = (a2 ^ 0x1ULL) }.f;',
    '  uint32_t x3 = (union { float f; uint32_t u; }){ .f = (x1 + f1) }.u;',
    '  uint64_t x4 = (union { double f; uint64_t u; }){ .f = (union { uint64_t u; double f; }){ .u = (uint64_t)x3 + (uint64_t)d1 }.f }.u;',
    '  return (uint64)(x4 + (uint64_t)x2);',
    '}',
  ].join('\n');
  const validUnit = buildCTranslationUnit([makeFn(validBitcastSource)]);
  assert.equal(validUnit.functions[0].syntaxOnly, false, JSON.stringify(validUnit.unresolved));

  // Uncovered `u` inside <val> must NOT fail open
  const uncoveredValSource = [
    'float sample(void)',
    '{',
    '  return (union { uint32_t u; float f; }){ .u = u }.f;',
    '}',
  ].join('\n');
  const uncoveredValUnit = buildCTranslationUnit([makeFn(uncoveredValSource)]);
  assert.equal(uncoveredValUnit.functions[0].syntaxOnly, true);
  assert.ok(uncoveredValUnit.unresolved.some((u) => u.reason === 'uncovered-identifier:u'));

  // Arbitrary struct inside <val> must NOT fail open
  const structInsideValSource = [
    'float sample(void)',
    '{',
    '  return (union { uint32_t u; float f; }){ .u = (uint32_t)sizeof(struct Foo { int x; }) }.f;',
    '}',
  ].join('\n');
  const structInsideValUnit = buildCTranslationUnit([makeFn(structInsideValSource)]);
  assert.equal(structInsideValUnit.functions[0].syntaxOnly, true);
  assert.ok(structInsideValUnit.unresolved.some((u) => u.reason === 'typelike-declaration-unavailable'));
});

test('Combined-TU with Track 1 features + multi-arity objc_msgSend compiles cleanly with GCC', () => {
  const fn1 = makeFn(
    [
      FIXED_WIDTH_PRELUDE_COMMENT,
      'typedef __UINT64_TYPE__ uint64;',
      'typedef unsigned __int128 uint128;',
      STANDALONE_BINARY_GLOBALS_COMMENT,
      'static uint64 global_A000 = 0x1234ULL;',
      'uint64 fn_one(uint64 a1, float f1)',
      '{',
      '  uint8_t __hex_stack_frame[64];',
      '  __hex_stack_frame[0] = (uint8_t)a1;',
      '  switch (a1) {',
      '  case 0:',
      '  loc_zero:',
      '    return objc_msgSend(a1, global_A000);',
      '  case 1:',
      '    goto loc_zero;',
      '  default:',
      '    break;',
      '  }',
      '  uint32_t bits = (union { float f; uint32_t u; }){ .f = f1 }.u;',
      '  uint128 wide = (uint128)bits + (uint128)__builtin_bswap64(a1);',
      '  return (uint64)wide + __hex_stack_frame[0];',
      '}',
    ].join('\n'),
    { address: 0x2000n, name: 'fn_one' },
  );
  const fn2 = makeFn(
    [
      FIXED_WIDTH_PRELUDE_COMMENT,
      'typedef __UINT64_TYPE__ uint64;',
      'void * fn_two(uint64 a1, uint64 a2, uint64 a3)',
      '{',
      '  uint64 (*fp)(uint64) = (uint64 (*)(uint64))a1;',
      '  uint64 res = objc_msgSend(a1, a2, a3) + fp(a2);',
      '  return (void *)(uintptr_t)(res);',
      '}',
    ].join('\n'),
    { address: 0x2100n, name: 'fn_two' },
  );

  const unit = buildCTranslationUnit([fn1, fn2]);
  assert.equal(unit.functions[0].syntaxOnly, false, JSON.stringify(unit.unresolved));
  assert.equal(unit.functions[1].syntaxOnly, false, JSON.stringify(unit.unresolved));
  // objc_msgSend must be declared once as unprototyped fallback
  const msgSendDecls = unit.fallbackDeclarations.filter((d) => /\bobjc_msgSend\s*\(\s*\)/.test(d));
  assert.equal(msgSendDecls.length, 1);

  const chk = compileWithGcc(unit.source);
  assert.equal(chk.ok, true, `Combined-TU GCC compilation failed:\n${unit.source}\n${chk.stderr}`);
});
