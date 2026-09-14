import assert from 'node:assert/strict';
import test from 'node:test';
import { ByteSource, MemoryByteSource } from '../../../js/binary/source.js';
import { scanStrings } from '../../../js/binary/strings.js';
import { scanSourceStrings } from '../../../js/bytesource/strings.js';

const image = Object.freeze({
  sections: [],
  segments: [],
  endian: 'little',
  offsetToAddress(offset) { return offset; },
});

function fixtureBytes() {
  return new TextEncoder().encode('alphabet\0bravo\0charlie\0');
}

async function scan(options = {}) {
  return scanSourceStrings(image, new MemoryByteSource(fixtureBytes()), { utf16:false, ...options });
}

test('malformed string-scan limits fall back instead of shrinking coverage', async () => {
  for (const limit of [[], true, '1', { valueOf() { return 1; } }]) {
    const result = await scan({ limit });
    assert.equal(result.cancelled, false);
    assert.equal(result.capped, false);
    assert.deepEqual(result.results.map((entry) => entry.text), ['alphabet', 'bravo', 'charlie']);
  }
});

test('malformed min/max options do not become numeric scan bounds', async () => {
  const minResult = await scan({ minLength:['16'] });
  assert.deepEqual(minResult.results.map((entry) => entry.text), ['alphabet', 'bravo', 'charlie']);

  const maxResult = await scan({ maxLength:['4'] });
  assert.deepEqual(maxResult.results.map((entry) => entry.text), ['alphabet', 'bravo', 'charlie']);
});

test('malformed chunkSize uses the existing default rather than Number coercion', async () => {
  const bytes = new Uint8Array(130_000);
  bytes.set(new TextEncoder().encode('alphabet\0'));
  class RecordingSource extends ByteSource {
    constructor() { super(bytes.byteLength, { maxReadLength:1_000_000 }); this.readLengths = []; }
    async read(offset, length) {
      this.readLengths.push(length);
      const start = Number(offset);
      return bytes.subarray(start, start + length);
    }
  }
  for (const chunkSize of [['65536'], '65536', true, { valueOf() { return 65536; } }]) {
    const source = new RecordingSource();
    const result = await scanSourceStrings(image, source, { utf16:false, chunkSize });
    assert.equal(result.results[0]?.text, 'alphabet');
    assert.equal(source.readLengths[0], bytes.byteLength, 'malformed chunkSize must fall back to 256 KiB default');
  }
});

test('includeExecutable requires strict boolean true (#5198)', async () => {
  const execImage = {
    sections: [{
      name: '.text',
      fileOffset: 0n,
      fileSize: 5n,
      perms: { execute: true },
    }],
    endian: 'little',
    offsetToAddress: (off) => off,
  };
  const payload = new TextEncoder().encode('ABCD\0');

  // omitted / false / truthy non-booleans must exclude executable
  for (const includeExecutable of [undefined, false, 'false', 'true', {}, [], 1, 0]) {
    const res = await scanSourceStrings(execImage, payload, { utf16: false, includeExecutable });
    assert.equal(res.results.length, 0, `includeExecutable=${String(includeExecutable)} must not include .text`);
  }

  // strict true must include executable
  const resTrue = await scanSourceStrings(execImage, payload, { utf16: false, includeExecutable: true });
  assert.equal(resTrue.results.length, 1);
  assert.equal(resTrue.results[0].text, 'ABCD');
});

test('exact limit results do not falsely report capped:true (#6295)', async () => {
  const twoStrings = new TextEncoder().encode('AAAA\0BBBB\0');
  const threeStrings = new TextEncoder().encode('AAAA\0BBBB\0CCCC\0');

  // 1 string with limit 1: exactly 1 string, must be capped: false
  const res1 = await scanSourceStrings(image, new TextEncoder().encode('AAAA\0'), { utf16: false, limit: 1 });
  assert.equal(res1.results.length, 1);
  assert.equal(res1.capped, false);

  // 2 strings with limit 1: capped: true
  const res2 = await scanSourceStrings(image, twoStrings, { utf16: false, limit: 1 });
  assert.equal(res2.results.length, 1);
  assert.equal(res2.capped, true);

  // 2 strings with limit 2: exactly 2 strings, must be capped: false
  const res3 = await scanSourceStrings(image, twoStrings, { utf16: false, limit: 2 });
  assert.equal(res3.results.length, 2);
  assert.equal(res3.capped, false);

  // 3 strings with limit 2: capped: true
  const res4 = await scanSourceStrings(image, threeStrings, { utf16: false, limit: 2 });
  assert.equal(res4.results.length, 2);
  assert.equal(res4.capped, true);

  // cancellation must retain capped: false
  const controller = new AbortController();
  controller.abort();
  const resCancel = await scanSourceStrings(image, threeStrings, { utf16: false, limit: 1, signal: controller.signal });
  assert.equal(resCancel.cancelled, true);
  assert.equal(resCancel.capped, false);
});

test('carry does not re-segment or duplicate strings across chunk boundaries (#6298)', async () => {
  const bytes = new Uint8Array(65540);
  bytes.fill(0x41); // 'A' x 65540

  const residentImage = { bytes, sections: [], endian: 'little', offsetToAddress: (o) => o };
  const resident = scanStrings(residentImage, { utf16: false, maxLength: 4 });
  assert.equal(resident.length, 16385);

  const sourceBacked = await scanSourceStrings(image, new MemoryByteSource(bytes), {
    utf16: false,
    maxLength: 4,
    chunkSize: 65536,
  });

  assert.equal(sourceBacked.results.length, resident.length);
  for (let i = 0; i < resident.length; i++) {
    assert.equal(sourceBacked.results[i].fileOffset, resident[i].fileOffset, `offset mismatch at index ${i}`);
    assert.equal(sourceBacked.results[i].byteLength, resident[i].byteLength, `byteLength mismatch at index ${i}`);
    assert.equal(sourceBacked.results[i].text, resident[i].text, `text mismatch at index ${i}`);
  }

  // Verify UTF-16 across chunk boundary matches unchunked scan
  const u16Bytes = new Uint8Array(65540);
  for (let i = 0; i < 65540; i += 2) {
    u16Bytes[i] = 0x42; // 'B'
    u16Bytes[i + 1] = 0x00;
  }
  const unchunkedU16 = await scanSourceStrings(image, new MemoryByteSource(u16Bytes), {
    utf16: 'le',
    maxLength: 4,
    chunkSize: 100_000,
  });
  const sourceBackedU16 = await scanSourceStrings(image, new MemoryByteSource(u16Bytes), {
    utf16: 'le',
    maxLength: 4,
    chunkSize: 65536,
  });
  assert.equal(sourceBackedU16.results.length, unchunkedU16.results.length);
  for (let i = 0; i < unchunkedU16.results.length; i++) {
    assert.equal(sourceBackedU16.results[i].fileOffset, unchunkedU16.results[i].fileOffset);
    assert.equal(sourceBackedU16.results[i].byteLength, unchunkedU16.results[i].byteLength);
    assert.equal(sourceBackedU16.results[i].text, unchunkedU16.results[i].text);
  }
});

