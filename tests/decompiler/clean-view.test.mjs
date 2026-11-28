import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isTypedefPreludeLine,
  elideDeadStackSpills,
  foldCalleeSavedStackSpills,
  formatCleanViewLines,
  formatCleanViewText,
} from '../../js/decompiler/clean-view.js';
import { refineAppleSwiftDecompile } from '../../js/decompiler/apple-arc-swift-pass.js';

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

test('foldCalleeSavedSpills folds paired ARM64 callee-saved x19..x26 / x29 / x30 / fp / lr / d8..d15 save & restore ops', () => {
  const input = [
    'int64 sub_5000(int64 a1, int64 a2) {',
    '  uint64 result;',
    '  *(uint64 *)(sp) = x19;',
    '  *(uint64 *)(sp + 0x8) = x20;',
    '  *(uint64 *)((uintptr_t)(sp) + 0x10) = x26;',
    '  *(uint64 *)((uintptr_t)(sp) + 0x18) = x29;',
    '  *(uint64 *)((uintptr_t)(sp) + 0x20) = x30;',
    '  *(double *)((uintptr_t)(sp) + 0x28) = d8;',
    '  result = compute(a1, a2);',
    '  x19 = *(uint64 *)(sp);',
    '  x20 = *(uint64 *)(sp + 0x8);',
    '  x26 = *(uint64 *)((uintptr_t)(sp) + 0x10);',
    '  x29 = *(uint64 *)((uintptr_t)(sp) + 0x18);',
    '  x30 = *(uint64 *)((uintptr_t)(sp) + 0x20);',
    '  d8 = *(double *)((uintptr_t)(sp) + 0x28);',
    '  return result;',
    '}',
  ];

  const { lines, stats } = formatCleanViewLines(input);
  assert.equal(stats.calleeSavedSpillsFolded, 12);
  assert.deepEqual(lines, [
    'int64 sub_5000(int64 a1, int64 a2) {',
    '  uint64 result;',
    '  /* [Clean View: folded 12 callee-saved prologue/epilogue spill ops] */',
    '  result = compute(a1, a2);',
    '  return result;',
    '}',
  ]);
});

test('foldCalleeSavedSpills folds prologue-only x29/x30 saves, preserves _origIdx, and tags synthetic comment with _origIdx === -1', () => {
  const lineObjs = [
    { kind: 'sig', indent: 0, text: 'void sub_5100(int64 a1) {', row: 1, addr: '0x5100', note: 'entry', _origIdx: 0 },
    { kind: 'stmt', indent: 1, text: '*(uint64 *)((uintptr_t)(sp) + 0x30) = x29;', row: 2, addr: '0x5104', note: null, _origIdx: 1 },
    { kind: 'stmt', indent: 1, text: '*(uint64 *)((uintptr_t)(sp) + 0x38) = x30;', row: 3, addr: '0x5108', note: null, _origIdx: 2 },
    { kind: 'stmt', indent: 1, text: '*(uint64 *)((uintptr_t)(sp) + 0x40) = x19;', row: 4, addr: '0x510c', note: null, _origIdx: 3 },
    { kind: 'stmt', indent: 1, text: 'tail_call(a1);', row: 5, addr: '0x5110', note: 'tail', _origIdx: 4 },
    { kind: 'brace', indent: 0, text: '}', row: 6, addr: null, note: null, _origIdx: 5 },
  ];

  const { lines, stats } = formatCleanViewLines(lineObjs);
  assert.equal(stats.calleeSavedSpillsFolded, 3);
  assert.equal(lines.length, 4);
  assert.equal(lines[0]._origIdx, 0);
  assert.deepEqual(lines[1], {
    kind: 'comment',
    indent: 1,
    text: '/* [Clean View: folded 3 callee-saved prologue/epilogue spill ops] */',
    row: null,
    addr: null,
    note: null,
    _origIdx: -1,
  });
  assert.equal(lines[2].text, 'tail_call(a1);');
  assert.equal(lines[2].addr, '0x5110');
  assert.equal(lines[2].note, 'tail');
  assert.equal(lines[2]._origIdx, 4);
  assert.equal(lines[3]._origIdx, 5);
});

