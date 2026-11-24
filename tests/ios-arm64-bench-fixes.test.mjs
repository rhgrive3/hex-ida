import test from 'node:test';
import assert from 'node:assert/strict';

import { parseSynthesizedStructPreludeDeclaration, STANDARD_C_LIBRARY_HEADERS } from '../js/decompiler/c-output-closure.js';
import { buildCTranslationUnit } from '../js/analysis/query/translation-unit.js';
import { printExpression } from '../js/decompiler/pretty/c.js';

test('STANDARD_C_LIBRARY_HEADERS includes POSIX stdio helpers fseeko/ftello', () => {
  assert.equal(STANDARD_C_LIBRARY_HEADERS.get('fseeko'), '<stdio.h>');
  assert.equal(STANDARD_C_LIBRARY_HEADERS.get('ftello'), '<stdio.h>');
});

test('parseSynthesizedStructPreludeDeclaration accepts C++ class struct typedefs', () => {
  const parsed = parseSynthesizedStructPreludeDeclaration(
    'typedef struct jbase64 { uint64 field_0x0; uint64 field_0x10; } jbase64;'
  );
  assert.ok(parsed);
  assert.equal(parsed.name, 'jbase64');
  assert.equal(parsed.fields.length, 2);
  assert.equal(parseSynthesizedStructPreludeDeclaration('typedef struct int { uint64 field_0x0; } int;'), null);
});

test('buildCTranslationUnit keeps Swift mangled external calls faithful', () => {
  const pseudocode = [
    'typedef __UINT64_TYPE__ uint64;',
    'uint64 sub_1000(uint64 a1)',
    '{',
    '    return __sSS10FoundationE19_bridgeToObjectiveCSo8NSStringCyF(a1);',
    '}',
  ].join('\n');
  const unit = buildCTranslationUnit([{ address: '0x1000', name: 'sub_1000', pseudocode }]);
  assert.equal(unit.functions[0].syntaxOnly, false);
  assert.match(unit.source, /__sSS10FoundationE19_bridgeToObjectiveCSo8NSStringCyF/);
});

test('buildCTranslationUnit keeps C++ synthesized-struct receiver signatures faithful', () => {
  const pseudocode = [
    'typedef __UINT64_TYPE__ uint64;',
    'typedef struct jbase64 { uint64 field_0x0; uint64 field_0x10; } jbase64;',
    'double ZN7jbase64C2Ev(jbase64 * this)',
    '{',
    '    this->field_0x0 = 0;',
    '    this->field_0x10 = 0;',
    '    return 0.0;',
    '}',
  ].join('\n');
  const unit = buildCTranslationUnit([{ address: '0x4000', name: 'ZN7jbase64C2Ev', pseudocode }]);
  assert.equal(unit.functions[0].syntaxOnly, false);
  assert.match(unit.source, /double ZN7jbase64C2Ev\(jbase64 \* this\)/);
});

test('buildCTranslationUnit withholds arity-unknown calls to stdlib functions like fseeko()', () => {
  const pseudocode = [
    'typedef __UINT64_TYPE__ uint64;',
    'uint64 test_fseeko(void)',
    '{',
    '    return fseeko(/* arguments unknown */);',
    '}',
  ].join('\n');
  const unit = buildCTranslationUnit([{ address: '0x5000', name: 'test_fseeko', pseudocode }]);
  assert.equal(unit.functions[0].syntaxOnly, true);
});

test('pretty/c.js casts both sides of pointer-pointer subtraction to uintptr_t', () => {
  const node = {
    kind: 'binary',
    op: 'sub',
    left: { kind: 'var', name: 'load_47', isPointer: true },
    right: { kind: 'var', name: 'str_ptr', isPointer: true },
  };
  const out = printExpression(node, 0, { pointerVarNames: new Set(['load_47', 'str_ptr']) });
  assert.equal(out, '(uintptr_t)(load_47) - (uintptr_t)(str_ptr)');
});
