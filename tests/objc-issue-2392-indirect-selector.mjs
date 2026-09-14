import assert from 'node:assert/strict';
import { parseObjcExtendedMetadata, buildObjcRuntimeIndex } from '../js/objc.js';

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

function invalidRelativeMethodList(listAddr, selectorSlot, typeString, imp) {
  p32(listAddr, 0x80000000 | 12); // relative, indirect selector, stride 12
  p32(listAddr + 4, 1);
  const entry = listAddr + 8;
  pi32(entry + 0, selectorSlot - entry);
  pi32(entry + 4, typeString - (entry + 4));
  pi32(entry + 8, imp - (entry + 8));
  str(selectorSlot, 'fake:');
  str(typeString, 'v16@0:8');
}

// Category path: the indirect selector-reference slot itself spells "fake:",
// but its bytes do not resolve to a valid selector pointer.
p64(0x200, 0x1200);
p64(0x1200 + 0, 0x1800); // category name
p64(0x1200 + 8, 0);      // target class unresolved is fine for this parser test
p64(0x1200 + 16, 0x1300);
p64(0x1200 + 24, 0);
p64(0x1200 + 32, 0);
p64(0x1200 + 40, 0);
p64(0x1200 + 48, 0);
str(0x1800, 'Evil');
invalidRelativeMethodList(0x1300, 0x1400, 0x1500, 0x2000);

// Protocol path uses the same relative-method representation contract. A
// malformed required method must not become a protocol requirement either.
p64(0x208, 0x2200);
p64(0x2200 + 8, 0x2300); // protocol name
p64(0x2200 + 16, 0);     // inherited protocols
p64(0x2200 + 24, 0x2400);
p64(0x2200 + 32, 0);
p64(0x2200 + 40, 0);
p64(0x2200 + 48, 0);
str(0x2300, 'EvilProtocol');
invalidRelativeMethodList(0x2400, 0x2500, 0x2600, 0x2700);

const parsed = await parseObjcExtendedMetadata(read, {
  categoryList: { vmAddr: 0x200n, size: 8n },
  protocolList: { vmAddr: 0x208n, size: 8n },
});

assert.equal(parsed.categories.length, 1);
assert.equal(parsed.categories[0].methods.length, 0, 'indirect selector storage must never be reinterpreted as a direct C string');
assert.equal(parsed.categories[0].methods.some((method) => method.sel === 'fake:'), false, 'fabricated selector must not enter category methods');
assert.equal(parsed.categories[0].completeness.methods.instanceMethods.invalidEntries, 1);
assert.equal(parsed.categories[0].completeness.complete, false);

assert.equal(parsed.protocols.length, 1);
assert.equal(parsed.protocols[0].instanceMethods.length, 0, 'malformed indirect selector must not become a protocol requirement');
assert.equal(parsed.protocols[0].completeness.methods.instanceMethods.invalidEntries, 1);
assert.equal(parsed.protocols[0].completeness.complete, false);
assert.equal(parsed.completeness.complete, false);

const index = buildObjcRuntimeIndex({
  classes: [],
  categories: parsed.categories,
  protocols: parsed.protocols,
});
assert.equal(index.methodsBySelector.has('-:fake:'), false, 'fabricated category selector must not enter runtime dispatch index');
assert.equal(index.protocolRequirementsBySelector.has('-:fake:'), false, 'fabricated protocol selector must not enter requirement index');
assert.equal(index.methodCount, 0);
assert.equal(index.protocolRequirementCount, 0);

console.log('objc-issue-2392-indirect-selector: ok');
