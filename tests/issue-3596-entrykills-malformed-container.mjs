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
const Words = { KIND: {} };

function seeded(entryKills) {
  const p = AddressProvenance.create({
    words: Words,
    rangeStart: 0n,
    rangeEnd: 0x100n,
    entryKills,
  });
  p.note(0, 0x4000n, 0);
  p.enter(8n);
  return p.base(0, 2);
}

// #3596 acceptance 1: the regular array form still kills the stale base.
assert.equal(seeded([[8n, [0]]]), null);
assert.equal(seeded(new Map([[8n, [0]]]).entries()), null);
assert.equal(seeded([[8n, new Set([0])]]), null);

// #3596 acceptance 2: a malformed outer container is never a silent empty kill set.
for (const entryKills of ['not-a-kill-set', true, 1, {}]) {
  assert.throws(
    () => AddressProvenance.create({ words: Words, rangeStart: 0n, rangeEnd: 0x100n, entryKills }),
    (error) => error instanceof TypeError
      && error.message === 'address-provenance-entry-kills-required',
    `entryKills ${String(entryKills)} must not launder into an empty kill set`,
  );
}

// #3596 acceptance 3/4: a malformed nested register collection is rejected too,
// so stale ADR/ADRP provenance cannot survive the loop-entry merge.
for (const entryKills of [[[8n, '0']], [[8n, true]], [[8n, {}]], [[8n, 0]]]) {
  assert.throws(
    () => AddressProvenance.create({ words: Words, rangeStart: 0n, rangeEnd: 0x100n, entryKills }),
    (error) => error instanceof TypeError
      && error.message === 'address-provenance-entry-kill-registers-required',
    `entryKills ${String(entryKills)} must not drop the required kill`,
  );
}

// #3596 acceptance 5: the #3339 boundary contract stays enforced.
assert.throws(
  () => AddressProvenance.create({ words: Words, functionStarts: '0x10' }),
  (error) => error instanceof TypeError
    && error.message === 'address-provenance-boundary-collection-required',
);
assert.throws(
  () => AddressProvenance.create({ words: Words, branchEntries: true }),
  (error) => error instanceof TypeError
    && error.message === 'address-provenance-boundary-collection-required',
);

console.log('issue-3596 address-provenance entryKills malformed container: PASS');
