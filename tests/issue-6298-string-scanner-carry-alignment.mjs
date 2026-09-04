import assert from 'node:assert/strict';
import { scanStrings } from '../js/binary/strings.js';
import { scanSourceStrings } from '../js/bytesource/strings.js';

function makeImage(bytes) {
  return {
    bytes,
    sections: [{ name: '.text', fileOffset: 0n, fileSize: BigInt(bytes.length), perms: { execute: false } }],
    segments: [],
    endian: 'little',
    offsetToAddress(offset) { return offset; },
  };
}

// 1. 'A' x 65540, maxLength=4, chunkSize=65536 で resident/source 結果の offset・length が一致する
{
  const count = 65540;
  const bytes = new Uint8Array(count);
  bytes.fill(0x41); // 'A'

  const img = makeImage(bytes);
  const resident = scanStrings(img, { minLength: 4, maxLength: 4, utf16: false });
  const sourceRes = await scanSourceStrings(img, bytes, {
    minLength: 4,
    maxLength: 4,
    chunkSize: 65536,
    utf16: false,
  });

  assert.equal(sourceRes.results.length, resident.length, 'total segment count must match');
  assert.equal(resident.length, 16385); // 65540 / 4 = 16385
  for (let i = 0; i < resident.length; i++) {
    assert.equal(sourceRes.results[i].fileOffset, resident[i].fileOffset, `fileOffset mismatch at index ${i}`);
    assert.equal(sourceRes.results[i].byteLength, resident[i].byteLength, `byteLength mismatch at index ${i}`);
    assert.equal(sourceRes.results[i].text, resident[i].text);
  }

  // Verify the segment boundary across chunk 65536 specifically:
  const lastChunk1 = sourceRes.results.find((r) => r.fileOffset === 65532n);
  const firstChunk2 = sourceRes.results.find((r) => r.fileOffset === 65536n);
  assert.ok(lastChunk1, 'must have segment at 65532');
  assert.ok(firstChunk2, 'must have segment at 65536');
  // Must NOT have misaligned duplicate segments like 65526, 65530, 65534, 65538
  const misaligned = sourceRes.results.filter((r) => r.fileOffset > 65520n && r.fileOffset < 65540n && (r.fileOffset % 4n) !== 0n);
  assert.equal(misaligned.length, 0, 'must not have misaligned duplicate segments');
}

// 2. Long ASCII run crossing multiple chunks produces no overlaps or duplicates
{
  const total = 200000;
  const bytes = new Uint8Array(total);
  bytes.fill(0x42); // 'B'

  const img = makeImage(bytes);
  const resident = scanStrings(img, { minLength: 4, maxLength: 8, utf16: false });
  const sourceRes = await scanSourceStrings(img, bytes, {
    minLength: 4,
    maxLength: 8,
    chunkSize: 64 * 1024,
    utf16: false,
  });

  assert.equal(sourceRes.results.length, resident.length);
  assert.equal(sourceRes.capped, false);
}

// 3. UTF-16 LE chunk boundary parity across single-chunk and multi-chunk
{
  // 65536 bytes chunk size
  // UTF-16 string of 'X\0' x 32772 = 65544 bytes
  const chars = 32772;
  const bytes = new Uint8Array(chars * 2);
  for (let i = 0; i < chars; i++) {
    bytes[i * 2] = 0x58; // 'X'
    bytes[i * 2 + 1] = 0x00;
  }

  const img = makeImage(bytes);
  const singleChunk = await scanSourceStrings(img, bytes, {
    minLength: 4,
    maxLength: 4,
    chunkSize: 200000,
    utf16: 'le',
  });
  const multiChunk = await scanSourceStrings(img, bytes, {
    minLength: 4,
    maxLength: 4,
    chunkSize: 65536,
    utf16: 'le',
  });

  assert.equal(multiChunk.results.length, singleChunk.results.length);
  assert.equal(multiChunk.results.length, 8193); // 32772 / 4 = 8193
  for (let i = 0; i < singleChunk.results.length; i++) {
    assert.equal(multiChunk.results[i].fileOffset, singleChunk.results[i].fileOffset);
    assert.equal(multiChunk.results[i].byteLength, singleChunk.results[i].byteLength);
  }
}

// 4. maxLength 未満で chunk を跨ぐ通常 string は 1 件として回収する
{
  const boundary = 64 * 1024;
  const bytes = new Uint8Array(boundary + 64);
  const text = 'SPANNED_NORMAL_STRING';
  const encoded = new TextEncoder().encode(text);
  // Place string across boundary (starts 8 bytes before boundary)
  bytes.set(encoded, boundary - 8);

  const img = makeImage(bytes);
  const sourceRes = await scanSourceStrings(img, bytes, {
    minLength: 4,
    maxLength: 4096,
    chunkSize: boundary,
    utf16: false,
  });

  const found = sourceRes.results.filter((r) => r.text.includes('SPANNED'));
  assert.equal(found.length, 1, 'should find exactly 1 instance of the spanned string');
  assert.equal(found[0].text, text);
  assert.equal(found[0].fileOffset, BigInt(boundary - 8));
}

// 5. Delimiter right at chunk boundary
{
  const boundary = 64 * 1024;
  const bytes = new Uint8Array(boundary * 2);
  bytes.set(new TextEncoder().encode('BEFORE_BOUNDARY\0'), boundary - 16);
  bytes.set(new TextEncoder().encode('AFTER_BOUNDARY\0'), boundary);

  const img = makeImage(bytes);
  const sourceRes = await scanSourceStrings(img, bytes, {
    minLength: 4,
    chunkSize: boundary,
    utf16: false,
  });

  const before = sourceRes.results.find((r) => r.text === 'BEFORE_BOUNDARY');
  const after = sourceRes.results.find((r) => r.text === 'AFTER_BOUNDARY');
  assert.ok(before, 'found BEFORE_BOUNDARY');
  assert.ok(after, 'found AFTER_BOUNDARY');
  assert.equal(before.fileOffset, BigInt(boundary - 16));
  assert.equal(after.fileOffset, BigInt(boundary));
}

console.log('issue-6298 regression test: PASS');
