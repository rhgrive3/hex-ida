import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSemanticModel } from '../js/blocks.js';
import { decompile, decompileWithProof } from '../js/decompile.js';
import {
  decompile as baseDecompile,
  semanticModelForDecompiler,
} from '../js/decompile-base.js';
import { EMPTY_NOTES, NoteStore } from '../js/names.js';
import {
  elideDeadStackSpills,
  foldCalleeSavedStackSpills,
  formatCleanViewLines,
  formatCleanViewText,
} from '../js/decompiler/clean-view.js';
import { refineAppleSwiftDecompile } from '../js/decompiler/apple-arc-swift-pass.js';
import { printExpression, integerText } from '../js/decompiler/pretty/c.js';

function makeArm64Model(entries, extra = {}) {
  const base = extra.baseAddr ?? 0x10000n;
  const raw = entries.map((entry, row) => ({
    row,
    address: entry.address !== undefined ? entry.address : base + BigInt(row * 4),
    mn: entry.mn,
    ops: entry.ops ?? '',
    ...(entry.word !== undefined ? { word: entry.word } : {}),
  }));
  const rowOfAddress = (addr) => {
    try {
      const target = BigInt(addr);
      const found = raw.find((r) => r.address != null && BigInt(r.address) === target);
      return found ? found.row : null;
    } catch {
      return null;
    }
  };
  const addrOfRow = (row) => raw[row]?.address ?? null;
  const opts = {
    startRow: 0,
    endRow: raw.length - 1,
    addr: base,
    rowOfAddress,
    addrOfRow,
    symbolFor: () => null,
    ...extra,
  };
  const model = buildSemanticModel(raw, opts);
  for (let i = 0; i < raw.length; i++) {
    if (raw[i].word !== undefined && model.instructions?.[i]) {
      model.instructions[i].word = raw[i].word;
    }
    if (entries[i].address !== undefined && model.instructions?.[i]) {
      model.instructions[i].address = entries[i].address;
    }
  }
  model.arch = extra.arch ?? 'arm64';
  model.name = extra.name ?? 'sub_10000';
  return { model, opts };
}

// ============================================================================
// 1. js/decompile.js
// ============================================================================

test('decompile.js: tryWasmDecompile respects forceLegacyDecompiler, semanticIR=false, proof, notes, objcSyntax=c, shouldAbort', async () => {
  const { model, opts } = makeArm64Model([
    { mn: 'add', ops: 'w0, w0, w1', word: 0x0b010000 },
    { mn: 'ret', ops: '', word: 0xd65f03c0 },
  ]);

  const legacyForced = decompile(model, { ...opts, forceLegacyDecompiler: true });
  assert.notEqual(legacyForced.wasmAccelerated, true, 'forceLegacyDecompiler must bypass WASM');

  const noSemantic = decompile(model, { ...opts, semanticIR: false });
  assert.notEqual(noSemantic.wasmAccelerated, true, 'semanticIR:false must bypass WASM');

  const proofRes = await decompileWithProof(model, opts);
  assert.notEqual(proofRes.wasmAccelerated, true, 'decompileWithProof must bypass WASM');
  assert.notEqual(
    proofRes.proofOptimization?.reason,
    'semantic-projection-required',
    'decompileWithProof must not fail with semantic-projection-required due to WASM shortcut',
  );

  // EMPTY_NOTES must NOT disable WASM fast path
  const withEmptyNotes = decompile(model, { ...opts, notes: EMPTY_NOTES });
  assert.equal(typeof withEmptyNotes.pseudocode, 'string');
  const defaultRes = decompile(model, opts);
  assert.equal(withEmptyNotes.wasmAccelerated, defaultRes.wasmAccelerated, 'EMPTY_NOTES must preserve WASM routing');

  // Active NoteStore must fall back to JS
  const activeStore = new NoteStore(null);
  activeStore.names.set('65536', 'custom_add');
  const withActiveNotes = decompile(model, { ...opts, notes: activeStore });
  assert.notEqual(withActiveNotes.wasmAccelerated, true, 'populated NoteStore must fall back to JS');

  // Custom note provider object must fall back to JS
  const customProvider = { nameOf: () => 'provider_fn' };
  const withCustomProvider = decompile(model, { ...opts, notes: customProvider });
  assert.notEqual(withCustomProvider.wasmAccelerated, true, 'custom notes provider must fall back to JS');

  // objcSyntax === 'c' must fall back to JS
  const withObjcC = decompile(model, { ...opts, objcSyntax: 'c' });
  assert.notEqual(withObjcC.wasmAccelerated, true, 'objcSyntax:c must fall back to JS');

  // shouldAbort function must fall back to JS and honor AbortError
  const withAbort = decompile(model, { ...opts, shouldAbort: () => false });
  assert.notEqual(withAbort.wasmAccelerated, true, 'shouldAbort must fall back to JS');
  assert.throws(
    () => decompile(model, {
      ...opts,
      shouldAbort: () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      },
    }),
    (err) => err?.name === 'AbortError',
  );
});

