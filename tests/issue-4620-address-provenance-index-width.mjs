import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadProvenance() {
  const context = vm.createContext({
    console, TextDecoder, TextEncoder, Uint8Array, Uint8ClampedArray, Uint16Array,
    Uint32Array, Int32Array, Float32Array, Float64Array, BigUint64Array, BigInt64Array,
    DataView, ArrayBuffer, BigInt, Map, Set, WeakMap, WeakSet, Promise, Object, Array,
    Math, Number, String, Boolean, RegExp, Error, TypeError, RangeError, JSON, Date,
  });
  context.globalThis = context;
  context.self = context;
  for (const file of ['js/words.js', 'js/address-provenance.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
  }
  return context.AddressProvenance;
}

const AddressProvenance = loadProvenance();

// 1. Just below the 32-bit signed boundary keeps the existing behaviour.
{
  const p = AddressProvenance.create({ pairWindow: 4 });
  const j = 2 ** 31 - 1;
  p.note(0, 0x12345000n, j);
  assert.equal(p.base(0, j), 0x12345000n, 'index 2^31-1 must keep its provenance');
  assert.equal(p.base(0, j + 4), 0x12345000n, 'index 2^31-1 must stay inside the pair window');
  assert.equal(p.base(0, j + 5), null, 'the pair window must still expire');
}

// 2. At the boundary the accepted index must survive note() -> base().
for (const i of [2 ** 31, 2 ** 31 + 7, Number.MAX_SAFE_INTEGER]) {
  const p = AddressProvenance.create({ pairWindow: 4 });
  p.note(0, 0x12345000n, i);
  assert.equal(p.base(0, i), 0x12345000n, `index ${i} must not be truncated on storage`);
  assert.equal(p.base(0, i - 1), null, `index ${i} must not claim provenance before it is born`);
}

// 3. Wrapping back into the positive range must not alias an unrelated index.
{
  const p = AddressProvenance.create({ pairWindow: 4 });
  const i = 2 ** 32 + 5;
  p.note(0, 0x12345000n, i);
  assert.equal(p.base(0, i), 0x12345000n, `index ${i} must keep its own provenance`);
  assert.equal(p.base(0, 5), null, `index ${i} must not alias instruction index 5`);
  assert.equal(p.base(0, 6), null, `index ${i} must not alias a neighbouring instruction index`);
}

// 4. Indices beyond the documented safe-integer domain are rejected, not wrapped.
{
  const p = AddressProvenance.create({ pairWindow: 4 });
  p.note(0, 0x12345000n, 2 ** 53);
  assert.equal(p.base(0, 2 ** 53), null, 'an unsafe index must not become accepted provenance');
  assert.equal(p.base(0, 0), null, 'an unsafe index must not alias instruction index 0');
  p.note(1, 0x12345000n, -1);
  assert.equal(p.base(1, 0), null, 'a negative index must not become accepted provenance');
}

// 5. The loop-entry fallback keeps the same index domain as note()/base().
for (const i of [2 ** 31, 2 ** 32 + 5]) {
  const p = AddressProvenance.create({
    rangeStart: 0n,
    rangeEnd: 0x10000n,
    pairWindow: 8,
    entryKills: [[8n, [0]]],
  });
  p.note(0, 0x12345000n, i);
  assert.equal(p.enter(8n), true, 'the seeded entry kill must be consumed');
  assert.equal(p.base(0, i), null, 'a killed chain is not ordinary proof');
  assert.equal(
    p.base(0, i, { allowEntryFallback: true }),
    0x12345000n,
    `entry fallback must retain index ${i} unchanged`,
  );
}

// 6. A chain built immediately before the target instruction still survives the
// entry kill, including at the 32-bit boundary.
{
  const p = AddressProvenance.create({
    rangeStart: 0n,
    rangeEnd: 0x10000n,
    pairWindow: 8,
    entryKills: [[8n, [0]], [8n, [1]]],
  });
  p.note(0, 0x1000n, 1);
  p.note(1, 0x2000n, 2 ** 31 - 1);
  assert.equal(p.enter(8n), true);
  assert.equal(p.base(0, 2), 0x1000n, 'the immediately preceding exact chain survives');
  assert.equal(p.base(1, 2 ** 31 - 1), null, 'an older chain is fallback-only after the kill');
  assert.equal(p.base(1, 2 ** 31 - 1, { allowEntryFallback: true }), 0x2000n);
}

// 7. Ordinary small indices keep the existing pair-window semantics.
{
  const p = AddressProvenance.create({ pairWindow: 4 });
  p.note(0, 0x1000n, 10);
  p.note(1, 0x2000n, 11);
  assert.equal(p.base(0, 14), 0x1000n);
  assert.equal(p.base(1, 15), 0x2000n);
  assert.equal(p.base(0, 15), null);
  p.kill(0);
  assert.equal(p.base(0, 14), null);
  p.clear();
  assert.equal(p.base(1, 15, { allowEntryFallback: true }), null);
}

console.log('issue-4620 address-provenance instruction index width: PASS');
