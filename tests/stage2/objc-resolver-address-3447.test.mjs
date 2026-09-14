import assert from 'node:assert/strict';

import { parseObjcExtendedMetadata } from '../../js/apple/objc-metadata.js';

const TABLE = 0x1000n;
const TARGET = 0x10000n;

function pointerBytes(value = 1n) {
  const out = new Uint8Array(8);
  let v = value;
  for (let i = 0; i < 8; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

async function runWithResolver(result) {
  const reads = [];
  const read = async (address, length) => {
    const at = BigInt(address);
    reads.push({ address: at, length });
    if (at === TABLE && length === 8) return pointerBytes(1n);
    // The target body only needs to be readable enough to prove that a resolver
    // result was accepted as an address. Zero bytes then make the category
    // itself invalid, which is fine for this boundary test.
    if (length > 0) return new Uint8Array(length);
    return null;
  };
  const parsed = await parseObjcExtendedMetadata(
    read,
    { categoryList: { vmAddr: TABLE, size: 8 } },
    {
      pageBytes: 8,
      resolvePointer: async () => result,
    },
  );
  return { reads, parsed };
}

// Canonical address primitives retain the existing resolver contract.
for (const value of [TARGET, Number(TARGET), TARGET.toString(10), `0x${TARGET.toString(16)}`]) {
  const { reads } = await runWithResolver(value);
  assert.ok(
    reads.some((entry) => entry.address === TARGET && entry.length === 56),
    `canonical resolver result ${String(value)} should drive the metadata read`,
  );
}

// #3447: structured/coercible or negative resolver values must not become
// metadata addresses through BigInt() coercion.
for (const value of [
  [TARGET.toString(10)],
  { valueOf: () => Number(TARGET) },
  true,
  -1n,
  -1,
  '-1',
  1.5,
]) {
  const { reads, parsed } = await runWithResolver(value);
  assert.equal(reads.length, 1, `malformed resolver result must stop after the pointer-table read: ${String(value)}`);
  assert.equal(parsed.categories.length, 0);
  assert.equal(parsed.completeness.categories.invalidEntries, 1);
  assert.equal(parsed.completeness.categories.complete, false);
}

console.log('Objective-C resolver address regression #3447: PASS');
