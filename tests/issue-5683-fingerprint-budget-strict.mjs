// Regression for #5683: binary fingerprint budget helper coerced every option
// through Number(), so Arrays / booleans / numeric strings / fractional values
// became the canonical maxBytes / fallbackBytes / chunkBytes resource budgets.
// Contract now: only primitive positive safe-integer numbers are adopted;
// everything else falls back to the documented defaults.
import assert from 'node:assert/strict';
import { fingerprintFunction, fingerprintImage } from '../js/binary/fingerprint.js';

const image = {
  bytes: new Uint8Array(1024).fill(7),
  readVirtual(_addr, size) { return this.bytes.subarray(0, Number(size)); },
};
const fn = { address: 0n, size: 1024n };

// 1. Structured maxBytes must not shrink function fingerprint coverage.
{
  const fp = fingerprintFunction(image, fn, { maxBytes: ['16'] });
  assert.equal(fp.bytes, 1024, "maxBytes:['16'] must fall back to the 1MiB default, not 16 bytes");
  assert.equal(fp.truncated, false, 'full-size function must not report truncation under malformed maxBytes');
}

// 2. Structured fallbackBytes must not become the size-less fallback.
{
  const fp = fingerprintFunction(image, { address: 0n, size: null }, { fallbackBytes: ['32'] });
  assert.equal(fp.bytes, 64, "fallbackBytes:['32'] must fall back to the 64-byte default");
}

// 3. Boolean / numeric string / fractional / non-finite options all fall back.
{
  assert.equal(fingerprintFunction(image, fn, { maxBytes: true }).bytes, 1024, 'boolean maxBytes must fall back');
  assert.equal(fingerprintFunction(image, fn, { maxBytes: '16' }).bytes, 1024, 'numeric string maxBytes must fall back');
  assert.equal(fingerprintFunction(image, fn, { maxBytes: 16.5 }).bytes, 1024, 'fractional maxBytes must fall back');
  assert.equal(fingerprintFunction(image, fn, { maxBytes: Number.NaN }).bytes, 1024, 'NaN maxBytes must fall back');
  assert.equal(fingerprintFunction(image, fn, { maxBytes: 2 ** 53 }).bytes, 1024, 'unsafe integer maxBytes must fall back');
}

// 4. Canonical budgets keep the existing cap semantics.
{
  const fp = fingerprintFunction(image, fn, { maxBytes: 16 });
  assert.equal(fp.bytes, 16, 'canonical maxBytes=16 must cap coverage');
  assert.equal(fp.truncated, true, 'canonical maxBytes=16 must report truncation');
}

// 5. Source-backed chunkBytes: malformed values must not schedule the read grid.
function spySource(data) {
  const reads = [];
  return {
    maxReadLength: 1 << 20,
    reads,
    async readExactly(offset, length) {
      reads.push(Number(length));
      return data.subarray(Number(offset), Number(offset) + Number(length));
    },
  };
}

const data = new Uint8Array(8192).fill(9);
const ranges = [{ fileSize: 8192n, fileOffset: 0n, perms: { execute: true } }];

{
  const source = spySource(data);
  const malformed = await fingerprintImage({ bytes: null, source, sections: ranges, segments: [] }, { chunkBytes: ['4096'] });
  assert.deepEqual(source.reads, [8192],
    "chunkBytes:['4096'] must fall back to the 256KiB default, keeping the single full read");
  assert.equal(malformed.bytes, 8192);
}

{
  const source = spySource(data);
  const canonical = await fingerprintImage({ bytes: null, source, sections: ranges, segments: [] }, { chunkBytes: 4096 });
  assert.deepEqual(source.reads, [4096, 4096],
    'canonical chunkBytes=4096 must still split the read grid');
  assert.equal(canonical.bytes, 8192);
}

{
  const source = spySource(data);
  const fallback = await fingerprintImage({ bytes: null, source, sections: ranges, segments: [] }, {});
  assert.deepEqual(source.reads, [8192], 'default chunk budget must cover 8192 bytes in one read');
  assert.equal(fallback.bytes, 8192);
}

// 6. Resident/source-backed canonical parity is preserved.
{
  const resident = fingerprintImage({ bytes: data, sections: ranges, segments: [] }, {});
  const source = spySource(data);
  const sourceBacked = await fingerprintImage({ bytes: null, source, sections: ranges, segments: [] }, {});
  assert.equal(resident.hash, sourceBacked.hash, 'resident and source-backed hashes must stay identical');
}

console.log('issue-5683 fingerprint budget strictness: ok');
