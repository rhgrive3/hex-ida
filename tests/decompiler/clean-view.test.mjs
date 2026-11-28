import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isTypedefPreludeLine,
  elideDeadStackSpills,
  formatCleanViewLines,
  formatCleanViewText,
} from '../../js/decompiler/clean-view.js';

test('isTypedefPreludeLine hides primitive and id typedefs while keeping typedef struct', () => {
  assert.equal(isTypedefPreludeLine('typedef unsigned char uint8;'), true);
  assert.equal(isTypedefPreludeLine('typedef long long int64;'), true);
  assert.equal(isTypedefPreludeLine('typedef __UINT64_TYPE__ uint64;'), true);
  assert.equal(isTypedefPreludeLine('typedef void * id;'), true);
  assert.equal(isTypedefPreludeLine('  typedef unsigned int uint32_t;  '), true);

  assert.equal(isTypedefPreludeLine('typedef struct { uint64 field_0; uint64 field_8; } hex_struct_ctx;'), false);
  assert.equal(isTypedefPreludeLine('typedef struct Node { int val; struct Node *next; } Node;'), false);
  assert.equal(isTypedefPreludeLine('typedef struct Opaque Opaque;'), false);
  assert.equal(isTypedefPreludeLine('typedef int (*callback_t)(int);'), false);
  assert.equal(isTypedefPreludeLine('uint64 var_18;'), false);
});

test('elideDeadStackSpills removes unread pure var_XX spills and unused declarations', () => {
  const input = [
    'int64 sub_1000(int64 a1, int64 a2) {',
    '  int64 var_10;',
    '  uint64 var_18;',
    '  int64 result;',
    '  var_10 = a1;',
    '  var_18 = a2 + 8;',
    '  result = a1 + a2;',
    '  return result;',
    '}',
  ];

  const { lines, stats } = elideDeadStackSpills(input);
  assert.equal(stats.deadSpillsElided, 2);
  assert.equal(stats.deadDeclsElided, 2);
  assert.deepEqual(lines, [
    'int64 sub_1000(int64 a1, int64 a2) {',
    '  int64 result;',
    '  result = a1 + a2;',
    '  return result;',
    '}',
  ]);
});

test('elideDeadStackSpills preserves var_XX when read later, when &var_XX is taken, or when RHS has side effects', () => {
  const input = [
    'int64 sub_2000(int64 a1) {',
    '  int64 var_10;',
    '  int64 var_20;',
    '  int64 var_30;',
    '  int64 var_40;',
    '  var_10 = a1 + 1;',
    '  var_20 = a1 + 2;',
    '  var_30 = helper_call(a1);',
    '  var_40 = a1 + 4;',
    '  take_ptr(&var_20);',
    '  return var_10;',
    '}',
  ];

  const { lines, stats } = elideDeadStackSpills(input);
  // Only var_40 is dead (pure RHS, unread, address never taken)
  assert.equal(stats.deadSpillsElided, 1);
  assert.equal(stats.deadDeclsElided, 1);

  const joined = lines.join('\n');
  assert.ok(joined.includes('var_10 = a1 + 1;'), 'var_10 is read in return and must be kept');
  assert.ok(joined.includes('var_20 = a1 + 2;'), 'var_20 has &var_20 taken and must be kept');
  assert.ok(joined.includes('var_30 = helper_call(a1);'), 'var_30 has function call RHS and must be kept');
  assert.ok(!joined.includes('var_40'), 'var_40 is dead and must be elided');
});

