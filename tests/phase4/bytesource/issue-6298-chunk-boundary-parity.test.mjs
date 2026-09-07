import assert from 'node:assert/strict';
import test from 'node:test';

import { MemoryByteSource } from '../../../js/binary/source.js';
import { scanSourceStrings } from '../../../js/bytesource/strings.js';

const image = Object.freeze({
  sections: [],
  segments: [],
  endian: 'little',
  offsetToAddress(offset) { return offset; },
});

function comparableStrings(result) {
  return result.results.map(({ text, encoding, fileOffset, byteLength }) => ({
    text,
    encoding,
    fileOffset: fileOffset.toString(),
    byteLength,
  }));
}

async function assertChunkParity(bytes, options, message) {
  const unchunked = await scanSourceStrings(image, new MemoryByteSource(bytes), {
    ...options,
    chunkSize: 1_000_000,
  });
  const chunked = await scanSourceStrings(image, new MemoryByteSource(bytes), {
    ...options,
    chunkSize: 65_536,
  });
  assert.equal(chunked.cancelled, false, `${message}: chunked scan must complete`);
  assert.equal(chunked.capped, unchunked.capped, `${message}: capped state must match unchunked scan`);
  assert.deepEqual(comparableStrings(chunked), comparableStrings(unchunked), message);
  return chunked;
}

function encodeUtf16(text, encoding) {
  const be = encoding === 'be';
  const bytes = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    bytes[i * 2] = be ? code >>> 8 : code & 0xff;
    bytes[i * 2 + 1] = be ? code & 0xff : code >>> 8;
  }
  return bytes;
}

function alignmentSafeUtf16(text) {
  if (!text) throw new TypeError('UTF-16 witness text is required');
  // U+0100 makes the byte immediately before the witness a delimiter in both
  // byte orders when the surrounding fixture is zero-filled. This keeps the
  // test about chunk carry/parity instead of accidental one-byte alignment.
  return `\u0100${text.slice(1)}`;
}

test('#6298 UTF-16LE/BE preserve ordinary and delimiter-adjacent runs across a chunk boundary', async () => {
  for (const encoding of ['le', 'be']) {
    const ordinary = new Uint8Array(65_560);
    const ordinaryText = alignmentSafeUtf16('ABCDEFGH');
    ordinary.set(encodeUtf16(ordinaryText, encoding), 65_531);
    const ordinaryResult = await assertChunkParity(
      ordinary,
      { utf16: encoding, minLength: 2, maxLength: 64 },
      `${encoding} ordinary boundary run must match unchunked scan`,
    );
    assert.deepEqual(ordinaryResult.results.map((entry) => [entry.fileOffset, entry.text]), [[65_531n, ordinaryText]]);

    const delimiterAfter = new Uint8Array(65_560);
    const delimiterAfterText = alignmentSafeUtf16('ABCD');
    delimiterAfter.set(encodeUtf16(delimiterAfterText, encoding), 65_528);
    delimiterAfter[65_536] = 0;
    delimiterAfter[65_537] = 0;
    const afterResult = await assertChunkParity(
      delimiterAfter,
      { utf16: encoding, minLength: 2, maxLength: 64 },
      `${encoding} run ending immediately before the chunk delimiter must match`,
    );
    assert.deepEqual(afterResult.results.map((entry) => [entry.fileOffset, entry.text]), [[65_528n, delimiterAfterText]]);

    const delimiterBefore = new Uint8Array(65_560);
    const delimiterBeforeText = alignmentSafeUtf16('WXYZ');
    delimiterBefore[65_534] = 0;
    delimiterBefore[65_535] = 0;
    delimiterBefore.set(encodeUtf16(delimiterBeforeText, encoding), 65_536);
    const beforeResult = await assertChunkParity(
      delimiterBefore,
      { utf16: encoding, minLength: 2, maxLength: 64 },
      `${encoding} run starting immediately after the chunk delimiter must match`,
    );
    assert.deepEqual(beforeResult.results.map((entry) => [entry.fileOffset, entry.text]), [[65_536n, delimiterBeforeText]]);
  }
});

test('#6298 UTF-16LE/BE long runs spanning multiple chunks preserve segmentation', async () => {
  const runLength = 70_000;
  const maxLength = 4096;
  const expected = Array.from({ length: Math.ceil(runLength / maxLength) }, (_, index) => {
    const length = Math.min(maxLength, runLength - index * maxLength);
    return [BigInt(index * maxLength * 2), length * 2, 'Q'.repeat(length)];
  });

  for (const encoding of ['le', 'be']) {
    const bytes = encodeUtf16('Q'.repeat(runLength), encoding);
    const result = await assertChunkParity(
      bytes,
      { utf16: encoding, maxLength },
      `${encoding} multi-chunk long run must keep canonical segmentation`,
    );
    assert.deepEqual(
      result.results.map(({ fileOffset, byteLength, text }) => [fileOffset, byteLength, text]),
      expected,
    );
  }
});

test('#6298 ASCII long run spanning multiple chunks preserves canonical segmentation', async () => {
  const runLength = 200_000;
  const maxLength = 4093;
  const bytes = new TextEncoder().encode('R'.repeat(runLength));
  const result = await assertChunkParity(
    bytes,
    { utf16: false, minLength: 2, maxLength },
    'ASCII multi-chunk long run must keep canonical segmentation',
  );
  const expected = Array.from({ length: Math.ceil(runLength / maxLength) }, (_, index) => {
    const length = Math.min(maxLength, runLength - index * maxLength);
    return [BigInt(index * maxLength), length, 'R'.repeat(length)];
  });
  assert.deepEqual(
    result.results.map(({ fileOffset, byteLength, text }) => [fileOffset, byteLength, text]),
    expected,
  );
});

test('#6298 carry dedupe cannot consume a small result limit', async () => {
  const ascii = new Uint8Array(65_560);
  ascii.set(new TextEncoder().encode('ABCDEFGH'), 65_532);
  ascii[65_540] = 0;
  ascii.set(new TextEncoder().encode('WXYZ'), 65_541);
  ascii[65_545] = 0;
  const asciiResult = await assertChunkParity(
    ascii,
    { utf16: false, minLength: 2, maxLength: 64, limit: 2 },
    'ASCII carry duplicate must not consume limit=2',
  );
  assert.deepEqual(asciiResult.results.map((entry) => entry.text), ['ABCDEFGH', 'WXYZ']);
  assert.equal(asciiResult.capped, false);

  for (const encoding of ['le', 'be']) {
    const bytes = new Uint8Array(65_570);
    const firstText = alignmentSafeUtf16('ABCDEFGH');
    const secondText = alignmentSafeUtf16('WXYZ');
    bytes.set(encodeUtf16(firstText, encoding), 65_530);
    bytes[65_546] = 0;
    bytes[65_547] = 0;
    bytes.set(encodeUtf16(secondText, encoding), 65_548);
    bytes[65_556] = 0;
    bytes[65_557] = 0;
    const result = await assertChunkParity(
      bytes,
      { utf16: encoding, minLength: 2, maxLength: 64, limit: 2 },
      `${encoding} carry duplicate must not consume limit=2`,
    );
    assert.deepEqual(result.results.map((entry) => entry.text), [firstText, secondText]);
    assert.equal(result.capped, false);
  }
});