test('foldCalleeSavedSpills preserves caller-saved stores, aliased callee-saved slots, and written-before-save regs', () => {
  const input = [
    'int64 sub_5200(int64 a1) {',
    '  *(uint64 *)((uintptr_t)(sp) + 0x10) = x0;',
    '  *(uint64 *)((uintptr_t)(sp) + 0x18) = x15;',
    '  *(uint64 *)((uintptr_t)(sp) + 0x20) = a1;',
    '  *(uint64 *)((uintptr_t)(sp) + 0x28) = result;',
    '  *(uint64 *)((uintptr_t)(sp) + 0x40) = x19;',
    '  *(uint64 *)((uintptr_t)(sp) + 0x50) = x21;',
    '  x22 = a1 + 5;',
    '  *(uint64 *)((uintptr_t)(sp) + 0x58) = x22;',
    '  x23 = *(uint64 *)((uintptr_t)(sp) + 0x40);',
    '  x0 = *(uint64 *)((uintptr_t)(sp) + 0x10);',
    '  x15 = *(uint64 *)((uintptr_t)(sp) + 0x18);',
    '  x19 = *(uint64 *)((uintptr_t)(sp) + 0x40);',
    '  x21 = *(uint64 *)((uintptr_t)(sp) + 0x50);',
    '  return x23;',
    '}',
  ];

  const { lines, stats } = foldCalleeSavedStackSpills(input);
  // Only x21 at 0x50 is safe to fold (paired save + restore, no aliasing or overlap)
  assert.equal(stats.calleeSavedSpillsFolded, 2);

  const joined = lines.join('\n');
  assert.ok(joined.includes('/* [Clean View: folded 2 callee-saved prologue/epilogue spill ops] */'));
  assert.ok(!joined.includes('+ 0x50) = x21;'), 'paired safe x21 save must be folded');
  assert.ok(!joined.includes('x21 = *(uint64 *)((uintptr_t)(sp) + 0x50);'), 'paired safe x21 restore must be folded');

  // Caller-saved / forbidden registers preserved
  assert.ok(joined.includes('+ 0x10) = x0;'), 'x0 store must be preserved');
  assert.ok(joined.includes('+ 0x18) = x15;'), 'x15 store must be preserved');
  assert.ok(joined.includes('+ 0x20) = a1;'), 'a1 store must be preserved');
  assert.ok(joined.includes('+ 0x28) = result;'), 'result store must be preserved');

  // Aliased slot (0x40 read into x23) preserved
  assert.ok(joined.includes('+ 0x40) = x19;'), 'aliased x19 save must be preserved');
  assert.ok(joined.includes('x23 = *(uint64 *)((uintptr_t)(sp) + 0x40);'), 'aliased read into x23 must be preserved');
  assert.ok(joined.includes('x19 = *(uint64 *)((uintptr_t)(sp) + 0x40);'), 'aliased x19 restore must be preserved');

  // Written-before-save prologue-only slot (x22 at 0x58) preserved
  assert.ok(joined.includes('+ 0x58) = x22;'), 'x22 written before save must be preserved');
});

test('formatCleanViewLines with foldCalleeSavedSpills: false keeps all callee-saved spill lines intact', () => {
  const input = [
    'int64 sub_5300(int64 a1) {',
    '  *(uint64 *)((uintptr_t)(sp) + 0x10) = x19;',
    '  *(uint64 *)((uintptr_t)(sp) + 0x18) = x29;',
    '  *(uint64 *)((uintptr_t)(sp) + 0x20) = x30;',
    '  int64 r = helper(a1);',
    '  x19 = *(uint64 *)((uintptr_t)(sp) + 0x10);',
    '  x29 = *(uint64 *)((uintptr_t)(sp) + 0x18);',
    '  x30 = *(uint64 *)((uintptr_t)(sp) + 0x20);',
    '  return r;',
    '}',
  ];

  const untouched = formatCleanViewLines(input, { foldCalleeSavedSpills: false });
  assert.equal(untouched.stats.calleeSavedSpillsFolded, 0);
  assert.deepEqual(untouched.lines, input);

  const folded = formatCleanViewLines(input, { foldCalleeSavedSpills: true });
  assert.equal(folded.stats.calleeSavedSpillsFolded, 6);
  assert.ok(folded.lines.some((l) => l.includes('/* [Clean View: folded 6 callee-saved prologue/epilogue spill ops] */')));
});

