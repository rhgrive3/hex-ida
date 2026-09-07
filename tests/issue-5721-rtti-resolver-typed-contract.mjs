// Issue #5721 regression: vtable pointer resolution must type-check resolver
// output and pointerFormat before use. BigInt()/Number() coercion used to
// launder numeric strings, arrays, booleans and unsafe numbers into canonical
// slot addresses / chained-pointer formats.
import assert from 'node:assert/strict';
import { readVtable } from '../js/rtti.js';

function vtableFixture() {
  const bytes = new Uint8Array(8 * 5);
  const dv = new DataView(bytes.buffer);
  dv.setBigUint64(0, 0n, true);        // offsetToTop
  dv.setBigUint64(8, 0xdeadn, true);   // typeinfo raw (goes through the resolver)
  for (let i = 2; i < 5; i++) dv.setBigUint64(i * 8, 0x1234n, true);
  return bytes;
}
const read = async (_addr, len) => vtableFixture().subarray(0, Number(len));

// 1. Valid bigint resolver addresses keep resolving.
{
  const table = await readVtable(read, 0x1000n, null, { resolvePointer: async () => ({ address: 0x16n }) });
  assert.equal(table.typeinfo, 0x16n);
  assert.equal(table.typeinfoUnresolved, false);
}

// 2. Valid non-negative safe-integer numbers keep resolving (exact conversion).
{
  const table = await readVtable(read, 0x1000n, null, { resolvePointer: async () => 22 });
  assert.equal(table.typeinfo, 22n);
  assert.equal(table.typeinfoUnresolved, false);
}

// 3. Strings only parse through the explicit canonical integer grammar;
//    non-canonical strings are rejected.
{
  const strict = await readVtable(read, 0x1000n, null, { resolvePointer: async () => ({ address: '16' }) });
  assert.equal(strict.typeinfo, 16n, 'a canonical decimal string parses through the explicit grammar');
  const nonCanonical = await readVtable(read, 0x1000n, null, { resolvePointer: async () => ({ address: '16abc' }) });
  assert.equal(nonCanonical.typeinfoUnresolved, true);
  assert.equal(nonCanonical.typeinfo, null);
}

// 4. Arrays, booleans and objects are rejected (no BigInt(['16'])/BigInt(true)).
{
  const arrayTable = await readVtable(read, 0x1000n, null, { resolvePointer: async () => ({ address: ['16'] }) });
  assert.equal(arrayTable.typeinfoUnresolved, true);
  const booleanTable = await readVtable(read, 0x1000n, null, { resolvePointer: async () => true });
  assert.equal(booleanTable.typeinfoUnresolved, true);
  const objectTable = await readVtable(read, 0x1000n, null, { resolvePointer: async () => ({ address: { toString: () => '16' } }) });
  assert.equal(objectTable.typeinfoUnresolved, true);
}

// 5. Unsafe numbers (beyond the safe-integer range) never become exact targets.
{
  const unsafe = 2 ** 53 + 1; // already rounded at the literal
  const table = await readVtable(read, 0x1000n, null, { resolvePointer: async () => unsafe });
  assert.equal(table.typeinfoUnresolved, true);
}

// 6. pointerFormat accepts only primitive integers; structured formats never
//    select a chained-pointer decoding.
{
  for (const badFormat of [['6'], '6', true, { format: 6 }, 1.5]) {
    const table = await readVtable(read, 0x1000n, null, { pointerFormat: badFormat });
    assert.equal(table.typeinfoUnresolved, true, `structured pointerFormat ${JSON.stringify(badFormat)} must not decode`);
  }
}

// 7. A valid canonical pointerFormat keeps decoding chained pointers.
{
  const table = await readVtable(read, 0x1000n, null, { pointerFormat: 6, imageBase: 0x100000000n });
  assert.equal(table.typeinfoUnresolved, false);
  assert.equal(table.typeinfo, 0x100000000n + 0xdeadn);
}

console.log('issue #5721 rtti resolver typed-contract regressions: PASS');