test('formatCleanViewLines preserves line metadata and respects options', () => {
  const lineObjs = [
    { kind: 'decl', indent: 0, text: 'typedef unsigned char uint8;', row: 1, addr: null, note: null },
    { kind: 'decl', indent: 0, text: 'typedef void * id;', row: 2, addr: null, note: null },
    { kind: 'blank', indent: 0, text: '', row: 3, addr: null, note: null },
    { kind: 'blank', indent: 0, text: '', row: 4, addr: null, note: null },
    { kind: 'decl', indent: 0, text: 'typedef struct { uint64 field_0; } hex_struct_s;', row: 5, addr: null, note: null },
    { kind: 'sig', indent: 0, text: 'id sub_3000(id self) {', row: 6, addr: '0x3000', note: 'entry' },
    { kind: 'decl', indent: 1, text: 'uint64 var_10;', row: 7, addr: null, note: null },
    { kind: 'stmt', indent: 1, text: 'var_10 = self;', row: 8, addr: '0x3004', note: 'spill' },
    { kind: 'stmt', indent: 1, text: 'id v1 = objc_retainAutoreleasedReturnValue(_objc_msgSend$sharedSession:(self));', row: 9, addr: '0x3008', note: 'call' },
    { kind: 'stmt', indent: 1, text: 'objc_release(v1);', row: 10, addr: '0x300c', note: 'arc' },
    { kind: 'stmt', indent: 1, text: 'return v1;', row: 11, addr: '0x3010', note: 'ret' },
    { kind: 'brace', indent: 0, text: '}', row: 12, addr: null, note: null },
  ];

  const clean = formatCleanViewLines(lineObjs);
  assert.equal(clean.stats.typedefsHidden, 2);
  assert.equal(clean.stats.deadSpillsElided, 1);
  assert.equal(clean.stats.deadDeclsElided, 1);
  assert.equal(clean.stats.objcStubsRewritten, 1);
  assert.equal(clean.stats.arcLinesRemoved, 1);
  assert.ok(clean.stats.arcOpsFolded >= 2);

  // Leading blank lines collapsed and typedef struct preserved
  assert.equal(clean.lines[0].text, 'typedef struct { uint64 field_0; } hex_struct_s;');
  const sigLine = clean.lines.find((l) => l.kind === 'sig');
  assert.equal(sigLine.addr, '0x3000');
  assert.equal(sigLine.note, 'entry');
  const callLine = clean.lines.find((l) => l.row === 9);
  assert.equal(callLine.indent, 1);
  assert.equal(callLine.addr, '0x3008');
  assert.ok(callLine.text.includes('[self sharedSession:nil]') || callLine.text.includes('[self sharedSession]'));

  // With hideTypedefPrelude: false, primitive typedefs remain
  const withTypedefs = formatCleanViewLines(lineObjs, { hideTypedefPrelude: false });
  assert.equal(withTypedefs.stats.typedefsHidden, 0);
  assert.equal(withTypedefs.lines[0].text, 'typedef unsigned char uint8;');
});

test('formatCleanViewText end-to-end with hideTypedefPrelude on/off and ObjC/Swift ARC folding', () => {
  const rawPseudoC = [
    'typedef unsigned char uint8;',
    'typedef long long int64;',
    'typedef void * id;',
    '',
    'typedef struct { uint64 field_0; } hex_struct_ctx;',
    '',
    'id sub_4000(id self, id req) {',
    '  uint64 var_8;',
    '  var_8 = 0x10;',
    '  id v1 = objc_retainAutoreleasedReturnValue(_objc_msgSend$setObject:forKey:(self, req, @"k"));',
    '  objc_release(v1);',
    '  return objc_autoreleaseReturnValue(v1);',
    '}',
  ].join('\n');

  const clean = formatCleanViewText(rawPseudoC);
  assert.ok(!clean.code.includes('typedef unsigned char uint8;'));
  assert.ok(!clean.code.includes('typedef void * id;'));
  assert.ok(clean.code.includes('typedef struct { uint64 field_0; } hex_struct_ctx;'));
  assert.ok(!clean.code.includes('var_8'));
  assert.ok(clean.code.includes('[self setObject:req forKey:@"k"]'));
  assert.ok(!clean.code.includes('objc_retainAutoreleasedReturnValue'));
  assert.ok(!clean.code.includes('objc_release(v1);'));
  assert.ok(clean.code.includes('[ARC/Swift: folded'));

  const keepTypedefs = formatCleanViewText(rawPseudoC, { hideTypedefPrelude: false });
  assert.ok(keepTypedefs.code.includes('typedef unsigned char uint8;'));
  assert.ok(keepTypedefs.code.includes('typedef void * id;'));
  assert.equal(keepTypedefs.stats.typedefsHidden, 0);
  assert.equal(keepTypedefs.stats.deadSpillsElided, 1);
});

test('formatCleanViewLines collapses consecutive identical semantic-v2 __asm lines', () => {
  const lines = [
    { kind: 'sig', indent: 0, text: 'void sub_4680(void)' },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'stmt', indent: 1, text: '__asm("semantic-v2 function unknown: unresolved-indirect-control-flow");' },
    { kind: 'stmt', indent: 1, text: '__asm("semantic-v2 function unknown: unresolved-indirect-control-flow");' },
    { kind: 'stmt', indent: 1, text: '__asm("semantic-v2 function unknown: unresolved-indirect-control-flow");' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ];
  const { lines: out, stats } = formatCleanViewLines(lines);
  assert.equal(stats.duplicateAsmCollapsed, 2);
  assert.equal(out.length, 4);
  assert.ok(out[2].text.includes('/* ×3 */'));
});
