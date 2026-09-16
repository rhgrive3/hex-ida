// Issue #8865 regression: the selected-slice Mach-O source cache must include
// the effective `strictPageAlignment` policy in its cache identity. A caller
// that opts out of FAT page-alignment validation (`strictPageAlignment:false`)
// could populate a successful cached image; a later caller for the same stable
// source and sliceIndex that requested (or defaulted to) strict validation was
// then served that relaxed image *without* `validateFatSlice` re-running under
// the stricter policy, laundering an Apple-invalid FAT member across the
// stricter consumer boundary. Cold strict parsing correctly rejects the same
// bytes, so the cache must not skip it.
import assert from 'node:assert/strict';
import test from 'node:test';

import { MemoryByteSource } from '../js/binary/source.js';
import { parseMachOSource } from '../js/binary/macho-source-cache.js';

const CPU_ARM64 = 0x0100000c;

// A universal slice whose declared `align` (0 => 2^0) admits the offset, but the
// offset itself (0x4008) is NOT page aligned, and whose thin header is an
// executable (filetype 2, neither object nor dSYM) so the strict page check
// applies. Relaxed parsing accepts it; strict parsing rejects it.
function misalignedFat() {
  const offset = 0x4008;
  const size = 0x1000;
  const bytes = new Uint8Array(offset + size);
  const dv = new DataView(bytes.buffer);
  dv.setUint32(0, 0xcafebabe, false); // FAT_MAGIC (big endian)
  dv.setUint32(4, 1, false); // one slice
  dv.setUint32(8, CPU_ARM64, false);
  dv.setUint32(12, 0, false);
  dv.setUint32(16, offset, false);
  dv.setUint32(20, size, false);
  dv.setUint32(24, 0, false); // align = 0 -> declaredAlignment = 1
  dv.setUint32(offset, 0xfeedfacf, true); // MH_MAGIC_64 (little endian)
  dv.setInt32(offset + 4, CPU_ARM64, true);
  dv.setInt32(offset + 8, 0, true);
  dv.setUint32(offset + 12, 2, true); // filetype = MH_EXECUTE
  dv.setUint32(offset + 16, 0, true); // ncmds = 0
  return bytes;
}

async function parseStrict(bytes, strictPageAlignment) {
  const options = { sliceIndex: 0 };
  if (strictPageAlignment !== undefined) options.strictPageAlignment = strictPageAlignment;
  return parseMachOSource(new MemoryByteSource(bytes), options);
}

test('#8865 a relaxed-populated slice is not served to an explicit strict caller', async () => {
  const bytes = misalignedFat();
  await parseStrict(bytes, false); // relaxed parse succeeds and primes the cache
  await assert.rejects(
    () => parseStrict(bytes, true),
    /not page aligned/,
    'strict validation must re-run and reject the page-misaligned member',
  );
});

test('#8865 the strict default is not served from a relaxed cache entry', async () => {
  const bytes = misalignedFat();
  await parseStrict(bytes, false); // prime relaxed
  await assert.rejects(
    () => parseStrict(bytes, undefined), // no explicit option => strict default
    /not page aligned/,
    'the strict default must not silently reuse the relaxed result',
  );
});

test('#8865 same-policy requests still succeed (the added discriminator does not break caching)', async () => {
  const bytes = misalignedFat();
  const first = await parseStrict(bytes, false);
  const second = await parseStrict(bytes, false);
  assert.ok(first, 'relaxed parse must succeed');
  assert.ok(second, 'a repeated relaxed parse (cache hit or cold) must still succeed');
});
