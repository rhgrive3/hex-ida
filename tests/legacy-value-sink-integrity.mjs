import assert from 'node:assert/strict';
import { buildSemanticModel } from '../js/blocks.js';
import { decompile } from '../js/decompile.js';
import { buildValues, render as renderExpr } from '../js/expr.js';

const BASE = 0x1000n;
function fixture(lines, extra = {}) {
  const raw = lines.map((text, row) => {
    const p = text.indexOf(' ');
    return { row, address: BASE + BigInt(row * 4), mn: p < 0 ? text : text.slice(0, p), ops: p < 0 ? '' : text.slice(p + 1) };
  });
  const rowOfAddress = (addr) => {
    const d = BigInt(addr) - BASE;
    return d >= 0n && d < BigInt(raw.length * 4) ? Number(d / 4n) : null;
  };
  const addrOfRow = (row) => raw[row]?.address ?? null;
  const symbolFor = extra.symbolFor || (() => null);
  const model = buildSemanticModel(raw, { startRow: 0, endRow: raw.length - 1, rowOfAddress, addrOfRow, symbolFor });
  if (extra.calls) model.calls = extra.calls;
  const result = decompile(model, {
    addr: BASE, rowOfAddress, addrOfRow, symbolFor, fieldFor: extra.fieldFor,
    beginner: false, forceLegacyDecompiler: true, returnType: extra.returnType || 'int64',
  });
  const text = result.lines.map((l) => `${'    '.repeat(Math.max(0, l.indent || 0))}${l.text || ''}`).join('\n');
  return { model, result, text };
}