test('foldCalleeSavedSpills rejects intervening sp adjustments (constant, dynamic, sp = fp, sp &= ~0xf) and post-save sp mutation on prologue-only saves', () => {
  const constSpAdjustBetween = [
    'int64 sub_6000(int64 a1) {',
    '  *(uint64 *)(sp + 0x10) = x19;',
    '  sp = sp - 0x20;',
    '  helper(a1);',
    '  x19 = *(uint64 *)(sp + 0x10);',
    '  return a1;',
    '}',
  ];
  assert.equal(foldCalleeSavedStackSpills(constSpAdjustBetween).stats.calleeSavedSpillsFolded, 0);

  const spFromFpBetween = [
    'int64 sub_6001(int64 a1) {',
    '  *(uint64 *)(sp + 0x10) = x19;',
    '  sp = fp;',
    '  x19 = *(uint64 *)(sp + 0x10);',
    '  return a1;',
    '}',
  ];
  assert.equal(foldCalleeSavedStackSpills(spFromFpBetween).stats.calleeSavedSpillsFolded, 0);

  const spAlignBetween = [
    'int64 sub_6002(int64 a1) {',
    '  *(uint64 *)(sp + 0x10) = x19;',
    '  sp &= ~0xf;',
    '  x19 = *(uint64 *)(sp + 0x10);',
    '  return a1;',
    '}',
  ];
  assert.equal(foldCalleeSavedStackSpills(spAlignBetween).stats.calleeSavedSpillsFolded, 0);

  const prologueOnlyWithPostSpMut = [
    'void sub_6003(int64 a1) {',
    '  *(uint64 *)(sp + 0x10) = x29;',
    '  sp = sp - 0x20;',
    '  tail_call(a1);',
    '}',
  ];
  assert.equal(foldCalleeSavedStackSpills(prologueOnlyWithPostSpMut).stats.calleeSavedSpillsFolded, 0);

  // Prologue sp adjust BEFORE save and epilogue sp adjust AFTER restore is sound for paired saves
  const prologueEpilogueSpAdjust = [
    'int64 sub_6004(int64 a1) {',
    '  sp = sp - 0x20;',
    '  *(uint64 *)(sp + 0x10) = x19;',
    '  int64 r = helper(a1);',
    '  x19 = *(uint64 *)(sp + 0x10);',
    '  sp = sp + 0x20;',
    '  return r;',
    '}',
  ];
  assert.equal(foldCalleeSavedStackSpills(prologueEpilogueSpAdjust).stats.calleeSavedSpillsFolded, 2);
});

test('foldCalleeSavedSpills bails out completely on sp escapes (&sp, (void *)sp, fp = sp + imm, sp + idx * 8, storing sp)', () => {
  const escapes = [
    [
      'int64 sub_6100(int64 a1) {',
      '  *(uint64 *)(sp + 0x10) = x19;',
      '  take_ptr(&sp);',
      '  x19 = *(uint64 *)(sp + 0x10);',
      '  return a1;',
      '}',
    ],
    [
      'int64 sub_6101(int64 a1) {',
      '  *(uint64 *)(sp + 0x10) = x19;',
      '  take_ptr((void *)sp);',
      '  x19 = *(uint64 *)(sp + 0x10);',
      '  return a1;',
      '}',
    ],
    [
      'int64 sub_6102(int64 a1) {',
      '  *(uint64 *)(sp + 0x10) = x19;',
      '  fp = sp + 0x20;',
      '  x19 = *(uint64 *)(sp + 0x10);',
      '  return a1;',
      '}',
    ],
    [
      'int64 sub_6103(int64 a1, int64 idx) {',
      '  *(uint64 *)(sp + 0x10) = x19;',
      '  *(uint64 *)(sp + idx * 8) = a1;',
      '  x19 = *(uint64 *)(sp + 0x10);',
      '  return a1;',
      '}',
    ],
    [
      'int64 sub_6104(int64 a1) {',
      '  *(uint64 *)(sp + 0x10) = x19;',
      '  *(uint64 *)((uintptr_t)(sp) + 0x30) = sp;',
      '  x19 = *(uint64 *)(sp + 0x10);',
      '  return a1;',
      '}',
    ],
    [
      'int64 sub_6105(int64 a1) {',
      '  *(uint64 *)((uintptr_t)(sp) + 0x50) = x21;',
      '  take_ptr((void *)((uintptr_t)(sp) + 0x48));',
      '  x21 = *(uint64 *)((uintptr_t)(sp) + 0x50);',
      '  return a1;',
      '}',
    ],
  ];

  for (const fnLines of escapes) {
    const res = foldCalleeSavedStackSpills(fnLines);
    assert.equal(res.stats.calleeSavedSpillsFolded, 0, `expected bail-out for ${fnLines[0]}`);
    assert.deepEqual(res.lines, fnLines);
  }
});

