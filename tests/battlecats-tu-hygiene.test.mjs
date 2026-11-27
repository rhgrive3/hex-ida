import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCTranslationUnit } from '../js/analysis/query/translation-unit.js';

function fn(pseudocode, extra = {}) {
  return {
    address: 0x100n,
    name: 'sample',
    signature: pseudocode.split(/\r?\n/, 1)[0],
    pseudocode,
    ...extra,
  };
}

function call(target, name, prototype = null) {
  return { op: 'call', target, name, callPrototype: prototype };
}

test('type-like identifiers and function-pointer casts do not emit fallback prototypes', () => {
  const source = [
    'uint64 sample(uint64 a1)',
    '{',
    '  uint64 (*fp)(uint64) = ((uint64 (*)(uint64))a1);',
    '  size_t sz = sizeof(uint64_t);',
    '  return fp((uint64)sz);',
    '}',
  ].join('\n');
  const unit = buildCTranslationUnit([fn(source)]);
  assert.doesNotMatch(unit.source, /uint64_t uint64\s*\(/);
  assert.doesNotMatch(unit.source, /uint64_t uint64_t\s*\(/);
  assert.doesNotMatch(unit.source, /uint64_t size_t\s*\(/);
  assert.doesNotMatch(unit.source, /uint64_t sizeof\s*\(/);
  assert.ok(!unit.fallbackDeclarations.some((d) => /\b(?:uint64|uint64_t|size_t|sizeof)\s*\(/.test(d)));
  assert.ok(!unit.unresolved.some((u) => u.subject === 'uint64' || u.subject === 'size_t'));
});

test('call-site IR with type-like name does not emit fallback prototype', () => {
  const source = 'void sample(void)\n{\n  return;\n}';
  const unit = buildCTranslationUnit([
    fn(source, { ir: { instructions: [call(0x200n, 'uint64'), call(0x204n, 'uint128')] } }),
  ]);
  assert.ok(!unit.fallbackDeclarations.some((d) => /\b(?:uint64|uint128)\s*\(/.test(d)));
});

test('normal indirect dereference argument call foo(*ptr) is NOT excluded', () => {
  const source = [
    'uint64 sample(uint64 * ptr)',
    '{',
    '  return foo(*ptr);',
    '}',
  ].join('\n');
  const unit = buildCTranslationUnit([fn(source)]);
  assert.ok(unit.fallbackDeclarations.some((d) => d.includes('uint64_t foo()')));
  assert.equal(unit.functions[0].syntaxOnly, false, JSON.stringify(unit.unresolved));
});

test('inline __asm / __asm__ / asm in body forces syntaxOnly with asm-syntax-unavailable', () => {
  for (const kw of ['__asm', '__asm__', 'asm']) {
    const source = `void sample(void)\n{\n  ${kw} ("nop");\n}`;
    const unit = buildCTranslationUnit([fn(source)]);
    assert.equal(unit.functions[0].syntaxOnly, true, `expected syntaxOnly for ${kw}`);
    assert.ok(
      unit.unresolved.some((u) => u.subject === 'sample' && u.reason === 'asm-syntax-unavailable'),
      `expected asm-syntax-unavailable for ${kw}, got ${JSON.stringify(unit.unresolved)}`,
    );
  }
});

test('asm inside comment or string does not trigger asm-syntax-unavailable', () => {
  const source = 'void sample(void)\n{\n  /* __asm nop */\n  return;\n}';
  const unit = buildCTranslationUnit([fn(source)]);
  assert.equal(unit.functions[0].syntaxOnly, false, JSON.stringify(unit.unresolved));
});

test('digit-starting ObjC selector tokens [a1 0QD:x2] and [a1 0QD] are caught as objc-message-syntax-unavailable', () => {
  const cases = [
    'uint64 sample(uint64 a1, uint64 x2)\n{\n  return [a1 0QD:x2];\n}',
    'uint64 sample(uint64 a1)\n{\n  return [a1 0QD];\n}',
    'uint64 sample(uint64 a1)\n{\n  return [(*((uint64 *)a1)) 0QD];\n}',
  ];
  for (const source of cases) {
    const unit = buildCTranslationUnit([fn(source)]);
    assert.equal(unit.functions[0].syntaxOnly, true, `expected syntaxOnly for ${source}`);
    assert.ok(
      unit.unresolved.some((u) => u.subject === 'sample' && u.reason === 'objc-message-syntax-unavailable'),
      `expected objc-message-syntax-unavailable, got ${JSON.stringify(unit.unresolved)}`,
    );
  }
});

test('normal C array indexing with ternary is not misclassified as ObjC message syntax', () => {
  const source = [
    'int sample(int * arr, int cond, int a, int b)',
    '{',
    '  return arr[cond ? a : b];',
    '}',
  ].join('\n');
  const unit = buildCTranslationUnit([fn(source)]);
  assert.equal(unit.functions[0].syntaxOnly, false, JSON.stringify(unit.unresolved));
});

test('valid local variable declaration int x = 1; is extracted and remains faithful', () => {
  const source = [
    'int sample(void)',
    '{',
    '  int x = 1;',
    '  return x;',
    '}',
  ].join('\n');
  const unit = buildCTranslationUnit([fn(source)]);
  assert.equal(unit.functions[0].syntaxOnly, false, JSON.stringify(unit.unresolved));
});

test('NON_TYPE_KEYWORDS such as return do not register following identifier as declaredLocals', () => {
  const source = [
    'int sample(void)',
    '{',
    '  return undeclared_var;',
    '}',
  ].join('\n');
  const unit = buildCTranslationUnit([fn(source)]);
  assert.equal(unit.functions[0].syntaxOnly, true);
  assert.ok(
    unit.unresolved.some((u) => u.subject === 'sample' && u.reason === 'uncovered-identifier:undeclared_var'),
    JSON.stringify(unit.unresolved),
  );
});

test('pure call-position identifier cannot be covered by declaredLocals', () => {
  const source = [
    'int sample(void)',
    '{',
    '  int __my_local_fn = 0;',
    '  return __my_local_fn(1);',
    '}',
  ].join('\n');
  const unit = buildCTranslationUnit([fn(source)]);
  assert.equal(unit.functions[0].syntaxOnly, true);
  assert.ok(
    unit.unresolved.some((u) => u.subject === 'sample' && u.reason === 'uncovered-identifier:__my_local_fn'),
    JSON.stringify(unit.unresolved),
  );
});

test('existing uint128 prelude contract remains body-prefix-unaccounted', () => {
  const source = 'typedef unsigned __int128 uint128;\nvoid foo(void)\n{\n  uint128 x = 1;\n}';
  const unit = buildCTranslationUnit([fn(source, { name: 'foo', signature: 'void foo(void)' })]);
  assert.equal(unit.functions[0].syntaxOnly, true);
  assert.ok(
    unit.unresolved.some((entry) => entry.subject === 'foo' && entry.reason === 'body-prefix-unaccounted'),
    JSON.stringify(unit.unresolved),
  );
});

test('Swift dollar-mangled callee _$s... forces syntaxOnly without emitting split fallback prototype', () => {
  const source = [
    'int32 sample(uint64 a1)',
    '{',
    '  uint64 r = _$s10Foundation3URLVMa(a1);',
    '  return (int32)r;',
    '}',
  ].join('\n');
  const unit = buildCTranslationUnit([fn(source)]);
  assert.equal(unit.functions[0].syntaxOnly, true);
  assert.ok(
    unit.unresolved.some((u) => u.subject === 'sample' && u.reason === 'dollar-identifier-unavailable'),
    JSON.stringify(unit.unresolved),
  );
  assert.ok(!unit.source.includes('$'), 'dollar identifier must not leak into emitted source');
  assert.ok(
    !unit.fallbackDeclarations.some((d) => d.includes('s10Foundation3URLVMa')),
    'split suffix after $ must not generate a bogus fallback prototype',
  );
});

test('dollar sign inside string literal or comment does not trigger dollar-identifier-unavailable', () => {
  const source = [
    'int sample(void)',
    '{',
    '  /* $comment */',
    '  const char *s = "$100";',
    '  return s != 0;',
    '}',
  ].join('\n');
  const unit = buildCTranslationUnit([fn(source)]);
  assert.equal(unit.functions[0].syntaxOnly, false, JSON.stringify(unit.unresolved));
});

test('ObjC message with unary/cast receiver and hyphenated selector [*(uint64 *)(a1 + 8) w-O] is caught', () => {
  const source = [
    'uint64 sample(void * a1)',
    '{',
    '  uint64 x0;',
    '  x0 = [*(uint64 *)(a1 + 8) w-O];',
    '  return x0;',
    '}',
  ].join('\n');
  const unit = buildCTranslationUnit([fn(source)]);
  assert.equal(unit.functions[0].syntaxOnly, true);
  assert.ok(
    unit.unresolved.some((u) => u.subject === 'sample' && u.reason === 'objc-message-syntax-unavailable'),
    JSON.stringify(unit.unresolved),
  );
});

test('C11 designated initializer with cast index { [(int)0] = 1 } is not misclassified as ObjC message syntax', () => {
  const source = [
    'int sample(int * out)',
    '{',
    '  *out = ((int[2]){ [(int)0] = 1 })[0];',
    '  return *out;',
    '}',
  ].join('\n');
  const unit = buildCTranslationUnit([fn(source)]);
  assert.equal(unit.functions[0].syntaxOnly, false, JSON.stringify(unit.unresolved));
});

test('arc4random_uniform resolves to <stdlib.h> without emitting conflicting fallback prototype', () => {
  const source = [
    'uint32 sample(uint32 n)',
    '{',
    '  return arc4random_uniform(n);',
    '}',
  ].join('\n');
  const unit = buildCTranslationUnit([fn(source)]);
  assert.ok(unit.includes.includes('<stdlib.h>'), JSON.stringify(unit.includes));
  assert.ok(!unit.fallbackDeclarations.some((d) => d.includes('arc4random_uniform')), JSON.stringify(unit.fallbackDeclarations));
  assert.equal(unit.functions[0].syntaxOnly, false, JSON.stringify(unit.unresolved));
});

test('combined TU catches integer-to-pointer argument mismatch against selected sibling function', () => {
  const callee = fn(
    'uint64 callee_ptr(uint64 a1, void * a2)\n{\n  return a1 + (a2 != 0);\n}',
    { address: 0x100n, name: 'callee_ptr' },
  );
  const badCaller = fn(
    'uint64 bad_caller(uint64 x19)\n{\n  return callee_ptr(x19, *(uint64 *)(x19 + 8));\n}',
    { address: 0x200n, name: 'bad_caller' },
  );
  const goodCaller = fn(
    'uint64 good_caller(uint64 x19, void * p)\n{\n  uint64 r1 = callee_ptr(x19, p);\n  uint64 r2 = callee_ptr(x19, (void *)(uintptr_t)(*(uint64 *)(x19 + 8)));\n  return r1 + r2 + callee_ptr(x19, 0);\n}',
    { address: 0x300n, name: 'good_caller' },
  );
  const unit = buildCTranslationUnit([callee, badCaller, goodCaller]);
  const badRow = unit.functions.find((r) => r.name === 'bad_caller');
  const goodRow = unit.functions.find((r) => r.name === 'good_caller');
  assert.equal(badRow.syntaxOnly, true);
  assert.ok(
    unit.unresolved.some((u) => u.subject === 'bad_caller' && u.reason === 'call-pointer-arg-mismatch:callee_ptr'),
    JSON.stringify(unit.unresolved),
  );
  assert.equal(goodRow.syntaxOnly, false, JSON.stringify(unit.unresolved));
});
