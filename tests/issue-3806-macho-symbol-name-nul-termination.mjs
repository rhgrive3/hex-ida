// Regression for #3806: js/macho.js::parseSymbols() read symbol names with a
// fixed 1024-byte cap instead of the Mach-O string-table format (NUL-terminated
// entry, bounded by the string table). Valid Swift-mangled names longer than
// 1024 bytes were silently cut, and two distinct long symbols sharing a 1024-byte
// prefix collapsed to the same display name. The parser must now read to the
// first NUL inside the string table and fail closed (empty name) for entries
// that are not NUL-terminated instead of laundering a truncated prefix as a
// complete symbol name.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadMachO() {
  const context = vm.createContext({
    console, TextDecoder, TextEncoder, Uint8Array, Uint8ClampedArray, Uint16Array,
    Uint32Array, Int32Array, BigUint64Array, BigInt64Array, DataView, ArrayBuffer,
    BigInt, Map, Set, WeakMap, WeakSet, Promise, Object, Array, Math, Number,
    String, Boolean, RegExp, Error, TypeError, RangeError, JSON, Date,
    setTimeout, clearTimeout,
  });
  context.self = context;
  context.globalThis = context;
  context.self.postMessage = () => {};
  context.importScripts = () => {};
  vm.runInContext(fs.readFileSync(path.join(root, 'js/macho.js'), 'utf8'), context, { filename: 'js/macho.js' });
  return context.MachO;
}

const MachO = loadMachO();

// nlist_64 entry pointing at n_strx 1 in the supplied string table.
function symbolTableFor(strBuf, is64 = true) {
  const entry = is64 ? 16 : 12;
  const sym = new Uint8Array(entry);
  const dv = new DataView(sym.buffer);
  dv.setUint32(0, 1, true);              // n_strx
  sym[4] = 0x0f;                         // N_SECT | N_EXT
  sym[5] = 1;                            // n_sect
  if (is64) dv.setBigUint64(8, 0x1000n, true);
  else dv.setUint32(8, 0x1000, true);
  return sym;
}

function stringTable(names) {
  // Offset 0 is the empty-string sentinel, matching real string tables.
  const parts = [new Uint8Array([0])];
  for (const name of names) parts.push(new TextEncoder().encode(name + '\0'));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

// 1-3. 1023/1024/1025-byte names are all complete symbol names, not truncations.
for (const length of [1023, 1024, 1025]) {
  const name = '_$s' + 'A'.repeat(length - 3);
  assert.equal(name.length, length);
  const sym = symbolTableFor(stringTable([]));
  const str = stringTable([name]);
  const out = MachO.parseSymbols(sym, str, true);
  assert.equal(out.names[0].length, length, `a ${length}-byte name must not be truncated`);
  assert.equal(out.names[0], name, `a ${length}-byte name must be preserved exactly`);
}

// 4. A >4KiB valid Swift-like mangled name is preserved whole.
{
  const name = '_$s' + 'B'.repeat(5000) + 'Si';
  const out = MachO.parseSymbols(symbolTableFor(stringTable([])), stringTable([name]), true);
  assert.equal(out.names[0].length, name.length);
  assert.equal(out.names[0], name);
}

// 5. Two distinct symbols sharing a 1024-byte prefix stay distinguishable.
{
  const prefix = '_$s' + 'C'.repeat(1024);
  const name1 = prefix + 'TYPE_ONE';
  const name2 = prefix + 'TYPE_TWO';
  const str = stringTable([name1, name2]);
  const sym = new Uint8Array(32);
  const dv = new DataView(sym.buffer);
  const off1 = 1;                                   // first entry after sentinel
  const off2 = off1 + name1.length + 1;
  dv.setUint32(0, off1, true);
  dv.setUint32(16, off2, true);
  // N_SECT for both entries so nothing else filters them out.
  sym[4] = 0x0e;
  sym[20] = 0x0e;
  const out = MachO.parseSymbols(sym, str, true);
  assert.equal(out.names[0], name1);
  assert.equal(out.names[1], name2);
  assert.notEqual(out.names[0], out.names[1]);
}

// 6. n_strx outside the string table is rejected, never read out of bounds.
{
  const sym = new Uint8Array(16);
  new DataView(sym.buffer).setUint32(0, 0xffff, true);
  const out = MachO.parseSymbols(sym, stringTable(['_foo']), true);
  assert.equal(out.names[0], '');
}

// 7. A string-table entry with no NUL before the table end is malformed and must
//    not be laundered as a complete (truncated) name.
{
  const sym = symbolTableFor(stringTable([]));
  const str = new Uint8Array(64).fill(0x41); // no NUL anywhere in the table
  str.set(new TextEncoder().encode('_unterminated_name'), 1);
  const out = MachO.parseSymbols(sym, str, true);
  assert.equal(out.names[0], '');
}

// 8. A name that runs to the last byte without a terminator is also malformed.
{
  const sym = symbolTableFor(stringTable([]));
  const raw = new TextEncoder().encode('_tail');
  const str = new Uint8Array(6);
  str.set(raw, 1);
  const out = MachO.parseSymbols(sym, str, true);
  assert.equal(out.names[0], '');
}

// 9. 32-bit nlist uses the same string-table contract.
{
  const name = '_$s' + 'D'.repeat(1200);
  const out = MachO.parseSymbols(symbolTableFor(stringTable([]), false), stringTable([name]), false);
  assert.equal(out.names[0], name);
}

console.log('issue #3806 Mach-O symbol name NUL-termination regression passed');