test('decompile.js: extractArm64Words rejects non-contiguous and partially missing addresses, and toBigIntSafe avoids crash', () => {
  const { model: nonContig, opts: opts1 } = makeArm64Model([
    { address: 0x10000n, mn: 'b', ops: '#0x10008', word: 0x14000002 },
    { address: 0x10008n, mn: 'ret', ops: '', word: 0xd65f03c0 },
  ]);
  const r1 = decompile(nonContig, opts1);
  assert.notEqual(r1.wasmAccelerated, true, 'non-contiguous ARM64 instructions must fall back to JS');

  const { model: partialAddr, opts: opts2 } = makeArm64Model([
    { address: null, mn: 'add', ops: 'w0, w0, w1', word: 0x0b010000 },
    { address: 0x10004n, mn: 'ret', ops: '', word: 0xd65f03c0 },
  ]);
  const r2 = decompile(partialAddr, opts2);
  assert.notEqual(r2.wasmAccelerated, true, 'partially missing ARM64 addresses must fall back to JS');

  const { model: badAddr, opts: opts3 } = makeArm64Model([
    { mn: 'ret', ops: '', word: 0xd65f03c0 },
  ]);
  badAddr.instructions[0].address = 'not-an-addr';
  assert.doesNotThrow(() => {
    const r3 = decompile(badAddr, { ...opts3, addr: Number.NaN });
    assert.notEqual(r3.wasmAccelerated, true);
  });

  const { model: partialX86, opts: opts4 } = makeArm64Model(
    [
      { address: null, mn: 'nop', ops: '' },
      { address: 0x10001n, mn: 'ret', ops: '' },
    ],
    { arch: 'x86_64' },
  );
  partialX86.instructions[0].rawBytes = new Uint8Array([0x90]);
  partialX86.instructions[1].rawBytes = new Uint8Array([0xc3]);
  const r4 = decompile(partialX86, opts4);
  assert.notEqual(r4.wasmAccelerated, true, 'partially missing x86_64 addresses must fall back to JS');
});

// ============================================================================
// 2. js/decompile-base.js
// ============================================================================

test('decompile-base.js: semanticModelForDecompiler ignores null/undefined instruction entries without throwing', () => {
  const model = {
    instructions: [
      null,
      undefined,
      { mnemonic: 'b', ops: [{ k: 'other', text: '0x2000' }] },
    ],
  };
  const out = semanticModelForDecompiler(model);
  assert.equal(out.instructions[2].branchTarget, 0x2000n);
});

test('decompile-base.js: numeric opts.addr does not throw BigInt mixing TypeError in blockAddress fallback', () => {
  const { model, opts } = makeArm64Model([
    { mn: 'cmp', ops: 'w0, #0' },
    { mn: 'b.ne', ops: '#0x1000c' },
    { mn: 'ret', ops: '' },
    { mn: 'add', ops: 'w0, w0, #1' },
    { mn: 'b', ops: '#0x10000' },
  ]);
  // Force numeric addr and drop one instruction's row lookup to hit blockAddress fallback arithmetic
  const numOpts = { ...opts, addr: 0x10000, addrOfRow: () => null };
  assert.doesNotThrow(() => {
    const res = baseDecompile(model, numOpts);
    assert.equal(typeof res.pseudocode, 'string');
  });
});

