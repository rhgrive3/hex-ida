import assert from 'node:assert/strict';
import test from 'node:test';
import { semanticAbiAdapter } from '../../js/analysis/semantic-function.js';
import { AAPCS64_ABI } from '../../js/targets/abi/index.js';
import { enhanceSemanticDecompilation, buildExpressionForTesting } from '../../js/decompiler/pipeline-core.js';
import { printExpression } from '../../js/decompiler/pretty/c.js';

const ABI = semanticAbiAdapter(AAPCS64_ABI);

function val(id, reg, bits = 64, kind = 'def', extra = {}) {
  return { id, reg, bits, kind, uses: [], def: null, const: null, ...extra };
}
function arg(id, reg, bits = 64) {
  return val(id, reg, bits, 'arg');
}
function av(v) {
  return { value: v };
}

function makeState(ir, { model = { calls: [], addressRefs: [] }, opts = {}, types = null } = {}) {
  return {
    ir,
    model,
    opts: { abiAdapter: ABI, ...opts },
    types: types || { values: new Map(), locations: new Map() },
    preservePhase8Unknown: opts.phase8Optimize === true,
    expressionMemo: new Map(),
    expressionActive: new Set(),
    warnings: [],
  };
}

function makeSingleBlockEnhance({
  args,
  values,
  insts,
  lines,
  types = null,
  model = { calls: [], addressRefs: [] },
  opts = {},
}) {
  const ir = {
    values: [...args, ...values],
    instructions: insts,
    args: new Map(args.map((a) => [a.reg, a])),
    blocks: [{ index: 0, startRow: 0, endRow: Math.max(0, insts.length - 1), succ: [], insts }],
  };
  const result = {
    semantic: true,
    ir,
    types: types || { values: new Map(), locations: new Map() },
    lines,
    warnings: [],
    evidence: [],
    summary: 'test',
    coverage: { mode: 'structured' },
  };
  return enhanceSemanticDecompilation(result, model, {
    abiAdapter: ABI,
    decompilerTimeBudgetMs: 5000,
    ...opts,
  });
}

test('Fix 1: sub-64-bit untyped field loads emit typed uint8_t/int8_t/uint16_t/uint32_t dereferences instead of ->field_0', () => {
  const ptr = arg(1, 'x0', 64);
  const b0 = val(2, 'w0', 8);
  const loc0 = { kind: 'field', key: 'field:1:0', base: ptr, disp: 0n, size: 1 };
  const loadB0 = { id: 10, op: 'load', sub: 'ldrb', row: 0, block: 0, address: 0x1000n, size: 1, dst: b0, loc: loc0, addr: { base: ptr, disp: 0n, size: 1 }, args: [] };
  b0.def = loadB0;
  const retI = { id: 11, op: 'ret', row: 1, block: 0, address: 0x1004n, args: [av(b0)] };
  ptr.uses.push(loadB0);
  b0.uses.push(retI);

  const enhanced = makeSingleBlockEnhance({
    args: [ptr],
    values: [b0],
    insts: [loadB0, retI],
    lines: [
      { kind: 'sig', indent: 0, text: 'uint64 read_char(uint64 a1)' },
      { kind: 'ctrl', indent: 0, text: '{' },
      { kind: 'stmt', indent: 1, text: 'return a1->field_0;', row: 1, addr: 0x1004n },
      { kind: 'ctrl', indent: 0, text: '}' },
    ],
  });

  assert.match(enhanced.pseudocode, /\*\(uint8_t \*\)\(uintptr_t\)\(a1\)/, enhanced.pseudocode);
  assert.doesNotMatch(enhanced.pseudocode, /a1->field_0/, enhanced.pseudocode);

  // Also verify offset != 0, signed byte, 16-bit, 32-bit, float, and double.
  const b1 = val(3, 'w1', 8, 'def', { signed: true });
  const loadSb1 = { id: 12, op: 'load', sub: 'ldrsb', signed: true, row: 2, block: 0, address: 0x1008n, size: 1, dst: b1, loc: { kind: 'field', key: 'field:1:1', base: ptr, disp: 1n, size: 1 }, addr: { base: ptr, disp: 1n, size: 1 }, args: [] };
  b1.def = loadSb1;

  const h2 = val(4, 'w2', 16);
  const loadH2 = { id: 13, op: 'load', sub: 'ldrh', row: 3, block: 0, address: 0x100cn, size: 2, dst: h2, loc: { kind: 'field', key: 'field:1:2', base: ptr, disp: 2n, size: 2 }, addr: { base: ptr, disp: 2n, size: 2 }, args: [] };
  h2.def = loadH2;

  const w4 = val(5, 'w3', 32);
  const loadW4 = { id: 14, op: 'load', sub: 'ldr', row: 4, block: 0, address: 0x1010n, size: 4, dst: w4, loc: { kind: 'field', key: 'field:1:4', base: ptr, disp: 4n, size: 4 }, addr: { base: ptr, disp: 4n, size: 4 }, args: [] };
  w4.def = loadW4;

  const d8 = val(6, 'd0', 64);
  const loadD8 = { id: 15, op: 'load', sub: 'fldr', float: true, row: 5, block: 0, address: 0x1014n, size: 8, dst: d8, loc: { kind: 'field', key: 'field:1:8', base: ptr, disp: 8n, size: 8 }, addr: { base: ptr, disp: 8n, size: 8 }, args: [] };
  d8.def = loadD8;

  const state = makeState({ values: [ptr, b1, h2, w4, d8], instructions: [loadSb1, loadH2, loadW4, loadD8], args: new Map([['x0', ptr]]), blocks: [] });
  assert.equal(printExpression(buildExpressionForTesting(b1, state)), '*(int8_t *)((uintptr_t)(a1) + 1)');
  assert.equal(printExpression(buildExpressionForTesting(h2, state)), '*(uint16_t *)((uintptr_t)(a1) + 2)');
  assert.equal(printExpression(buildExpressionForTesting(w4, state)), '*(uint32_t *)((uintptr_t)(a1) + 4)');
  assert.equal(printExpression(buildExpressionForTesting(d8, state)), '*(double *)((uintptr_t)(a1) + 8)');
});

