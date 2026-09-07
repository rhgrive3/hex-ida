import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../js/macho.js', import.meta.url), 'utf8');
const context = vm.createContext({});
vm.runInContext(source, context, { filename: 'js/macho.js' });
const { stubSymbols } = context.MachO;

function indirect(...indexes) {
  const bytes = new Uint8Array(indexes.length * 4);
  const dv = new DataView(bytes.buffer);
  indexes.forEach((value, index) => dv.setUint32(index * 4, value, true));
  return bytes;
}

const sym = { names: [] };
sym.names[10] = '_foo';
sym.names[11] = '_bar';
sym.names[12] = '_baz';

function info(pointerBits, section, extra = {}) {
  return { pointerBits, segments: [{ sections: [section] }], ...extra };
}

function normalize(entries) {
  return Array.from(entries, (entry) => ({
    addr: entry.addr.toString(16),
    name: entry.name,
    stub: entry.stub,
  }));
}

const ptr32 = stubSymbols(
  info(32, { pointers: true, stubs: false, reserved1: 1, addr: 0x2000n, size: 8n }),
  indirect(99, 10, 11),
  sym,
);
assert.deepEqual(normalize(ptr32), [
  { addr: '2000', name: '_foo', stub: false },
  { addr: '2004', name: '_bar', stub: false },
]);

const ptr64 = stubSymbols(
  info(64, { pointers: true, stubs: false, reserved1: 0, addr: 0x3000n, size: 16n }),
  indirect(10, 11),
  sym,
);
assert.deepEqual(normalize(ptr64), [
  { addr: '3000', name: '_foo', stub: false },
  { addr: '3008', name: '_bar', stub: false },
]);

const arm64_32 = stubSymbols(
  info(32, { pointers: true, stubs: false, reserved1: 0, addr: 0x4000n, size: 8n }, { is64: true, architecture: 'arm64_32' }),
  indirect(10, 11),
  sym,
);
assert.deepEqual(normalize(arm64_32), [
  { addr: '4000', name: '_foo', stub: false },
  { addr: '4004', name: '_bar', stub: false },
]);

const stubs = stubSymbols(
  info(32, { pointers: false, stubs: true, reserved1: 0, reserved2: 12, addr: 0x5000n, size: 24n }),
  indirect(10, 11),
  sym,
);
assert.deepEqual(normalize(stubs), [
  { addr: '5000', name: '_foo', stub: true },
  { addr: '500c', name: '_bar', stub: true },
]);

const outOfRangeSymbol = stubSymbols(
  info(32, { pointers: true, stubs: false, reserved1: 0, addr: 0x6000n, size: 8n }),
  indirect(10, 0x3fffffff),
  sym,
);
assert.deepEqual(normalize(outOfRangeSymbol), [
  { addr: '6000', name: '_foo', stub: false },
]);

console.log('issue-3615-macho-pointer-symbol-width: PASS');