test('foldCalleeSavedSpills rejects byte-range overlapping stack slots (*(uint32 *)(sp + 0x14) vs *(uint64 *)(sp + 0x10))', () => {
  const overlapping = [
    'int64 sub_6200(int64 a1) {',
    '  *(uint64 *)(sp + 0x10) = x19;',
    '  *(uint64 *)(sp + 0x30) = x20;',
    '  *(uint32 *)(sp + 0x14) = 0xdeadbeef;',
    '  int64 r = helper(a1);',
    '  x19 = *(uint64 *)(sp + 0x10);',
    '  x20 = *(uint64 *)(sp + 0x30);',
    '  return r;',
    '}',
  ];

  const { lines, stats } = foldCalleeSavedStackSpills(overlapping);
  // x19 at 0x10 overlaps external access at 0x14 -> preserved; x20 at 0x30 is disjoint -> folded
  assert.equal(stats.calleeSavedSpillsFolded, 2);
  const joined = lines.join('\n');
  assert.ok(joined.includes('*(uint64 *)(sp + 0x10) = x19;'));
  assert.ok(joined.includes('x19 = *(uint64 *)(sp + 0x10);'));
  assert.ok(!joined.includes('*(uint64 *)(sp + 0x30) = x20;'));

  // Negative offset overlap: sp - 0x10 (-16) overlapped by sp - 0xc (-12)
  const negOverlap = [
    'int64 sub_6201(int64 a1) {',
    '  *(uint64 *)(sp - 0x10) = x19;',
    '  uint32 v = *(uint32 *)(sp - 0xc);',
    '  x19 = *(uint64 *)(sp - 0x10);',
    '  return v;',
    '}',
  ];
  assert.equal(foldCalleeSavedStackSpills(negOverlap).stats.calleeSavedSpillsFolded, 0);
});

test('foldCalleeSavedSpills rejects conditional restores, nested saves, and read-after-restore, while allowing early-return restores', () => {
  const conditionalRestoreFallthrough = [
    'int64 sub_6300(int64 a1) {',
    '  *(uint64 *)(sp + 0x10) = x19;',
    '  if (a1 > 0) {',
    '    x19 = *(uint64 *)(sp + 0x10);',
    '  }',
    '  helper(a1);',
    '  return a1;',
    '}',
  ];
  assert.equal(foldCalleeSavedStackSpills(conditionalRestoreFallthrough).stats.calleeSavedSpillsFolded, 0);

  const readAfterRestore = [
    'int64 sub_6301(int64 a1) {',
    '  *(uint64 *)(sp + 0x10) = x19;',
    '  x19 = a1 + 1;',
    '  x19 = *(uint64 *)(sp + 0x10);',
    '  return x19;',
    '}',
  ];
  assert.equal(foldCalleeSavedStackSpills(readAfterRestore).stats.calleeSavedSpillsFolded, 0);

  const aliasReadAfterRestore = [
    'int64 sub_6302(int64 a1) {',
    '  *(uint64 *)(sp + 0x10) = x19;',
    '  x19 = a1 + 1;',
    '  x19 = *(uint64 *)(sp + 0x10);',
    '  return w19;',
    '}',
  ];
  assert.equal(foldCalleeSavedStackSpills(aliasReadAfterRestore).stats.calleeSavedSpillsFolded, 0);

  const nestedSave = [
    'int64 sub_6303(int64 a1) {',
    '  if (a1 > 0) {',
    '    *(uint64 *)(sp + 0x10) = x19;',
    '  }',
    '  x19 = *(uint64 *)(sp + 0x10);',
    '  return a1;',
    '}',
  ];
  assert.equal(foldCalleeSavedStackSpills(nestedSave).stats.calleeSavedSpillsFolded, 0);

  const earlyReturnRestore = [
    'int64 sub_6304(int64 a1) {',
    '  *(uint64 *)(sp + 0x10) = x19;',
    '  if (a1 == 0) {',
    '    x19 = *(uint64 *)(sp + 0x10);',
    '    return 0;',
    '  }',
    '  int64 r = helper(a1);',
    '  x19 = *(uint64 *)(sp + 0x10);',
    '  return r;',
    '}',
  ];
  assert.equal(foldCalleeSavedStackSpills(earlyReturnRestore).stats.calleeSavedSpillsFolded, 3);
});

