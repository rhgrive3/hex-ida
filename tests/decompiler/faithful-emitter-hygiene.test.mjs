import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSemanticModel } from '../../js/blocks.js';
import { formatObjcMessage } from '../../js/apple/objc-runtime.js';
import { decompile, ensureLegacyLabelForTesting, hasBalancedBracesForTesting } from '../../js/decompile-base.js';
import { decompile as legacyDecompile } from '../../js/decompile-legacy.js';
import { decompileSemantic } from '../../js/decompiler/semantic.js';

function insn(row, addr, mnemonic, operands = '', extra = {}) {
  return {
    row,
    address: addr,
    mnemonic,
    operands,
    bytes: '00000000',
    reads: [],
    writes: [],
    ...extra,
  };
}

function modelOf(rows, { name = 'fixture', base = 0x710000n } = {}) {
  const raw = rows.map((entry, row) => ({
    row,
    address: BigInt(entry.address ?? (base + BigInt(row * 4))),
    mn: entry.mn,
    ops: entry.ops || '',
  }));
  const rowByAddress = new Map(raw.map((entry) => [entry.address.toString(), entry.row]));
  const opts = {
    startRow: 0,
    endRow: raw.length - 1,
    rowOfAddress: (addr) => rowByAddress.get(BigInt(addr).toString()) ?? null,
    addrOfRow: (row) => raw[row]?.address ?? null,
    symbolFor: () => null,
    name,
    addr: raw[0]?.address ?? base,
  };
  return { raw, opts, model: buildSemanticModel(raw, opts) };
}

test('formatObjcMessage falls back to C call on malformed selectors while preserving callee and stripping @"..."', () => {
  const quoteSel = formatObjcMessage({
    receiver: '@"selfStr"',
    selector: '"4K',
    args: ['@"argStr"'],
    style: 'objc',
    callee: 'objc_msgSendSuper2',
  });
  assert.equal(quoteSel, 'objc_msgSendSuper2("selfStr", "\\"4K", "argStr")');

  const digitSel = formatObjcMessage({
    receiver: 'a1',
    selector: '0QD:',
    args: ['a2'],
    style: 'objc',
    callee: 'objc_msgSend',
  });
  assert.equal(digitSel, 'objc_msgSend(a1, "0QD:", a2)');

  const hyphenSel = formatObjcMessage({
    receiver: 'a1',
    selector: 'w-O',
    args: [],
    style: 'objc',
  });
  assert.equal(hyphenSel, 'objc_msgSend(a1, "w-O")');

  const bracketSel = formatObjcMessage({
    receiver: 'a1',
    selector: '[bad]',
    args: [],
    style: 'objc',
    callee: 'objc_msgSendSuper2',
  });
  assert.equal(bracketSel, 'objc_msgSendSuper2(a1, "[bad]")');

  const validSel = formatObjcMessage({
    receiver: 'a1',
    selector: 'initWithJSONData:error:',
    args: ['a2', 'a3'],
    style: 'objc',
  });
  assert.equal(validSel, '[a1 initWithJSONData:a2 error:a3]');
});