// ============================================================================
// 3. js/decompiler/clean-view.js
// ============================================================================

test('clean-view.js: elideDeadStackSpills preserves spills after braceless control flow (including intervening comments/blanks) and inside multi-line block comments', () => {
  const bracelessInput = [
    'int f(int a) {',
    '  int var_10;',
    '  if (a > 0)',
    '    var_10 = a;',
    '  return 0;',
    '}',
  ];
  const bracelessRes = elideDeadStackSpills(bracelessInput);
  assert.equal(bracelessRes.stats.deadSpillsElided, 0);
  assert.ok(bracelessRes.lines.some((l) => l.includes('var_10 = a;')));
  assert.ok(bracelessRes.lines.some((l) => l.includes('int var_10;')));

  const bracelessWithComment = [
    'int f(int a) {',
    '  int var_10;',
    '  if (a > 0)',
    '    /* note */',
    '',
    '    var_10 = a;',
    '  return 0;',
    '}',
  ];
  const bracelessCommentRes = elideDeadStackSpills(bracelessWithComment);
  assert.equal(bracelessCommentRes.stats.deadSpillsElided, 0);
  assert.ok(bracelessCommentRes.lines.some((l) => l.includes('var_10 = a;')));

  const multilineComment = [
    'int f() {',
    '  /* start comment',
    '  var_10 = 1;',
    '  end comment */',
    '  return 0;',
    '}',
  ];
  const commentRes = elideDeadStackSpills(multilineComment);
  assert.equal(commentRes.stats.deadSpillsElided, 0);
  assert.deepEqual(commentRes.lines, multilineComment);
});

test('clean-view.js: foldCalleeSavedStackSpills scopes non-SSA folding and summary comments per function', () => {
  const multiFn = [
    'int f1(int a) {',
    '  *(uint64 *)(sp + 0x10) = x19;',
    '  x19 = *(uint64 *)(sp + 0x10);',
    '  return a;',
    '}',
    'int f2(int b) {',
    '  *(uint64 *)(sp + 0x10) = x20;',
    '  x20 = *(uint64 *)(sp + 0x10);',
    '  return x19 + b;',
    '}',
  ];
  const res = foldCalleeSavedStackSpills(multiFn);
  assert.equal(res.stats.calleeSavedSpillsFolded, 4);
  const summaryLines = res.lines.filter((l) => l.includes('[Clean View: folded 2 callee-saved'));
  assert.equal(summaryLines.length, 2, 'each function should receive its own per-function summary');
});

test('clean-view.js: formatCleanViewLines propagates block comment and braceless control-flow state across lines', () => {
  const lines = [
    'int f(id x) {',
    '  /* doc:',
    '  objc_release(x);',
    '  _Z3fooi(1);',
    '  */',
    '  if (x != 0)',
    '    /* intervening comment */',
    '    objc_release(x);',
    '  return 1;',
    '}',
  ];
  const res = formatCleanViewLines(lines);
  assert.equal(res.stats.arcLinesRemoved, 0, 'neither commented nor braceless-if ARC drop should be elided');
  assert.equal(res.stats.symbolsDemangled, 0, 'symbols inside multi-line block comment must not be demangled');
  const joined = res.lines.join('\n');
  assert.ok(joined.includes('_Z3fooi(1);'));
  assert.ok(joined.includes('objc_release(x);'));
});

// ============================================================================
// 4. js/decompiler/apple-arc-swift-pass.js
// ============================================================================