test('foldCalleeSavedSpills preserves prologue-only d8..d15 saves and rejects restore-before-save', () => {
  const prologueOnlyD8 = [
    'void sub_6400(int64 a1) {',
    '  *(double *)((uintptr_t)(sp) + 0x20) = d8;',
    '  *(double *)((uintptr_t)(sp) + 0x28) = d15;',
    '  tail_call(a1);',
    '}',
  ];
  const d8Res = foldCalleeSavedStackSpills(prologueOnlyD8);
  assert.equal(d8Res.stats.calleeSavedSpillsFolded, 0);
  assert.deepEqual(d8Res.lines, prologueOnlyD8);

  const restoreBeforeSave = [
    'int64 sub_6401(int64 a1) {',
    '  x19 = *(uint64 *)(sp + 0x10);',
    '  helper(a1);',
    '  *(uint64 *)(sp + 0x10) = x19;',
    '  return a1;',
    '}',
  ];
  const rbsRes = foldCalleeSavedStackSpills(restoreBeforeSave);
  assert.equal(rbsRes.stats.calleeSavedSpillsFolded, 0);
  assert.deepEqual(rbsRes.lines, restoreBeforeSave);
});

test('foldCalleeSavedSpills detects ARM64 alias writes before save (w19, fp/x29, lr/x30)', () => {
  const aliasWrites = [
    [
      'int64 sub_6500(int64 a1) {',
      '  w19 = a1 + 1;',
      '  *(uint64 *)(sp + 0x10) = x19;',
      '  x19 = *(uint64 *)(sp + 0x10);',
      '  return a1;',
      '}',
    ],
    [
      'int64 sub_6501(int64 a1) {',
      '  fp = a1;',
      '  *(uint64 *)(sp + 0x18) = x29;',
      '  x29 = *(uint64 *)(sp + 0x18);',
      '  return a1;',
      '}',
    ],
    [
      'int64 sub_6502(int64 a1) {',
      '  x29 = a1;',
      '  *(uint64 *)(sp + 0x18) = fp;',
      '  fp = *(uint64 *)(sp + 0x18);',
      '  return a1;',
      '}',
    ],
    [
      'int64 sub_6503(int64 a1) {',
      '  lr = a1;',
      '  *(uint64 *)(sp + 0x20) = x30;',
      '  x30 = *(uint64 *)(sp + 0x20);',
      '  return a1;',
      '}',
    ],
    [
      'int64 sub_6504(int64 a1) {',
      '  x30 = a1;',
      '  *(uint64 *)(sp + 0x20) = lr;',
      '  return a1;',
      '}',
    ],
  ];

  for (const fnLines of aliasWrites) {
    const res = foldCalleeSavedStackSpills(fnLines);
    assert.equal(res.stats.calleeSavedSpillsFolded, 0, `expected alias write rejection for ${fnLines[0]}`);
  }
});

test('foldCalleeSavedSpills inserts summary comment after function opening brace (depth 0 -> 1), not a preceding if/while block', () => {
  const input = [
    'int64 sub_6600(int64 a1) {',
    '  int64 r;',
    '  if (a1 == 0) {',
    '    log_msg("{ brace in string }");',
    '  }',
    '  *(uint64 *)(sp + 0x10) = x19;',
    '  r = helper(a1);',
    '  x19 = *(uint64 *)(sp + 0x10);',
    '  return r;',
    '}',
  ];

  const { lines, stats } = foldCalleeSavedStackSpills(input);
  assert.equal(stats.calleeSavedSpillsFolded, 2);
  assert.equal(lines[0], 'int64 sub_6600(int64 a1) {');
  assert.equal(lines[1], '  int64 r;');
  assert.equal(lines[2], '  /* [Clean View: folded 2 callee-saved prologue/epilogue spill ops] */');
  assert.equal(lines[3], '  if (a1 == 0) {');
});

test('foldCalleeSavedStackSpills preserves braceless for/else-if/if-before-return conditional spills', () => {
  const bracelessFor = [
    'void f(uint64 a1)',
    '{',
    '    for (int i = 0; i < a1; i++)',
    '        *(uint64 *)(sp + 0x10) = x19;',
    '    x19 = *(uint64 *)(sp + 0x10);',
    '    return;',
    '}',
  ].join('\n');
  assert.equal(formatCleanViewText(bracelessFor).stats.calleeSavedSpillsFolded, 0);

  const bracelessElseIf = [
    'void f(int a1)',
    '{',
    '    *(uint64 *)(sp + 0x10) = x19;',
    '    if (a1 > 0) {',
    '        x19 = 1;',
    '    } else if (a1 < 0)',
    '        x19 = *(uint64 *)(sp + 0x10);',
    '    return;',
    '}',
  ].join('\n');
  assert.equal(formatCleanViewText(bracelessElseIf).stats.calleeSavedSpillsFolded, 0);

  const bracelessIfBeforeReturn = [
    'uint64 f(int a1)',
    '{',
    '    *(uint64 *)(sp + 0x10) = x19;',
    '    x19 = a1 + 1;',
    '    if (a1 == 0)',
    '        x19 = *(uint64 *)(sp + 0x10);',
    '    return a1;',
    '}',
  ].join('\n');
  assert.equal(formatCleanViewText(bracelessIfBeforeReturn).stats.calleeSavedSpillsFolded, 0);
});

