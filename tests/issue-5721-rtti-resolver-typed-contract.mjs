// Issue #5721 regression: vtable pointer resolution must type-check resolver
// output, pointerFormat, and imageBase before use. BigInt()/Number() coercion
// must never turn structured/unsafe inputs into canonical pointer authority.
import assert from 'node:assert/strict';
import { readVtable } from '../js/rtti.js';

function vtableFixture() {
  const bytes = new Uint8Array(8 * 5);
  const dv = new DataView(bytes.buffer);
  dv.setBigUint64(0, 0n, true);
  dv.setBigUint64(8, 0xdeadn, true);
  for (let i = 2; i < 5; i++) dv.setBigUint64(i * 8, 0x1234n, true);
  return bytes;
}
const read = async (_addr, len) => vtableFixture().subarray(0, Number(len));

// 1. Valid bigint and safe-integer resolver addresses keep resolving.
for (const [value, expected] of [[0x16n, 0x16n], [22, 22n]]) {
  const table = await readVtable(read, 0x1000n, null, { resolvePointer: async () => ({ address: value }) });
  assert.equal(table.typeinfo, expected);
  assert.equal(table.typeinfoUnresolved, false);
}

// 2. Canonical decimal/hex strings use an explicit grammar, not ToPrimitive.
for (const [value, expected] of [['16', 16n], ['0x10', 16n]]) {
  const table = await readVtable(read, 0x1000n, null, { resolvePointer: async () => ({ address: value }) });
  assert.equal(table.typeinfo, expected);
  assert.equal(table.typeinfoUnresolved, false);
}
for (const value of ['16abc', ' 16 ', '', '-1']) {
  const table = await readVtable(read, 0x1000n, null, { resolvePointer: async () => ({ address: value }) });
  assert.equal(table.typeinfoUnresolved, true, `non-canonical address ${JSON.stringify(value)} must fail closed`);
  assert.equal(table.typeinfo, null);
}

// 3. Structured, boolean, negative, and unsafe addresses are never exact targets.
for (const value of [['16'], true, { toString: () => '16' }, -1, -1n, 2 ** 53 + 1]) {
  const table = await readVtable(read, 0x1000n, null, { resolvePointer: async () => ({ address: value }) });
  assert.equal(table.typeinfoUnresolved, true, `invalid resolver address ${String(value)} must fail closed`);
  assert.equal(table.typeinfo, null);
}
{
  const table = await readVtable(read, 0x1000n, null, { resolvePointer: async () => true });
  assert.equal(table.typeinfoUnresolved, true, 'invalid top-level resolver result must fail closed');
}

// 4. pointerFormat must be a primitive member of the supported finite set.
for (const badFormat of [['6'], '6', true, { format: 6 }, 1.5, -1, 0, 3, 11]) {
  const table = await readVtable(read, 0x1000n, null, { pointerFormat: badFormat });
  assert.equal(table.typeinfoUnresolved, true, `invalid pointerFormat ${JSON.stringify(badFormat)} must not decode`);
}

// 5. Every supported format remains accepted; format-specific semantics are
// covered in issue-840-rtti-pointer-formats.mjs. Here we pin the authority gate.
for (const format of [1, 2, 6, 7, 9, 10, 12]) {
  const table = await readVtable(read, 0x1000n, null, { pointerFormat: format, imageBase: 0x100000000n });
  assert.ok(table && typeof table.typeinfoUnresolved === 'boolean');
}

// 6. imageBase follows the same canonical non-negative address contract. A
// structured value used to reach BigInt(imageBase) inside chained decoding.
for (const badBase of [['4294967296'], true, { toString: () => '4294967296' }, -1, -1n, 2 ** 53 + 1, ' 4294967296 ', '-1']) {
  const table = await readVtable(read, 0x1000n, null, { pointerFormat: 6, imageBase: badBase });
  assert.equal(table.typeinfoUnresolved, true, `invalid imageBase ${String(badBase)} must fail closed`);
}
{
  const table = await readVtable(read, 0x1000n, null, { pointerFormat: 6, imageBase: '4294967296' });
  assert.equal(table.typeinfoUnresolved, false, 'canonical imageBase string stays supported by explicit grammar');
  assert.equal(table.typeinfo, 0x100000000n + 0xdeadn);
}
{
  const table = await readVtable(read, 0x1000n, null, { pointerFormat: 6, imageBase: 0x100000000n });
  assert.equal(table.typeinfoUnresolved, false);
  assert.equal(table.typeinfo, 0x100000000n + 0xdeadn);
}

// 7. A resolver receives normalized option authority, not caller-owned
// coercible representations.
{
  let context = null;
  const table = await readVtable(read, 0x1000n, null, {
    pointerFormat: 6,
    imageBase: '4294967296',
    resolvePointer: async (_raw, options) => { context = options; return { address: 0x16n }; },
  });
  assert.equal(table.typeinfo, 0x16n);
  assert.equal(context.pointerFormat, 6);
  assert.equal(context.imageBase, 0x100000000n);
}

console.log('issue #5721 rtti resolver typed-contract regressions: PASS');