test('apple-arc-swift-pass.js: protects braceless control flow, side-effecting ARC args, strings/comments, nested ObjC calls, and compound literals', () => {
  const braceless = [
    'int f(id x) {',
    '  if (x != 0)',
    '    /* cleanup */',
    '    objc_release(x);',
    '  return 1;',
    '}',
  ].join('\n');
  const bracelessOut = refineAppleSwiftDecompile(braceless);
  assert.equal(bracelessOut.stats.arcLinesRemoved, 0);
  assert.ok(bracelessOut.code.includes('objc_release(x);'));

  const sideEff = [
    'void f(id *arr, int i) {',
    '  objc_release(side_effect());',
    '  objc_release(arr[i++]);',
    '  objc_storeStrong(&arr[get_idx()], 0);',
    '}',
  ].join('\n');
  const sideEffOut = refineAppleSwiftDecompile(sideEff);
  assert.equal(sideEffOut.stats.arcLinesRemoved, 0);
  assert.ok(sideEffOut.code.includes('objc_release(side_effect());'));
  assert.ok(sideEffOut.code.includes('objc_release(arr[i++]);'));
  assert.ok(sideEffOut.code.includes('objc_storeStrong(&arr[get_idx()], 0);'));

  const strComment = 'printf("objc_retain(x0) _objc_msgSend$foo(x0)"); // objc_msgSend(x0, "bar")';
  const strCommentOut = refineAppleSwiftDecompile(strComment);
  assert.equal(strCommentOut.code, strComment);
  assert.equal(strCommentOut.stats.arcOpsFolded, 0);
  assert.equal(strCommentOut.stats.objcStubsRewritten, 0);
  assert.equal(strCommentOut.stats.objcDirectRewritten, 0);

  const nestedStub = refineAppleSwiftDecompile('id r = _objc_msgSend$bar:(_objc_msgSend$foo(x0), x1);');
  assert.equal(nestedStub.code, 'id r = [[x0 foo] bar:x1];');
  assert.equal(nestedStub.stats.objcStubsRewritten, 2);

  const nestedDirect = refineAppleSwiftDecompile('id r = objc_msgSend(objc_msgSend(x0, "foo"), "bar:", x1);');
  assert.equal(nestedDirect.code, 'id r = [[x0 foo] bar:x1];');
  assert.equal(nestedDirect.stats.objcDirectRewritten, 2);

  const compound = refineAppleSwiftDecompile('_objc_msgSend$setRect:(obj, (CGRect){0, 1, 2, 3});');
  assert.equal(compound.code, '[obj setRect:(CGRect){0, 1, 2, 3}];');

  // Pure state contract: input state object is not mutated
  const inputState = Object.freeze({ inBlockComment: false, prevLineBracelessCtrl: false });
  const step1 = refineAppleSwiftDecompile('if (x != 0)', { state: inputState });
  assert.equal(inputState.prevLineBracelessCtrl, false);
  assert.equal(step1.state.prevLineBracelessCtrl, true);
  const step2 = refineAppleSwiftDecompile('  /* comment */', { state: step1.state });
  assert.equal(step2.state.prevLineBracelessCtrl, true);
  const step3 = refineAppleSwiftDecompile('  objc_release(x);', { state: step2.state });
  assert.equal(step3.stats.arcLinesRemoved, 0);
  assert.equal(step3.state.prevLineBracelessCtrl, false);
});

// ============================================================================
// 5. js/decompiler/pretty/c.js
// ============================================================================

test('pretty/c.js: prevents double-minus (--5 / --x / --0.0) on unary negation', () => {
  assert.equal(
    printExpression({ kind: 'unary', op: 'neg', arg: { kind: 'const', value: -5n, bits: 64, signed: true } }),
    '-(-5)',
  );
  assert.equal(
    printExpression({ kind: 'unary', op: 'neg', arg: { kind: 'unary', op: 'neg', arg: { kind: 'var', name: 'x' } } }),
    '-(-x)',
  );
  assert.equal(
    printExpression({ kind: 'unary', op: 'fneg', arg: { kind: 'float-const', value: -0, bits: 64 } }),
    '-(-0.0)',
  );
});