test('foldCalleeSavedStackSpills bails out on arbitrary struct/typedef stack dereferences', () => {
  const code = [
    'void f(uint64 a1)',
    '{',
    '    *(uint64 *)(sp + 0x10) = x19;',
    '    (*(BigStruct *)(sp + 0x0)).field_10 = a1;',
    '    x19 = *(uint64 *)(sp + 0x10);',
    '    return;',
    '}',
  ].join('\n');
  const res = formatCleanViewText(code);
  assert.equal(res.stats.calleeSavedSpillsFolded, 0);
  assert.ok(res.code.includes('*(uint64 *)(sp + 0x10) = x19;'));
});

test('foldCalleeSavedStackSpills preserves braceless conditionals with nested parentheses', () => {
  const nestedIf = [
    'uint64 f(int a1)',
    '{',
    '    *(uint64 *)(sp + 0x10) = x19;',
    '    x19 = a1 + 1;',
    '    if ((a1 & 1) == 0)',
    '        x19 = *(uint64 *)(sp + 0x10);',
    '    return a1;',
    '}',
  ].join('\n');
  assert.equal(formatCleanViewText(nestedIf).stats.calleeSavedSpillsFolded, 0);

  const nestedFor = [
    'void f(uint64 a1)',
    '{',
    '    for (int i = 0; i < count(a1); i++)',
    '        *(uint64 *)(sp + 0x10) = x19;',
    '    x19 = *(uint64 *)(sp + 0x10);',
    '    return;',
    '}',
  ].join('\n');
  assert.equal(formatCleanViewText(nestedFor).stats.calleeSavedSpillsFolded, 0);
});

test('foldCalleeSavedSpills folds SSA-only callee-saved prologue saves (virtual_call style) and elides dead decls separately', () => {
  const input = [
    'int64 virtual_call(void * a1) {',
    '  uint64 local_m10;',
    '  uint64 local_m8;',
    '  uint64 local_x29;',
    '  uint64 local_x30;',
    '  uint64 vtable;',
    '  local_m10 = local_x29;',
    '  local_m8 = local_x30;',
    '  vtable = *(uint64 *)a1;',
    '  return (*(int64 (**)(void *))(vtable + 0x10))(a1);',
    '}',
  ];

  const { lines, stats } = formatCleanViewLines(input);
  assert.equal(stats.calleeSavedSpillsFolded, 2);
  assert.equal(stats.deadDeclsElided, 4);
  assert.deepEqual(lines, [
    'int64 virtual_call(void * a1) {',
    '  uint64 vtable;',
    '  /* [Clean View: folded 2 callee-saved prologue/epilogue spill ops] */',
    '  vtable = *(uint64 *)a1;',
    '  return (*(int64 (**)(void *))(vtable + 0x10))(a1);',
    '}',
  ]);
});