test('Fix 1: 4-byte untyped field store emits *(uint32_t *) instead of a1->field_0 and avoids invalid deref++ syntax', () => {
  const ptr = arg(1, 'x0', 64);
  const loaded = val(2, 'w8', 32);
  const one = val(3, 'w9', 32, 'def', { const: 1n });
  const inc = val(4, 'w8', 32);
  const loc = { kind: 'field', key: 'field:1:0', base: ptr, disp: 0n, size: 4 };

  const loadI = { id: 20, op: 'load', row: 0, block: 0, address: 0x2000n, size: 4, dst: loaded, loc, addr: { base: ptr, disp: 0n, size: 4 }, args: [] };
  loaded.def = loadI;
  const constI = { id: 21, op: 'const', row: 1, block: 0, address: 0x2004n, dst: one, args: [], extra: { value: 1n } };
  one.def = constI;
  const addI = { id: 22, op: 'bin', sub: 'add', row: 2, block: 0, address: 0x2008n, dst: inc, args: [av(loaded), av(one)] };
  inc.def = addI;
  const storeI = { id: 23, op: 'store', row: 3, block: 0, address: 0x200cn, size: 4, dst: null, loc, addr: { base: ptr, disp: 0n, size: 4 }, args: [av(inc)] };
  const retI = { id: 24, op: 'ret', row: 4, block: 0, address: 0x2010n, args: [] };

  for (const [v, u] of [[ptr, loadI], [ptr, storeI], [loaded, addI], [one, addI], [inc, storeI]]) v.uses.push(u);

  const enhanced = makeSingleBlockEnhance({
    args: [ptr],
    values: [loaded, one, inc],
    insts: [loadI, constI, addI, storeI, retI],
    lines: [
      { kind: 'sig', indent: 0, text: 'void inc_int(uint64 a1)' },
      { kind: 'ctrl', indent: 0, text: '{' },
      { kind: 'stmt', indent: 1, text: 'a1->field_0 = a1->field_0 + 1;', row: 3, addr: 0x200cn },
      { kind: 'ctrl', indent: 0, text: '}' },
    ],
  });

  assert.match(enhanced.pseudocode, /\*\(uint32_t \*\)\(uintptr_t\)\(a1\)\s*\+=\s*1;/, enhanced.pseudocode);
  assert.doesNotMatch(enhanced.pseudocode, /a1->field_0/, enhanced.pseudocode);
  assert.doesNotMatch(enhanced.pseudocode, /\*\(uint32_t \*\)\(uintptr_t\)\(a1\)\+\+/, enhanced.pseudocode);
});