test('semantic decompiler preserves objc_msgSendSuper2 on malformed selector even in default objc mode', () => {
  const { model, opts } = modelOf([
    { address: 0x2000n, mn: 'bl', ops: '0x9000' },
    { address: 0x2004n, mn: 'ret', ops: '' },
  ], { name: 'semantic_malformed_super2', base: 0x2000n });

  const sem = decompileSemantic(model, {
    ...opts,
    symbolFor: (addr) => (BigInt(addr) === 0x9000n ? '_objc_msgSendSuper2$"4K' : null),
    selectorRefs: [{ address: 0x9000n, selector: '"4K' }],
  });
  assert.equal(sem.objcSyntax, 'objc');
  assert.match(sem.pseudocode, /objc_msgSendSuper2\(/);
  assert.doesNotMatch(sem.pseudocode, /\[.*\\"4K|\[.*"4K/);
});

test('legacy decompiler clamps argc to 0 on malformed colon-heavy selectors and falls back to C call', () => {
  const model = {
    arch: 'arm64',
    name: 'malformed_objc_legacy',
    startAddr: 0x1000n,
    instructions: [
      insn(0, 0x1000n, 'bl', '0x2000', { isCall: true, callTarget: 0x2000n }),
      insn(1, 0x1004n, 'ret', '', { isReturn: true }),
    ],
    basicBlocks: [{ index: 0, startRow: 0, endRow: 1, rows: [0, 1], succ: [] }],
    calls: [{
      row: 0,
      target: 0x2000n,
      name: '_objc_msgSendSuper2$0:1:2:3:4:5:6:7:8:9:',
      selector: '0:1:2:3:4:5:6:7:8:9:',
    }],
  };
  const out = legacyDecompile(model, {});
  const text = out.lines.map((l) => l.text).join('\n');
  assert.match(text, /objc_msgSendSuper2\(/);
  assert.doesNotMatch(text, /\[.*0:1:/);
  assert.doesNotMatch(text, /\bx8\b|\bx9\b|\bx10\b/);
  assert.equal(out.objcSyntax, 'objc');

  const outC = legacyDecompile(model, { objcSyntax: 'c' });
  assert.equal(outC.objcSyntax, 'c');

  const emptyOut = legacyDecompile({ instructions: [] }, { objcSyntax: 'c' });
  assert.equal(emptyOut.objcSyntax, 'c');
});

test('semantic decompiler sanitizes Swift callee $ without touching string arguments like "$100" and sets objcSyntax', () => {
  const { model, opts } = modelOf([
    { address: 0x3000n, mn: 'adrp', ops: 'x0, #0x10000' },
    { address: 0x3004n, mn: 'add', ops: 'x0, x0, #0x40' },
    { address: 0x3008n, mn: 'bl', ops: '0x4000' },
    { address: 0x300cn, mn: 'ret', ops: '' },
  ], { name: 'swift_dollar_callee', base: 0x3000n });

  const sem = decompileSemantic(model, {
    ...opts,
    objcSyntax: 'c',
    symbolFor: (addr) => (BigInt(addr) === 0x4000n ? '_$s4Test3fooSiyF' : null),
    stringFor: (addr) => (BigInt(addr) === 0x10040n ? '$100' : null),
    callPrototypeFor: () => ({ arity: 1, params: [{ type: 'const char *' }] }),
  });
  assert.equal(sem.objcSyntax, 'c');
  assert.doesNotMatch(sem.pseudocode, /\$s4Test/);
  assert.match(sem.pseudocode, /__s4Test3fooSiyF\("\$100"\)/);

  const def = decompile(model, {
    ...opts,
    symbolFor: (addr) => (BigInt(addr) === 0x4000n ? '_$s4Test3fooSiyF' : null),
    stringFor: (addr) => (BigInt(addr) === 0x10040n ? '$100' : null),
    callPrototypeFor: () => ({ arity: 1, params: [{ type: 'const char *' }] }),
  });
  assert.equal(def.objcSyntax, 'objc');
  assert.doesNotMatch(def.pseudocode, /\$s4Test/);
  assert.match(def.pseudocode, /"\$100"/);
});

test('faithfulCfg appends semicolon only for trailing label before closing brace and not between consecutive labels', () => {
  const { model, opts } = modelOf([
    { address: 0x7000n, mn: 'br', ops: 'x0' },
    { address: 0x7004n, mn: 'nop', ops: '' },
    { address: 0x7008n, mn: 'mov', ops: 'x0, #1' },
    { address: 0x700cn, mn: 'ret', ops: '' },
    { address: 0x7010n, mn: 'nop', ops: '' },
  ], { name: 'faithful_cfg_trailing_label', base: 0x7000n });

  const ir = {
    entry: 0,
    values: [],
    instructions: [
      { id: 1, op: 'NOP', row: 0, address: 0x7000n, args: [] },
      { id: 2, op: 'NOP', row: 1, address: 0x7004n, args: [] },
      { id: 3, op: 'RET', row: 3, address: 0x700cn, args: [] },
      { id: 4, op: 'NOP', row: 4, address: 0x7010n, args: [] },
    ],
    blocks: [
      { index: 0, startRow: 0, endRow: 0, insts: [{ id: 1, op: 'NOP', row: 0, address: 0x7000n, args: [] }], succ: [1, 2, 3], pred: [] },
      { index: 1, startRow: 1, endRow: 1, insts: [{ id: 2, op: 'NOP', row: 1, address: 0x7004n, args: [] }], succ: [2], pred: [0] },
      { index: 2, startRow: 2, endRow: 3, insts: [{ id: 3, op: 'RET', row: 3, address: 0x700cn, args: [] }], succ: [], pred: [0, 1] },
      { index: 3, startRow: 4, endRow: 4, insts: [{ id: 4, op: 'NOP', row: 4, address: 0x7010n, args: [] }], succ: [], pred: [0] },
    ],
  };

  const sem = decompileSemantic(model, { ...opts, ir });
  assert.equal(sem.coverage.mode, 'linear');
  const bodyTexts = sem.lines.map((l) => l.text);
  assert.deepEqual(bodyTexts, [
    'void faithful_cfg_trailing_label(void)',
    '{',
    'loc_7000:',
    'loc_7004:',
    'loc_7008:',
    'loc_7010:',
    ';',
    '}',
  ]);
});

test('ensureLegacyLabel inserts semicolon before closing brace but never when at < 0 appends without closing brace', () => {
  const withClose = [
    { kind: 'sig', indent: 0, text: 'int f(void)', row: 0 },
    { kind: 'ctrl', indent: 0, text: '{', row: 0 },
    { kind: 'stmt', indent: 1, text: 'return 0;', row: 1 },
    { kind: 'ctrl', indent: 0, text: '}', row: 2 },
  ];
  ensureLegacyLabelForTesting(withClose, 99, 'loc_end', 0x5000n);
  assert.deepEqual(
    withClose.map((l) => l.text),
    ['int f(void)', '{', 'return 0;', 'loc_end:', ';', '}'],
  );

  const withoutClose = [
    { kind: 'sig', indent: 0, text: 'int counterexample(void)', row: 0 },
    { kind: 'ctrl', indent: 0, text: '{', row: 0 },
  ];
  ensureLegacyLabelForTesting(withoutClose, 99, 'loc_1234', 0x1234n);
  assert.deepEqual(
    withoutClose.map((l) => l.text),
    ['int counterexample(void)', '{', 'loc_1234:'],
  );
});

test('hasBalancedBraces ignores braces inside strings, char literals, and line/block comments', () => {
  assert.equal(hasBalancedBracesForTesting([
    { text: 'if (x) {' },
    { text: '  const char *s = "}}}}{{{"; // } unbalanced in line comment' },
    { text: "  char c = '{'; /* { unbalanced in block comment */" },
    { text: '  const char *esc = "\\"{";' },
    { text: '}' },
  ]), true);

  assert.equal(hasBalancedBracesForTesting([
    { text: 'if (x) {' },
    { text: '  foo();' },
  ]), false);

  assert.equal(hasBalancedBracesForTesting([
    { text: '}' },
    { text: '{' },
  ]), false);
});

test('graftDetachedExceptionRegions keeps detached EH blocks balanced and terminates comment-only EH blocks safely', () => {
  const { model, opts } = modelOf([
    { address: 0x8000n, mn: 'mov', ops: 'x0, #1' },
    { address: 0x8004n, mn: 'ret', ops: '' },
    // Detached EH landing pad
    { address: 0x8008n, mn: 'bl', ops: '0x9500' },
    { address: 0x800cn, mn: 'ret', ops: '' },
  ], { name: 'detached_eh_fn', base: 0x8000n });

  const out = decompile(model, {
    ...opts,
    symbolFor: (addr) => (BigInt(addr) === 0x9500n ? '__cxa_begin_catch' : null),
  });
  assert.equal(hasBalancedBracesForTesting(out.lines), true);
  assert.equal(out.objcSyntax, 'objc');
  const nonEmpty = out.lines.filter((l) => l.kind !== 'comment' && String(l.text || '').trim());
  for (let i = 0; i < nonEmpty.length - 1; i++) {
    if (nonEmpty[i].kind === 'label') {
      assert.notEqual(nonEmpty[i + 1].text, '}', 'EH trailing label must not sit directly before }');
    }
  }
});

test('legacy decompiler inserts trailing semicolon when a label sits directly before closing brace', () => {
  const model = {
    arch: 'arm64',
    name: 'trailing_label_fn',
    startAddr: 0x6000n,
    instructions: [
      insn(0, 0x6000n, 'cbz', 'x0, #0x6008', { ops: [{ kind: 'reg', text: 'x0', reg: 'x0' }, { kind: 'imm', value: 0x6008n }], reads: ['x0'], isBranch: true, branchTarget: 0x6008n }),
      insn(1, 0x6004n, 'nop', ''),
      insn(2, 0x6008n, 'nop', ''),
    ],
    basicBlocks: [
      { index: 0, startRow: 0, endRow: 0, rows: [0], succ: [1, 2] },
      { index: 1, startRow: 1, endRow: 1, rows: [1], succ: [2] },
      { index: 2, startRow: 2, endRow: 2, rows: [2], succ: [] },
    ],
  };
  const out = legacyDecompile(model, {});
  const nonEmpty = out.lines.filter((l) => l.kind !== 'comment' && String(l.text || '').trim());
  for (let i = 0; i < nonEmpty.length - 1; i++) {
    if (nonEmpty[i].kind === 'label') {
      assert.notEqual(nonEmpty[i + 1].text, '}', 'label must not sit directly before closing brace');
    }
  }
});
