import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../js/macho.js', import.meta.url), 'utf8');
const context = vm.createContext({});
vm.runInContext(source, context, { filename:'js/macho.js' });
const { parseSymbols } = context.MachO;

function symbolTable(offsets) {
  const bytes = new Uint8Array(offsets.length * 16);
  const dv = new DataView(bytes.buffer);
  for (let i = 0; i < offsets.length; i++) {
    const o = i * 16;
    dv.setUint32(o, offsets[i], true);
    dv.setUint8(o + 4, 0x0f);
    dv.setUint8(o + 5, 1);
    dv.setBigUint64(o + 8, 0x1000n + BigInt(i * 4), true);
  }
  return bytes;
}

function oneName(name) {
  const str = new TextEncoder().encode(`\0${name}\0`);
  return parseSymbols(symbolTable([1]), str, true).names[0];
}

function nameOfLength(length) {
  assert.ok(length >= 3);
  return '_$s' + 'A'.repeat(length - 3);
}

for (const length of [1023, 1024, 1025, 4097]) {
  const name = nameOfLength(length);
  assert.equal(oneName(name), name, `${length}-byte symbol name must be preserved exactly`);
}

const common = '_$s' + 'Q'.repeat(1100);
const first = common + 'TYPE_ONE';
const second = common + 'TYPE_TWO';
const encodedFirst = new TextEncoder().encode(first);
const encodedSecond = new TextEncoder().encode(second);
const strings = new Uint8Array(1 + encodedFirst.length + 1 + encodedSecond.length + 1);
let p = 1;
strings.set(encodedFirst, p);
const firstOffset = p;
p += encodedFirst.length + 1;
strings.set(encodedSecond, p);
const secondOffset = p;
const distinct = parseSymbols(symbolTable([firstOffset, secondOffset]), strings, true).names;
assert.equal(distinct[0], first);
assert.equal(distinct[1], second);
assert.notEqual(distinct[0], distinct[1], 'symbols that differ after byte 1024 must stay distinct');

const outOfRangeStrings = new TextEncoder().encode('\0ok\0');
assert.equal(
  parseSymbols(symbolTable([outOfRangeStrings.length]), outOfRangeStrings, true).names[0],
  '',
  'n_strx at/after the string-table end must remain invalid',
);

const unterminated = new TextEncoder().encode('\0' + 'B'.repeat(1200));
assert.equal(
  parseSymbols(symbolTable([1]), unterminated, true).names[0],
  '',
  'unterminated string-table entry must fail closed instead of becoming a partial symbol name',
);

console.log('issue #3806 Mach-O symbol names preserve string-table truth: PASS');