for (const [name, lines, expected] of [
  ['cbz', ['add x8, x0, #5', 'cbz x8, #0x1010', 'mov x0, #1', 'ret', 'mov x0, #2', 'ret'], /if \(a1 \+ 5 == 0\)/],
  ['tbz', ['add x8, x0, #5', 'tbz x8, #2, #0x1010', 'mov x0, #1', 'ret', 'mov x0, #2', 'ret'], /a1 \+ 5[^\n]*1 << 2/],
  ['cmp', ['add x8, x0, #5', 'cmp x8, #9', 'b.eq #0x1014', 'mov x0, #1', 'ret', 'mov x0, #2', 'ret'], /if \(a1 \+ 5 == 9\)/],
]) {
  const { text } = fixture(lines);
  assert.match(text, expected, `${name}: ${text}`);
  assert.doesNotMatch(text, /if \([^\n]*\bx8\b/, `${name}: ${text}`);
}

{
  const { text } = fixture(['add x8, x0, #16', 'mov x9, #7', 'str x9, [x8]', 'mov x0, #0', 'ret']);
  assert.match(text, /\*\(uint64 \*\)\(a1 \+ 16\) = 7;/, text);
  assert.doesNotMatch(text, /\*\(uint64 \*\)\(x8\)/, text);
}

{
  const { model, text } = fixture(['add x8, x0, #16', 'ldp x9, x10, [x8]', 'add x0, x9, x10', 'ret']);
  assert.match(text, /a1 \+ 16/, text);
  assert.match(text, /a1 \+ 24/, text);
  assert.doesNotMatch(text, /\*\(uint64 \*\)\(a1 \+ 16\) \* 2/, text);
  const vg = buildValues(model);
  assert.equal(renderExpr(vg.defAt(1, 'x9')), '*(uint64 *)(a1 + 16)');
  assert.equal(renderExpr(vg.defAt(1, 'x10')), '*(uint64 *)(a1 + 24)');
}

{
  const { text } = fixture(['add x8, x0, #16', 'mov x9, #7', 'mov x10, #8', 'stp x9, x10, [x8]', 'mov x0, #0', 'ret']);
  assert.match(text, /a1 \+ 16/, text);
  assert.match(text, /a1 \+ 16 \+ 8/, text);
  assert.doesNotMatch(text, /\(x8(?: \+ 8)?\)/, text);
}

{
  const { text } = fixture(['add x8, x0, #16', 'blr x8', 'ret']);
  assert.match(text, /\(\*\(a1 \+ 16\)\)\(/, text);
  assert.doesNotMatch(text, /\(\*x8\)/, text);
}

{
  const { model, text } = fixture(['add x8, x0, #16', 'mov x9, #7', 'stxr w10, x9, [x8]', 'mov x0, x10', 'ret']);
  assert.match(text, /__atomic_store\(\(uint64 \*\)\(a1 \+ 16\), 7\)/, text);
  assert.doesNotMatch(text, /__atomic_store\([^\n]*\bx9\b/, text);
  const writes = buildValues(model).memWrites;
  assert.equal(writes.length, 1);
  assert.equal(renderExpr(writes[0].value), '7');
}

{
  const MSG = 0x2000n;
  const symbolFor = (addr) => BigInt(addr) === MSG ? '_objc_msgSend' : null;
  const { text } = fixture([
    'add x0, x2, #16', 'mov x2, #7', `bl #0x${MSG.toString(16)}`, 'ret',
  ], { symbolFor, calls: [{ row: 2, name: '_objc_msgSend', selector: 'setValue:', target: MSG }] });
  assert.match(text, /\[\(a3 \+ 16\) setValue:7\]/, text);
  assert.doesNotMatch(text, /\[x0 setValue:x2\]/, text);
}

{
  const { text } = fixture(['add x8, x1, #5', 'rev x0, x8', 'ret']);
  assert.match(text, /x8 = a2 \+ 5;/, text);
  assert.match(text, /__builtin_bswap64\(x8\)/, text);
}

{
  const fieldFor = (_reg, off) => off === 16 ? { name: 'a', type: 'uint64' } : off === 24 ? { name: 'b', type: 'uint64' } : null;
  const { text: loadText } = fixture(['ldp x9, x10, [x0, #16]', 'add x0, x9, x10', 'ret'], { fieldFor });
  assert.match(loadText, /x9 = a1->a;\s+x10 = a1->b;/, loadText);
  assert.doesNotMatch(loadText, /x9 = a1->a;\s+x10 = a1->a;/, loadText);
  const { text: storeText } = fixture(['mov x9, #1', 'mov x10, #2', 'stp x9, x10, [x0, #16]', 'mov x0, #0', 'ret'], { fieldFor });
  assert.match(storeText, /a1->a = 1;\s+a1->b = 2;/, storeText);
  assert.doesNotMatch(storeText, /a1->a = 1;\s+a1->a = 2;/, storeText);
}

{
  const { model } = fixture(['add x8, x0, #16', 'ldp x8, x9, [x8]', 'add x0, x8, x9', 'ret']);
  const vg = buildValues(model);
  assert.equal(renderExpr(vg.defAt(1, 'x8')), '*(uint64 *)(a1 + 16)');
  assert.equal(renderExpr(vg.defAt(1, 'x9')), '*(uint64 *)(a1 + 24)');
}

{
  const { text } = fixture([
    'ldxr x8, [x0]', 'add x9, x8, #1', 'str x8, [x1]', 'str x9, [x2]',
    'ldxr x8, [x0]', 'add x9, x8, #2', 'str x8, [x1]', 'str x9, [x2]',
    'mov x0, #0', 'ret',
  ]);
  assert.match(text, /x8_1 = __atomic_load/, text);
  assert.match(text, /x8_2 = __atomic_load/, text);
  assert.doesNotMatch(text, /^\s*x8 = __atomic_load/gm, text);
}

{
  const MSG = 0x2000n;
  const symbolFor = (addr) => BigInt(addr) === MSG ? '_objc_msgSend' : null;
  const { text } = fixture([
    `bl #0x${MSG.toString(16)}`, 'mov x19, x0',
    `bl #0x${MSG.toString(16)}`, 'add x0, x19, x0', 'ret',
  ], {
    symbolFor,
    calls: [
      { row: 0, name: '_objc_msgSend', selector: 'first', target: MSG },
      { row: 2, name: '_objc_msgSend', selector: 'second', target: MSG },
    ],
  });
  assert.match(text, /x0_1 = \[a1 first\];/, text);
  assert.match(text, /x0_2 = \[x0_1 second\];/, text);
  assert.match(text, /return x0_1 \+ x0_2;/, text);
  assert.doesNotMatch(text, /^\s*x0 = \[/gm, text);
}

console.log('legacy value-sink integrity: ok');