test('pretty/c.js: guardedDivision catches numeric 0, width-wrapped 0, and preserves recursive LHS side effects', () => {
  assert.equal(
    printExpression({
      kind: 'binary',
      op: 'sdiv',
      bits: 32,
      left: { kind: 'var', name: 'a' },
      right: { kind: 'const', value: 0, bits: 32 },
    }),
    '0',
  );
  assert.equal(
    printExpression({
      kind: 'binary',
      op: 'udiv',
      bits: 32,
      left: { kind: 'var', name: 'a' },
      right: { kind: 'const', value: 0x100000000n, bits: 32 },
    }),
    '0',
  );
  const sideEffDiv = printExpression({
    kind: 'binary',
    op: 'sdiv',
    bits: 32,
    left: {
      kind: 'binary',
      op: 'add',
      bits: 32,
      left: { kind: 'call', callee: 'compute', args: [{ kind: 'var', name: 'x' }] },
      right: { kind: 'const', value: 1n, bits: 32 },
    },
    right: { kind: 'const', value: 0n, bits: 32 },
  });
  assert.ok(sideEffDiv.includes('compute(x)'), `expected side-effecting LHS to be preserved, got: ${sideEffDiv}`);
  assert.ok(sideEffDiv.includes('(int32_t)0'), `expected typed zero result, got: ${sideEffDiv}`);
});

test('pretty/c.js: integerText masks narrow widths while preserving signed negatives and INT64_MIN compatibility', () => {
  assert.equal(integerText(5n, 1, false), '1');
  assert.equal(integerText(2n, 1, false), '0');
  assert.equal(integerText(-20n, 6, true), '-20');
  assert.equal(integerText(-9223372036854775808n, 64, true), '-9223372036854775808');
});

test('pretty/c.js: parenthesizes cast-prefixed var bases in field/index, normalizes uppercase FP unary ops, uses effectiveArg width, and emits llabs for 64-bit abs', () => {
  assert.equal(
    printExpression({ kind: 'field', base: { kind: 'var', name: '(struct Foo *)x0' }, offset: 16 }),
    '((struct Foo *)x0)->field_10',
  );
  assert.equal(
    printExpression(
      { kind: 'index', base: { kind: 'var', name: '(uint64_t *)x0' }, index: { kind: 'var', name: 'i' } },
      0,
      { indexBaseIsPointer: true },
    ),
    '((uint64_t *)x0)[i]',
  );
  assert.equal(
    printExpression({
      kind: 'unary',
      op: 'FABS',
      bits: 32,
      arg: { kind: 'unary', op: 'zext', bits: 64, arg: { kind: 'var', name: 's0', bits: 32 } },
    }),
    'fabsf(s0)',
  );
  assert.equal(
    printExpression({
      kind: 'unary',
      op: 'fcvtps',
      bits: 32,
      arg: { kind: 'unary', op: 'zext', bits: 64, arg: { kind: 'var', name: 's0', bits: 32 } },
    }),
    '((int32_t)ceilf(s0))',
  );
  assert.equal(
    printExpression({ kind: 'unary', op: 'abs', bits: 64, arg: { kind: 'var', name: 'x0' } }),
    'llabs(x0)',
  );
  assert.equal(
    printExpression({ kind: 'unary', op: 'abs', bits: 32, arg: { kind: 'var', name: 'w0' } }),
    'abs(w0)',
  );
});

test('clean-view.js: formatCleanViewText remains backward-compatible end-to-end', () => {
  const res = formatCleanViewText([
    'typedef unsigned char uint8;',
    'id sub_1000(id self) {',
    '  uint64 var_8;',
    '  var_8 = 0x10;',
    '  return _objc_msgSend$bar:(_objc_msgSend$foo(self), 1);',
    '}',
  ].join('\n'));
  assert.equal(res.stats.typedefsHidden, 1);
  assert.equal(res.stats.deadSpillsElided, 1);
  assert.ok(res.code.includes('return [[self foo] bar:1];'));
});
