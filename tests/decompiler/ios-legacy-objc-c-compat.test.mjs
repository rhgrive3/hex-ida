import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import { buildSemanticModel } from '../../js/blocks.js';
import { decompile } from '../../js/decompile.js';
import { decompile as legacyDecompile } from '../../js/decompile-legacy.js';
import { render as renderExpr } from '../../js/expr.js';
import { formatObjcMessage, objcMessage } from '../../js/apple/objc-runtime.js';
import { resolveAppleCall } from '../../js/apple/runtime.js';
import { buildCTranslationUnit } from '../../js/analysis/query/translation-unit.js';

const BASE = 0x10000n;

function assertCompilesAsC(source, label = 'generated C') {
  try {
    execFileSync('gcc', ['-x', 'c', '-fsyntax-only', '-'], {
      input: source,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    const stderr = err?.stderr ? String(err.stderr) : String(err?.message || err);
    assert.fail(`${label} failed gcc -x c -fsyntax-only:\n${stderr}\n--- SOURCE ---\n${source}`);
  }
}

function makeModel(lines, extra = {}) {
  const raw = lines.map((entry, row) => {
    if (typeof entry === 'string') {
      const p = entry.indexOf(' ');
      return {
        row,
        address: BASE + BigInt(row * 4),
        mn: p < 0 ? entry : entry.slice(0, p),
        ops: p < 0 ? '' : entry.slice(p + 1),
      };
    }
    return { row, address: BASE + BigInt(row * 4), ...entry };
  });
  const rowOfAddress = (addr) => {
    const d = BigInt(addr) - BASE;
    if (d < 0n || d >= BigInt(raw.length * 4) || d % 4n !== 0n) return null;
    return Number(d / 4n);
  };
  const addrOfRow = (row) => raw[row]?.address ?? null;
  const symbolFor = extra.symbolFor || (() => null);
  const opts = {
    startRow: 0,
    endRow: raw.length - 1,
    addr: BASE,
    rowOfAddress,
    addrOfRow,
    symbolFor,
    ...extra,
  };
  const model = buildSemanticModel(raw, opts);
  return { model, opts };
}

test('1. Legacy decompiler sanitizes C++ signatures and raw symbols for GCC -x c', () => {
  const symbols = new Map([
    [0x20040n, 'CryptoPP::GlobalTable<int>::kData'],
    [0x30000n, 'CryptoPP::AES<128>::ProcessBlock'],
  ]);
  const { model, opts } = makeModel([
    'adrp x8, #0x20000',
    'add x8, x8, #0x40',
    'ldr x9, [x8]',
    'bl #0x30000',
    'ret',
  ], { symbolFor: (a) => symbols.get(a) || null });
  model.addressRefs = [
    { row: 0, addr: 0x20040n, load: false },
    { row: 1, addr: 0x20040n, load: false },
    { row: 2, addr: 0x20040n, load: true },
  ];
  model.calls = [
    { row: 3, target: 0x30000n, name: 'CryptoPP::AES<128>::ProcessBlock', args: [{ index: 0, value: { kind: 'address', addr: 0x20040n } }] },
  ];
  const res = decompile(model, {
    ...opts,
    forceLegacyDecompiler: true,
    name: 'CryptoPP::AdditiveCipherTemplate<int>::GenerateBlock',
  });
  assert.doesNotMatch(res.signature, /::|<|>/);
  assert.doesNotMatch(res.pseudocode, /::|<int>|<128>/);
  assert.match(res.signature, /AdditiveCipherTemplate_int_GenerateBlock/);
  assertCompilesAsC(res.pseudocode, 'C++ legacy signature & symbols');
});

test('2. escapeText truncates before escaping and safely escapes control chars in legacy and expr', () => {
  // 119 'a' chars followed by '\"' and '\\' right across the 120-char boundary
  const boundaryLegacy = 'a'.repeat(119) + '\\"tail\x01\x1b\x00end';
  const { model, opts } = makeModel([
    'adrp x0, #0x40000',
    'add x0, x0, #0x10',
    'ret',
  ]);
  model.addressRefs = [
    { row: 1, addr: 0x40010n, load: false, text: boundaryLegacy },
  ];
  const res = decompile(model, { ...opts, forceLegacyDecompiler: true });
  assert.doesNotMatch(res.pseudocode, /[\x00-\x08\x0b\x0c\x0e-\x1f]/);
  assertCompilesAsC(res.pseudocode, 'legacy escapeText boundary');

  // Control chars within the first 120 chars
  const ctrlStr = 'hello\x01abc\x1b[31m"quoted"\\';
  const { model: model2, opts: opts2 } = makeModel(['adrp x0, #0x40000', 'add x0, x0, #0x10', 'ret']);
  model2.addressRefs = [{ row: 1, addr: 0x40010n, load: false, text: ctrlStr }];
  const res2 = decompile(model2, { ...opts2, forceLegacyDecompiler: true });
  assert.match(res2.pseudocode, /\\001abc/);
  assertCompilesAsC(res2.pseudocode, 'legacy escapeText control chars');

  // expr.js 90-char boundary ending in backslash / quote / control char
  const boundaryExpr = 'b'.repeat(89) + '\\"overflow';
  const rendered = renderExpr({ k: 'str', text: boundaryExpr });
  assertCompilesAsC(`const char *s = ${rendered};\n`, 'expr escapeText boundary');

  const ctrlExpr = renderExpr({ k: 'str', text: 'x\x02deadbeef\\"' });
  assertCompilesAsC(`const char *s = ${ctrlExpr};\n`, 'expr escapeText control chars');
});

test('3. Legacy svc #0x80, __data, __asm, and fallback placeholders compile as valid C', () => {
  const { model, opts } = makeModel([
    { mn: '.word', ops: '#0xdeadbeef', data: true },
    { mn: 'custom_op', ops: 'x0, "raw\\quote"' },
    'svc #0x80',
    'ret',
  ]);
  model.instructions[0].data = true;
  const res = decompile(model, { ...opts, forceLegacyDecompiler: true });

  assert.match(res.pseudocode, /__syscall\(0x80\);/);
  assert.doesNotMatch(res.pseudocode, /__syscall\(#/);
  assert.doesNotMatch(res.pseudocode, /__data\(#/);
  assert.match(res.pseudocode, /__asm\("custom_op x0, \\"raw\\\\quote\\""\);/);
  assertCompilesAsC(res.pseudocode, 'legacy svc/__data/__asm');

  // Verify '?' / '*(?)' fallback does not appear when operands are missing
  const { model: brokenModel, opts: brokenOpts } = makeModel([
    'ldxr x0, [x1]',
    'ret',
  ]);
  brokenModel.instructions[0].ops = [];
  const brokenRes = legacyDecompile(brokenModel, brokenOpts);
  const brokenText = brokenRes.lines.map((l) => l.text).join('\n');
  assert.doesNotMatch(brokenText, /\*\(\?\)/);
  assert.doesNotMatch(brokenText, /(?:^|[^a-zA-Z0-9_])\?(?:[^a-zA-Z0-9_]|$)/);
});

test('4. expr.js renders ror/smulh/umulh as C function calls and never truncates with ellipsis', () => {
  const rorStr = renderExpr({ k: 'bin', op: 'ror', a: { k: 'reg', reg: 'x0' }, b: { k: 'const', v: 7n } });
  const smulhStr = renderExpr({ k: 'bin', op: 'smulh', a: { k: 'reg', reg: 'x0' }, b: { k: 'reg', reg: 'x1' } });
  const umulhStr = renderExpr({ k: 'bin', op: 'umulh', a: { k: 'reg', reg: 'x0' }, b: { k: 'reg', reg: 'x1' } });
  assert.equal(rorStr, 'ror(x0, 7)');
  assert.equal(smulhStr, 'smulh(x0, x1)');
  assert.equal(umulhStr, 'umulh(x0, x1)');
  assert.doesNotMatch(rorStr + smulhStr + umulhStr, />>>|\*hi/);

  // Long expression exceeding default 220-char old maxLen must not contain '…'
  let chain = { k: 'reg', reg: 'var_long_identifier_0' };
  for (let i = 1; i <= 15; i++) {
    chain = { k: 'bin', op: 'add', a: chain, b: { k: 'reg', reg: `var_long_identifier_${i}` } };
  }
  const longRendered = renderExpr(chain, { maxLen: 80 });
  assert.ok(longRendered.length > 220, 'long expression should remain complete');
  assert.doesNotMatch(longRendered, /…/);

  // Deeply nested expression beyond MAX_DEPTH must not emit '…'
  let deep = { k: 'reg', reg: 'x0' };
  for (let i = 0; i < 30; i++) {
    deep = { k: 'bin', op: 'add', a: deep, b: { k: 'const', v: 1n } };
  }
  const deepRendered = renderExpr(deep);
  assert.doesNotMatch(deepRendered, /…/);
  assertCompilesAsC(`unsigned long long f(unsigned long long x0) { return ${deepRendered}; }\n`, 'deep expr');
});

test('5. formatObjcMessage and resolveAppleCall preserve default objc/dot styles and support style="c"', () => {
  // Default 'objc' unchanged
  assert.equal(
    formatObjcMessage({ receiver: 'NSString', selector: 'stringWithFormat:', args: ['@"%@ %@"', 'left', 'right'] }),
    '[NSString stringWithFormat:@"%@ %@", left, right]',
  );
  // 'dot' unchanged
  assert.equal(
    formatObjcMessage({ receiver: 'NSString', selector: 'stringWithFormat:', args: ['@"%@ %@"', 'left', 'right'], style: 'dot' }),
    'NSString.stringWithFormat(@"%@ %@", left, right)',
  );
  // Opt-in 'c' strips leading '@' from ObjC string literals
  assert.equal(
    formatObjcMessage({ receiver: 'NSString', selector: 'stringWithFormat:', args: ['@"%@ %@"', 'left', 'right'], style: 'c' }),
    'objc_msgSend(NSString, "stringWithFormat:", "%@ %@", left, right)',
  );
  assert.equal(
    formatObjcMessage({ receiver: 'self', selector: 'viewDidLoad', args: [], style: 'c', callee: 'objc_msgSendSuper2' }),
    'objc_msgSendSuper2(self, "viewDidLoad")',
  );

  // objcMessage forwards callee
  const msg = objcMessage(null, { receiver: 'obj', selector: 'setVal:', args: ['x2'], style: 'c', callee: 'objc_msgSendSuper2' });
  assert.equal(msg.text, 'objc_msgSendSuper2(obj, "setVal:", x2)');

  // resolveAppleCall relays style and infers objc_msgSendSuper2
  const resolvedDefault = resolveAppleCall(null, {
    symbol: '_objc_msgSend', receiver: 'player', selector: 'addCoins:', args: ['amount'],
  });
  assert.equal(resolvedDefault.message.text, '[player addCoins:amount]');

  const resolvedC = resolveAppleCall(null, {
    symbol: '_objc_msgSendSuper2', receiver: 'self', selector: 'setVal:forKey:', args: ['x2', '@"k"'], style: 'c',
  });
  assert.equal(resolvedC.message.text, 'objc_msgSendSuper2(self, "setVal:forKey:", x2, "k")');
});

test('6. Legacy decompile supports objcSyntax="c" while preserving default bracket syntax', () => {
  const { model, opts } = makeModel([
    'mov x2, #7',
    'bl #0x20000',
    'bl #0x20010',
    'ret',
  ]);
  model.calls = [
    { row: 1, target: 0x20000n, name: '_objc_msgSend$setValue:', selector: 'setValue:', args: [] },
    { row: 2, target: 0x20010n, name: '_objc_msgSendSuper2$reload', selector: 'reload', args: [] },
  ];

  // Default remains ObjC bracket syntax
  const defaultRes = decompile(model, { ...opts, forceLegacyDecompiler: true });
  assert.match(defaultRes.pseudocode, /\[.*setValue:7\]/);
  assert.match(defaultRes.pseudocode, /\[.*reload\]/);

  // Opt-in objcSyntax: 'c' emits valid C objc_msgSend / objc_msgSendSuper2 calls
  const cRes = decompile(model, { ...opts, forceLegacyDecompiler: true, objcSyntax: 'c' });
  assert.match(cRes.pseudocode, /objc_msgSend\([^,]+, "setValue:", 7\)/);
  assert.match(cRes.pseudocode, /objc_msgSendSuper2\([^,]+, "reload"\)/);
  assertCompilesAsC(cRes.pseudocode, 'legacy objcSyntax=c');
});

test('7. Semantic restoreObjcMethodSignature supports objcSyntax="c" and keeps default ObjC signature', () => {
  const { model, opts } = makeModel([
    'add x0, x2, x3',
    'ret',
  ]);
  const defaultRes = decompile(model, {
    ...opts,
    name: '-[SettingsVC applyTheme:forKey:]',
    returnType: 'id',
  });
  assert.match(defaultRes.signature, /^id -\[SettingsVC applyTheme:forKey:\]\(/);
  assert.doesNotMatch(defaultRes.signature, /\bself\b|\b_cmd\b/);

  const cInstRes = decompile(model, {
    ...opts,
    name: '-[SettingsVC applyTheme:forKey:]',
    returnType: 'id',
    objcSyntax: 'c',
  });
  assert.match(cInstRes.signature, /^id objc_inst_SettingsVC_applyTheme_forKey\(id self, void \* _cmd,/);
  assertCompilesAsC(cInstRes.pseudocode, 'semantic objcSyntax=c instance method');

  const cClsRes = decompile(model, {
    ...opts,
    name: '+[SettingsVC sharedInstance]',
    returnType: 'id',
    objcSyntax: 'c',
  });
  assert.match(cClsRes.signature, /^id objc_cls_SettingsVC_sharedInstance\(id self, void \* _cmd\)$/);
  assertCompilesAsC(cClsRes.pseudocode, 'semantic objcSyntax=c class method');
});

test('8. Translation Unit emits typedef void * id, compiles objcSyntax="c", and fails closed on raw ObjC brackets', () => {
  const objcCSource = [
    'typedef void * id;',
    'typedef __UINT64_TYPE__ uint64;',
    'id objc_inst_SettingsVC_applyTheme(id self, void * _cmd, uint64 a3)',
    '{',
    '    uint64 x0;',
    '    x0 = objc_msgSend(self, "setDarkMode:", a3);',
    '    return (id)x0;',
    '}',
  ].join('\n');

  const tuC = buildCTranslationUnit([{ address: 0x1000n, pseudocode: objcCSource }]);
  assert.ok(tuC.typeDeclarations.includes('typedef void * id;'), 'TU should declare typedef void * id');
  assert.equal(tuC.functions[0].syntaxOnly, false, 'objcSyntax=c function should be emitted faithfully');
  assertCompilesAsC(tuC.source, 'TU with objcSyntax=c and id type');

  // Raw ObjC bracket syntax inside a C-named function must fail closed
  const rawObjcSource = [
    'typedef __UINT64_TYPE__ uint64;',
    'uint64 sub_2000(uint64 a1, uint64 a2)',
    '{',
    '    uint64 x0;',
    '    uint64 setDarkMode;',
    '    uint64 forKey;',
    '    x0 = [a1 setDarkMode:a2 forKey:1];',
    '    return x0;',
    '}',
  ].join('\n');
  const tuRaw = buildCTranslationUnit([{ address: 0x2000n, pseudocode: rawObjcSource }]);
  assert.equal(tuRaw.functions[0].syntaxOnly, true, 'raw ObjC bracket syntax must fail closed');
  assert.ok(
    tuRaw.unresolved.some((u) => u.reason === 'objc-message-syntax-unavailable'),
    'unresolved should record objc-message-syntax-unavailable',
  );
  assertCompilesAsC(tuRaw.source, 'TU fail-closed on raw ObjC brackets');

  // Standard C array subscripting (including ternary index) must NOT trigger ObjC gate
  const cSubscriptSource = [
    'typedef __UINT64_TYPE__ uint64;',
    'uint64 sub_3000(uint64 * a1, uint64 a2)',
    '{',
    '    uint64 x0;',
    '    x0 = a1[a2 ? 1 : 0];',
    '    return x0;',
    '}',
  ].join('\n');
  const tuSub = buildCTranslationUnit([{ address: 0x3000n, pseudocode: cSubscriptSource }]);
  assert.equal(tuSub.functions[0].syntaxOnly, false, 'C array subscript must remain eligible');
  assertCompilesAsC(tuSub.source, 'TU with C array subscript');
});
