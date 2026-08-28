import assert from 'node:assert/strict';
import { parseObjcExtendedMetadata } from '../js/objc.js';

const mem = new Uint8Array(0x4000);
const dv = new DataView(mem.buffer);
const p64 = (at, v) => dv.setBigUint64(at, BigInt(v), true);
const p32 = (at, v) => dv.setUint32(at, Number(v) >>> 0, true);
const pi32 = (at, v) => dv.setInt32(at, Number(v), true);
const str = (at, s) => { mem.set(new TextEncoder().encode(s), at); mem[at + s.length] = 0; };
const read = async (addr, len) => {
  const at = Number(addr);
  if (!Number.isSafeInteger(at) || at < 0 || at >= mem.length) return null;
  return mem.subarray(at, Math.min(mem.length, at + len));
};

// One category with a small/relative method list whose selector uses the
// indirect representation. The selector-reference slot itself contains bytes
// spelling "fake:", but those bytes do not resolve to a valid selector pointer.
p64(0x200, 0x1200);
p64(0x1200 + 0, 0x1800); // category name
p64(0x1200 + 8, 0);      // target class unresolved is fine for this parser test
p64(0x1200 + 16, 0x1300);
p64(0x1200 + 24, 0);
p64(0x1200 + 32, 0);
p64(0x1200 + 40, 0);
p64(0x1200 + 48, 0);
str(0x1800, 'Evil');

p32(0x1300, 0x80000000 | 12); // relative, indirect selector, stride 12
p32(0x1304, 1);
const entry = 0x1308;
const selectorSlot = 0x1400;
const typeString = 0x1500;
const imp = 0x2000;
pi32(entry + 0, selectorSlot - entry);
pi32(entry + 4, typeString - (entry + 4));
pi32(entry + 8, imp - (entry + 8));
str(selectorSlot, 'fake:');
str(typeString, 'v16@0:8');

const parsed = await parseObjcExtendedMetadata(read, {
  categoryList: { vmAddr: 0x200n, size: 8n },
});

assert.equal(parsed.categories.length, 1);
assert.equal(parsed.categories[0].methods.length, 0, 'indirect selector storage must never be reinterpreted as a direct C string');
assert.equal(parsed.categories[0].completeness.methods.instanceMethods.invalidEntries, 1);
assert.equal(parsed.categories[0].completeness.complete, false);
assert.equal(parsed.completeness.complete, false);

console.log('objc-issue-2392-indirect-selector: ok');