test('foldCalleeSavedSpills folds paired SSA prologue/epilogue and early-return restores, and merges mixed raw+SSA prologues', () => {
  const ssaWithEarlyReturn = [
    'int64 sub_7000(int64 a1) {',
    '  uint64 local_m10;',
    '  uint64 local_x19;',
    '  local_m10 = local_x19;',
    '  if (a1 == 0) {',
    '    local_x19 = local_m10;',
    '    return 0;',
    '  }',
    '  int64 r = helper(a1);',
    '  local_x19 = local_m10;',
    '  return r;',
    '}',
  ];
  const ssaRes = formatCleanViewLines(ssaWithEarlyReturn);
  assert.equal(ssaRes.stats.calleeSavedSpillsFolded, 3);
  assert.equal(ssaRes.stats.deadDeclsElided, 2);
  assert.ok(ssaRes.lines.some((l) => l.includes('/* [Clean View: folded 3 callee-saved prologue/epilogue spill ops] */')));
  assert.ok(!ssaRes.lines.join('\n').includes('local_m10'));
  assert.ok(!ssaRes.lines.join('\n').includes('local_x19'));

  // Mixed raw sp + SSA prologue
  const mixed = [
    'int64 sub_7001(int64 a1) {',
    '  uint64 local_m10;',
    '  uint64 local_x29;',
    '  *(uint64 *)(sp + 0x10) = x19;',
    '  local_m10 = local_x29;',
    '  int64 r = helper(a1);',
    '  x19 = *(uint64 *)(sp + 0x10);',
    '  local_x29 = local_m10;',
    '  return r;',
    '}',
  ];
  const mixedRes = formatCleanViewLines(mixed);
  assert.equal(mixedRes.stats.calleeSavedSpillsFolded, 4);
  assert.equal(mixedRes.stats.deadDeclsElided, 2);
  assert.ok(mixedRes.lines.some((l) => l.includes('/* [Clean View: folded 4 callee-saved prologue/epilogue spill ops] */')));

  // SSA folding still works independently even when sp escapes
  const spEscapedWithSsa = [
    'int64 sub_7002(int64 a1) {',
    '  uint64 local_m10;',
    '  uint64 local_x29;',
    '  local_m10 = local_x29;',
    '  take_ptr(&sp);',
    '  return a1;',
    '}',
  ];
  const escRes = formatCleanViewLines(spEscapedWithSsa);
  assert.equal(escRes.stats.calleeSavedSpillsFolded, 1);
  assert.equal(escRes.stats.deadDeclsElided, 2);
});

test('foldCalleeSavedSpills SSA soundness rejects param local_x19, body read/write, &local_m10, shadowed decl, and respects word boundaries (local_m1 vs local_m10)', () => {
  // Parameter named local_x19 at depth 0
  const paramCase = [
    'int64 sub_7100(uint64 local_x19) {',
    '  uint64 local_m10;',
    '  local_m10 = local_x19;',
    '  return 1;',
    '}',
  ];
  assert.equal(foldCalleeSavedStackSpills(paramCase).stats.calleeSavedSpillsFolded, 0);

  // Read/write of slotVar in body
  const bodyReadCase = [
    'int64 sub_7101(int64 a1) {',
    '  uint64 local_m10;',
    '  uint64 local_x29;',
    '  local_m10 = local_x29;',
    '  return local_m10 + a1;',
    '}',
  ];
  assert.equal(foldCalleeSavedStackSpills(bodyReadCase).stats.calleeSavedSpillsFolded, 0);

  // Write of regVar in body
  const bodyWriteCase = [
    'int64 sub_7102(int64 a1) {',
    '  uint64 local_m10;',
    '  uint64 local_x29;',
    '  local_m10 = local_x29;',
    '  local_x29 = a1;',
    '  return a1;',
    '}',
  ];
  assert.equal(foldCalleeSavedStackSpills(bodyWriteCase).stats.calleeSavedSpillsFolded, 0);

  // Address-taken &local_m10
  const addrTakenCase = [
    'int64 sub_7103(int64 a1) {',
    '  uint64 local_m10;',
    '  uint64 local_x29;',
    '  local_m10 = local_x29;',
    '  take_ptr(&local_m10);',
    '  return a1;',
    '}',
  ];
  assert.equal(foldCalleeSavedStackSpills(addrTakenCase).stats.calleeSavedSpillsFolded, 0);

  // Shadowed decl in nested block
  const shadowedCase = [
    'int64 sub_7104(int64 a1) {',
    '  uint64 local_m10;',
    '  uint64 local_x29;',
    '  local_m10 = local_x29;',
    '  if (a1) {',
    '    uint64 local_m10;',
    '    helper(a1);',
    '  }',
    '  return a1;',
    '}',
  ];
  assert.equal(foldCalleeSavedStackSpills(shadowedCase).stats.calleeSavedSpillsFolded, 0);

  // Initializer or array decl rejected
  const initDeclCase = [
    'int64 sub_7105(int64 a1) {',
    '  uint64 local_m10 = 0;',
    '  uint64 local_x29;',
    '  local_m10 = local_x29;',
    '  return a1;',
    '}',
  ];
  assert.equal(foldCalleeSavedStackSpills(initDeclCase).stats.calleeSavedSpillsFolded, 0);

  // Word-boundary check: live local_m1 must NOT block folding dead local_m10
  const wordBoundaryCase = [
    'int64 sub_7106(int64 a1) {',
    '  uint64 local_m10;',
    '  uint64 local_x29;',
    '  uint64 local_m1;',
    '  local_m10 = local_x29;',
    '  local_m1 = a1 + 1;',
    '  return local_m1;',
    '}',
  ];
  const wbRes = formatCleanViewLines(wordBoundaryCase);
  assert.equal(wbRes.stats.calleeSavedSpillsFolded, 1);
  assert.equal(wbRes.stats.deadDeclsElided, 2);
  const wbJoined = wbRes.lines.join('\n');
  assert.ok(!wbJoined.includes('local_m10'));
  assert.ok(wbJoined.includes('local_m1 = a1 + 1;'));
  assert.ok(wbJoined.includes('return local_m1;'));
});