test('Fix 1: preserves ->field_N for 8-byte integer accesses, known struct pointers, fieldFor metadata, and phase8Optimize mode', () => {
  const ptr = arg(1, 'x0', 64);

  // 8-byte integer load stays a1->field_0
  const q8 = val(2, 'x0', 64);
  const loadQ8 = { id: 30, op: 'load', row: 0, block: 0, address: 0x3000n, size: 8, dst: q8, loc: { kind: 'field', key: 'field:1:0', base: ptr, disp: 0n, size: 8 }, addr: { base: ptr, disp: 0n, size: 8 }, args: [] };
  q8.def = loadQ8;
  const state8 = makeState({ values: [ptr, q8], instructions: [loadQ8], args: new Map([['x0', ptr]]), blocks: [] });
  assert.equal(printExpression(buildExpressionForTesting(q8, state8)), 'a1->field_0');

  // 4-byte load on known struct pointer (Player *) stays a1->field_20
  const w4 = val(3, 'w0', 32);
  const loadW4 = { id: 31, op: 'load', row: 1, block: 0, address: 0x3004n, size: 4, dst: w4, loc: { kind: 'field', key: 'field:1:32', base: ptr, disp: 32n, size: 4 }, addr: { base: ptr, disp: 32n, size: 4 }, args: [] };
  w4.def = loadW4;
  const structState = makeState(
    { values: [ptr, w4], instructions: [loadW4], args: new Map([['x0', ptr]]), blocks: [] },
    { types: { values: new Map([[ptr.id, { name: 'Player *', kind: 'pointer' }]]), locations: new Map() } },
  );
  assert.equal(printExpression(buildExpressionForTesting(w4, structState)), 'a1->field_20');

  // 4-byte load with fieldFor metadata stays a1->hp
  const fieldForState = makeState(
    { values: [ptr, w4], instructions: [loadW4], args: new Map([['x0', ptr]]), blocks: [] },
    { opts: { fieldFor: (_reg, off) => (off === 32n ? { name: 'hp' } : null) } },
  );
  assert.equal(printExpression(buildExpressionForTesting(w4, fieldForState)), 'a1->hp');

  // 4-byte load in phase8Optimize mode stays a1->field_20
  const p8State = makeState(
    { values: [ptr, w4], instructions: [loadW4], args: new Map([['x0', ptr]]), blocks: [] },
    { opts: { phase8Optimize: true } },
  );
  assert.equal(printExpression(buildExpressionForTesting(w4, p8State)), 'a1->field_20');
});

test('Fix 2: folded adrp+add constants resolve short and long .rodata strings via stringFor, addressRefs, and read-only section bytes', () => {
  const cases = [
    { addr: 0x838n, text: '-1', expected: '"-1"' },
    { addr: 0x7F8n, text: 'NO', expected: '"NO"' },
    { addr: 0x9D8n, text: 'YES', expected: '"YES"' },
    { addr: 0xAD0n, text: 'aeiouAEIOU', expected: '"aeiouAEIOU"' },
  ];

  // (a) via opts.stringFor
  for (const c of cases) {
    const page = val(1, 'x0', 64, 'def', { const: 0n });
    const off = val(2, 'imm', 64, 'def', { const: c.addr });
    const folded = val(3, 'x0', 64, 'def', { const: c.addr });
    const adrpI = { id: 40, op: 'addr', row: 0, block: 0, address: 0x4000n, dst: page, args: [], extra: { value: 0n } };
    page.def = adrpI;
    const addI = { id: 41, op: 'bin', sub: 'add', row: 1, block: 0, address: 0x4004n, dst: folded, args: [av(page), av(off)] };
    folded.def = addI;

    const state = makeState(
      { values: [page, off, folded], instructions: [adrpI, addI], args: new Map(), blocks: [] },
      { opts: { stringFor: (a) => (BigInt(a) === c.addr ? c.text : null) } },
    );
    assert.equal(printExpression(buildExpressionForTesting(folded, state)), c.expected);
  }

  // (b) via model.addressRefs (even when row differs on address-derived adrp+add)
  {
    const page = val(1, 'x0', 64, 'def', { const: 0n });
    const off = val(2, 'imm', 64, 'def', { const: 0x7F8n });
    const folded = val(3, 'x0', 64, 'def', { const: 0x7F8n });
    const adrpI = { id: 42, op: 'addr', row: 0, block: 0, address: 0x4000n, dst: page, args: [], extra: { value: 0n } };
    page.def = adrpI;
    const addI = { id: 43, op: 'bin', sub: 'add', row: 1, block: 0, address: 0x4004n, dst: folded, args: [av(page), av(off)] };
    folded.def = addI;

    const state = makeState(
      { values: [page, off, folded], instructions: [adrpI, addI], args: new Map(), blocks: [] },
      { model: { calls: [], addressRefs: [{ row: 0, addr: 0x7F8n, text: 'No' }] } },
    );
    assert.equal(printExpression(buildExpressionForTesting(folded, state)), '"No"');
  }

  // (c) via .rodata section bytes for short 1-3 byte strings not present in stringFor/addressRefs
  {
    const rodataBytes = Uint8Array.from([
      0x2d, 0x31, 0x00, // "-1\0" at 0x838
      0x59, 0x65, 0x73, 0x00, // "Yes\0" at 0x83b
      0x00, // "" at 0x83f
    ]);
    const rodataSec = { name: '.rodata', addr: 0x838n, size: BigInt(rodataBytes.length), bytes: rodataBytes, perm: 'r--' };

    for (const [target, expected] of [[0x838n, '"-1"'], [0x83bn, '"Yes"'], [0x83fn, '""']]) {
      const page = val(1, 'x0', 64, 'def', { const: 0n });
      const off = val(2, 'imm', 64, 'def', { const: target });
      const folded = val(3, 'x0', 64, 'def', { const: target });
      const adrpI = { id: 44, op: 'addr', row: 0, block: 0, address: 0x4000n, dst: page, args: [], extra: { value: 0n } };
      page.def = adrpI;
      const addI = { id: 45, op: 'bin', sub: 'add', row: 1, block: 0, address: 0x4004n, dst: folded, args: [av(page), av(off)] };
      folded.def = addI;

      const state = makeState(
        { values: [page, off, folded], instructions: [adrpI, addI], args: new Map(), blocks: [] },
        { opts: { sections: [rodataSec] } },
      );
      assert.equal(printExpression(buildExpressionForTesting(folded, state)), expected);
    }
  }
});

