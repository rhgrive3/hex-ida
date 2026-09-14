import assert from 'node:assert/strict';
import test from 'node:test';
import { scanSourceStrings } from '../../../js/bytesource/strings.js';
import { MemoryByteSource } from '../../../js/binary/source.js';

const image = { sections: [], segments: [], endian: 'little', offsetToAddress: (offset) => offset };

for (const bytes of [new Uint8Array(0), new TextEncoder().encode('ABCD\0')]) {
  test(`pre-aborted string scan reports cancellation for ${bytes.length} input bytes`, async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await scanSourceStrings(image, bytes, { signal: controller.signal, utf16: false });
    assert.deepEqual(result, { results: [], cancelled: true, capped: false });
  });
}

test('pre-aborted string scan reports cancellation when every mapping is excluded', async () => {
  const controller = new AbortController();
  controller.abort();
  const mapped = { ...image, sections: [{ fileOffset: 0n, fileSize: 5n, perms: { execute: true } }] };
  const result = await scanSourceStrings(mapped, new TextEncoder().encode('ABCD\0'), { signal: controller.signal, utf16: false });
  assert.deepEqual(result, { results: [], cancelled: true, capped: false });
});

test('pre-aborted scans do not inspect image mappings or invoke optional callbacks', async () => {
  const controller = new AbortController();
  controller.abort();
  let inspected = 0;
  const mapped = { get sections() { inspected++; throw new Error('cancelled scan inspected mappings'); } };
  const result = await scanSourceStrings(mapped, new TextEncoder().encode('ABCD\0'), {
    signal: controller.signal, utf16: false,
    onProgress() { throw new Error('cancelled scan invoked progress'); },
  });
  assert.deepEqual(result, { results: [], cancelled: true, capped: false });
  assert.equal(inspected, 0);
});

test('an abort in the final progress callback cannot be published as a completed scan', async () => {
  const controller = new AbortController();
  const events = [];
  const result = await scanSourceStrings(image, new TextEncoder().encode('ABCD\0'), {
    signal: controller.signal, utf16: false,
    onProgress(event) { events.push(event); controller.abort(); },
  });
  assert.equal(events.length, 1);
  assert.equal(result.cancelled, true);
  assert.equal(result.capped, false);
  assert.deepEqual(result.results.map(({ text }) => text), ['ABCD']);
});

test('cancellation during an address callback wins over capped/completed publication', async () => {
  const controller = new AbortController();
  const mapped = { ...image, offsetToAddress(offset) { controller.abort(); return offset; } };
  const result = await scanSourceStrings(mapped, new TextEncoder().encode('ABCD\0EFGH\0'), {
    signal: controller.signal, utf16: false, limit: 1,
  });
  assert.equal(result.cancelled, true);
  assert.equal(result.capped, false);
});

test('oversized minLength cannot bypass the 64 Ki-codepoint carry bound', async () => {
  for (const minLength of [65537, 65536.5, 2 ** 32, Number.MAX_VALUE]) {
    let reads = 0;
    const source = {
      size: 1n << 60n,
      async read() { reads++; throw new Error('oversized scan must fail before reading'); },
    };
    await assert.rejects(scanSourceStrings(image, source, { minLength, utf16: false }), (error) => {
      return error instanceof RangeError && error.code === 'STRING_SCAN_RESOURCE_LIMIT';
    });
    assert.equal(reads, 0);
  }
});

function encodedUtf16(text, be) {
  const bytes = Buffer.from(`${text}\0`, 'utf16le');
  if (be) bytes.swap16();
  return new Uint8Array(bytes);
}

for (const encoding of ['utf8', 'utf16le', 'utf16be']) {
  test(`streaming ${encoding} carry owns bytes when the backend reuses Buffer storage`, async () => {
    const expectedText = encoding === 'utf8' ? 'Aé中😀BCDE' : '\u0100日本😀CDEF';
    const payload = encoding === 'utf8'
      ? new TextEncoder().encode(`${expectedText}\0`)
      : encodedUtf16(expectedText, encoding === 'utf16be');
    const opts = { utf16: encoding === 'utf8' ? false : encoding, minLength: 2, maxLength: 64 };
    const baseline = await scanSourceStrings(image, new MemoryByteSource(payload), opts);
    assert.deepEqual(baseline.results.filter((entry) => entry.encoding === encoding).map(({ text }) => text), [expectedText]);
    for (const maxReadLength of [1, 2, 3, 5, 7]) {
      const storage = Buffer.allocUnsafe(maxReadLength + 4);
      const scratch = storage.subarray(2, 2 + maxReadLength);
      const source = {
        size: BigInt(payload.length), maxReadLength,
        async read(offset, length) {
          scratch.fill(0xff);
          scratch.set(payload.subarray(Number(offset), Number(offset) + length));
          return scratch.subarray(0, length);
        },
      };
      const result = await scanSourceStrings(image, source, opts);
      assert.deepEqual(result, baseline, `read ceiling=${maxReadLength}`);
    }
  });
}

test('maximum admitted minLength remains supported without truncating its witness', async () => {
  const bytes = new Uint8Array(65537).fill(65);
  bytes[65536] = 0;
  const result = await scanSourceStrings(image, new MemoryByteSource(bytes, { maxReadLength: 65535 }), {
    minLength: 65536, maxLength: 65536, utf16: false,
  });
  assert.equal(result.cancelled, false);
  assert.equal(result.capped, false);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].byteLength, 65536);
  assert.equal(result.results[0].text, 'A'.repeat(65536));
});
