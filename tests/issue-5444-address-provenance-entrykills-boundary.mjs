import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadProvenance() {
  const context = vm.createContext({
    console, TextDecoder, TextEncoder, Uint8Array, Uint8ClampedArray, Uint16Array,
    Uint32Array, Int32Array, BigUint64Array, BigInt64Array, DataView, ArrayBuffer,
    BigInt, Map, Set, WeakMap, WeakSet, Promise, Object, Array, Math, Number,
    String, Boolean, RegExp, Error, TypeError, RangeError, JSON, Date,
  });
  context.globalThis = context;
  context.self = context;
  for (const file of ['js/words.js', 'js/address-provenance.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
  }
  return context.AddressProvenance;
}

const AddressProvenance = loadProvenance();
const words = { KIND: {} };

// #5444: malformed entryKills register collections must fail with the named
// boundary contract error, not a raw for...of TypeError.
const malformed = [
  [[0, 1]],          // bare number register collection
  [[0, {}]],         // plain object
  [[0, true]],       // boolean
  [[0, 'x0']],       // string is not an iterable of registers
  [[0, 1], [8, {}]], // later malformed entries still validate
];
for (const entryKills of malformed) {
  assert.throws(
    () => AddressProvenance.create({ words, entryKills }),
    (error) => error instanceof TypeError
      && error.message === 'address-provenance-entry-kill-registers-required',
    `entryKills ${JSON.stringify(entryKills)} must fail the register-collection boundary`,
  );
}

// The entryKills collection itself is a boundary too.
for (const entryKills of [1, {}, true, 'x']) {
  assert.throws(
    () => AddressProvenance.create({ words, entryKills }),
    (error) => error instanceof TypeError
      && error.message === 'address-provenance-entry-kills-required',
  );
}

// Semantic filtering still happens after shape validation: out-of-range
// targets with valid register collections are dropped, not errors.
{
  const p = AddressProvenance.create({
    words,
    rangeStart: 0x100n,
    rangeEnd: 0x200n,
    entryKills: [[0n, [0, 1]], [0x180n, [2]]],
  });
  assert.equal(p.pendingEntries, 1, 'out-of-range entry-kill target must be dropped after shape validation');
}

// Null/undefined register collections and entryKills stay accepted.
{
  const p = AddressProvenance.create({ words, entryKills: [[0n, null], [8n, undefined]] });
  assert.equal(p.pendingEntries, 0);
  const q = AddressProvenance.create({ words, entryKills: null });
  assert.equal(q.pendingEntries, 0);
}

// Valid register collections keep the #6225 union behaviour.
{
  const p = AddressProvenance.create({
    words,
    rangeStart: 0n,
    rangeEnd: 0x10000n,
    entryKills: [[8n, [0]], [8n, [1]]],
  });
  assert.equal(p.pendingEntries, 1);
  p.enter(8n);
  assert.equal(p.base(0, 2), null);
  assert.equal(p.base(1, 2), null);
}

console.log('issue-5444 address-provenance entryKills boundary: PASS');