test('refineAppleSwiftDecompile demangles _-stripped Itanium C++ signatures, calls, operators, and templates with balanced-paren stripping', () => {
  const pseudoC = [
    'int32 ZNK5Thing6updateEi(Thing * this, uint64 a2) {',
    '  ZN5ThingD0Ev(this);',
    '  ZN4BaseD2Ev(this);',
    '  void * p = Znwm(0x20);',
    '  ZdlPv(p);',
    '  int32 v = Z3fooi(a2);',
    '  int32 c = ZNK3FooclEi(this, v);',
    '  return c;',
    '}',
    'int64 ZNK3Foo3barIiEEvT_(Foo * this, int64 a2) {',
    '  return a2;',
    '}',
  ].join('\n');

  const { code, stats } = refineAppleSwiftDecompile(pseudoC);
  assert.equal(stats.symbolsDemangled, 8);
  assert.ok(code.includes('int32 Thing::update(Thing * this, uint64 a2) {'), `got:\n${code}`);
  assert.ok(code.includes('Thing::~Thing(this);'), `got:\n${code}`);
  assert.ok(code.includes('Base::~Base(this);'), `got:\n${code}`);
  assert.ok(code.includes('void * p = operator new(0x20);'), `got:\n${code}`);
  assert.ok(code.includes('operator delete(p);'), `got:\n${code}`);
  assert.ok(code.includes('int32 v = foo(a2);'), `got:\n${code}`);
  assert.ok(code.includes('int32 c = Foo::operator()(this, v);'), `got:\n${code}`);
  assert.ok(code.includes('int64 Foo::bar<int>(Foo * this, int64 a2) {'), `got:\n${code}`);
});

test('refineAppleSwiftDecompile preserves strings, comments, identifier boundaries, and rejects short false positives (Z1a, Z2ab, Z3foo, Zdl)', () => {
  const pseudoC = [
    'void sub_8000(void) {',
    '  const char * s1 = "ZNK5Thing6updateEi and \\"ZN5ThingD0Ev\\"";',
    "  char c1 = 'Z'; // ZNK5Thing6updateEi",
    '  /* ZN5ThingD0Ev and ZdlPv */',
    '  int Z1a = 1;',
    '  int Z2ab = 2;',
    '  int Z3foo = 3;',
    '  int Zdl = 4;',
    '  prefixZNK5Thing6updateEi(Z1a, Z2ab, Z3foo, Zdl);',
    '  foo_ZNK5Thing6updateEi(Z1a);',
    '}',
  ].join('\n');

  const { code, stats } = refineAppleSwiftDecompile(pseudoC);
  assert.equal(stats.symbolsDemangled, 0);
  assert.equal(code, pseudoC);
});

test('refineAppleSwiftDecompile demangles _-stripped std:: nested Itanium C++ symbols (ZNSt, ZNKSt, ZNSa) while rejecting bare prefixes', () => {
  const input = [
    'void ZNSt3__16vectorIiNS_9allocatorIiEEE9push_backERKi(void *vec, const int *val);',
    'uint64 ZNKSt3__112basic_stringIcNS_11char_traitsIcEENS_9allocatorIcEEE4sizeEv(void *s);',
    'void ZNSaIiED1Ev(void *alloc);',
    'int ZNSt = 1;',
    'int ZNSa = 2;',
  ].join('\n');
  const res = refineAppleSwiftDecompile(input);
  assert.match(res.code, /push_back\(void \*vec, const int \*val\);/);
  assert.match(res.code, /size\(void \*s\);/);
  assert.match(res.code, /~allocator\(void \*alloc\);/);
  assert.match(res.code, /int ZNSt = 1;/);
  assert.match(res.code, /int ZNSa = 2;/);
  assert.equal(res.stats.symbolsDemangled, 3);
});
