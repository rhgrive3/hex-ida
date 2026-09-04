import assert from 'node:assert/strict';
import { BinaryImage } from '../../js/binary/model.js';

function finalizeImportPair(first, second) {
  const image = new BinaryImage(new Uint8Array(0));
  image.imports.push(first, second);
  image.finalize();
  assert.equal(image.imports.length, 1);
  return image.imports[0];
}

const base = {
  library: 'libc',
  name: 'puts',
  ordinal: null,
  weak: false,
};

assert.equal(finalizeImportPair(
  { ...base, address: 0n, source: 'first', sites: [] },
  { ...base, address: 0x1000n, source: 'second', sites: [] },
).address, 0n, 'a valid zero address must not be overwritten by a later non-zero duplicate');

assert.equal(finalizeImportPair(
  { ...base, address: null, source: 'first', sites: [] },
  { ...base, address: 0n, source: 'second', sites: [] },
).address, 0n, 'a later zero address must fill a nullish address');

assert.equal(finalizeImportPair(
  { ...base, address: null, source: 'first', sites: [] },
  { ...base, address: 0x1000n, source: 'second', sites: [] },
).address, 0x1000n, 'a later non-zero address must still fill a nullish address');

assert.equal(finalizeImportPair(
  { ...base, address: 0x2000n, source: 'first', sites: [] },
  { ...base, address: 0x1000n, source: 'second', sites: [] },
).address, 0x2000n, 'an existing non-null address keeps the established first-record precedence');

const merged = finalizeImportPair(
  {
    ...base,
    address: 0n,
    source: null,
    sites: [{ address: 0n, kind: 'bind' }],
  },
  {
    ...base,
    address: 0x1000n,
    source: 'dynsym',
    sites: [
      { address: 0n, kind: 'bind' },
      { address: 0x10n, kind: 'reloc' },
    ],
  },
);
assert.equal(merged.address, 0n);
assert.equal(merged.source, 'dynsym', 'source merge behavior must remain unchanged');
assert.deepEqual(
  merged.sites.map((site) => site.address),
  [0n, 0x10n],
  'site dedupe behavior must remain unchanged',
);

console.log('issue-3594-import-zero-address: PASS');