test('Fix 2: direct addr ops resolve .rodata strings, non-address integers stay numeric, and .bss adrp+add emits &global_<HEX>', () => {
  // Direct d.op === 'addr' to a string
  {
    const s = val(1, 'x0', 64, 'def', { const: 0x9D8n });
    const addrI = { id: 50, op: 'addr', row: 0, block: 0, address: 0x5000n, dst: s, args: [], extra: { value: 0x9D8n } };
    s.def = addrI;
    const state = makeState(
      { values: [s], instructions: [addrI], args: new Map(), blocks: [] },
      { opts: { stringFor: (a) => (BigInt(a) === 0x9D8n ? 'YES' : null) } },
    );
    assert.equal(printExpression(buildExpressionForTesting(s, state)), '"YES"');
  }

  // Plain numeric constant (not address-derived, no exact row+addr addressRef) stays integer
  {
    const num = val(1, 'x0', 64, 'def', { const: 0x838n });
    const constI = { id: 51, op: 'const', row: 0, block: 0, address: 0x5004n, dst: num, args: [], extra: { value: 0x838n } };
    num.def = constI;
    const state = makeState(
      { values: [num], instructions: [constI], args: new Map(), blocks: [] },
      { opts: { stringFor: () => 'SHOULD_NOT_MATCH_PLAIN_INT' } },
    );
    assert.equal(printExpression(buildExpressionForTesting(num, state)), '0x838');
  }

  // .bss zero-filled section via adrp+add must NOT turn into "" — must emit &global_11030
  {
    const bssSec = { name: '.bss', addr: 0x11000n, size: 0x100n, bytes: new Uint8Array(0x100), perm: 'rw-' };
    const page = val(1, 'x0', 64, 'def', { const: 0x11000n });
    const off = val(2, 'imm', 64, 'def', { const: 0x30n });
    const folded = val(3, 'x0', 64, 'def', { const: 0x11030n });
    const adrpI = { id: 52, op: 'addr', row: 0, block: 0, address: 0x5008n, dst: page, args: [], extra: { value: 0x11000n } };
    page.def = adrpI;
    const addI = { id: 53, op: 'bin', sub: 'add', row: 1, block: 0, address: 0x500cn, dst: folded, args: [av(page), av(off)] };
    folded.def = addI;

    const state = makeState(
      { values: [page, off, folded], instructions: [adrpI, addI], args: new Map(), blocks: [] },
      { opts: { sections: [bssSec] } },
    );
    assert.equal(printExpression(buildExpressionForTesting(folded, state)), '&global_11030');
  }

  // Direct d.op === 'addr' to non-string global emits &global_HEX (normal) and global_HEX (phase8Optimize)
  {
    const g = val(1, 'x0', 64, 'def', { const: 0x11030n });
    const addrI = { id: 54, op: 'addr', row: 0, block: 0, address: 0x5010n, dst: g, args: [], extra: { value: 0x11030n } };
    g.def = addrI;

    const normalState = makeState({ values: [g], instructions: [addrI], args: new Map(), blocks: [] });
    assert.equal(printExpression(buildExpressionForTesting(g, normalState)), '&global_11030');

    const p8State = makeState({ values: [g], instructions: [addrI], args: new Map(), blocks: [] }, { opts: { phase8Optimize: true } });
    assert.equal(printExpression(buildExpressionForTesting(g, p8State)), 'global_11030');
  }
});
