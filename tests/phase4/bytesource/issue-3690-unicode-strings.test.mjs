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

async function scan(bytes, options = {}, sourceOptions = {}) {
  return scanSourceStrings(image, new MemoryByteSource(bytes, sourceOptions), {
    utf16: false,
    minLength: 4,
    ...options,
  });
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

test('#3690 source-backed UTF-8 scanning preserves non-ASCII Unicode runs', async () => {
  const encoder = new TextEncoder();
  for (const expected of ['日本語文', 'hello_日本語', 'Aé日😀B']) {
    const result = await scan(encoder.encode(`${expected}\0`), {
      minLength: [...expected].length,
      maxLength: [...expected].length,
    });
    assert.equal(result.cancelled, false);
    assert.equal(result.capped, false);
    assert.deepEqual(
      result.results.map(({ text, encoding, fileOffset, byteLength }) => ({
        text, encoding, fileOffset, byteLength,
      })),
      [{
        text: expected,
        encoding: 'utf8',
        fileOffset: 0n,
        byteLength: encoder.encode(expected).length,
      }],
    );
  }
});

test('#3690 UTF-8 codepoint split across ByteSource reads remains one string', async () => {
  const bytes = new TextEncoder().encode('A😀BC\0');
  const result = await scan(bytes, {}, { maxReadLength: 2 });
  assert.deepEqual(result.results.map(({ text, fileOffset, byteLength }) => (
    { text, fileOffset, byteLength }
  )), [{
    text: 'A😀BC',
    fileOffset: 0n,
    byteLength: new TextEncoder().encode('A😀BC').length,
  }]);
});

test('#3690 malformed UTF-8 cannot be decoded as replacement-character evidence', async () => {
  const invalidSequences = [
    [0xc0, 0xaf],
    [0xed, 0xa0, 0x80],
    [0xf4, 0x90, 0x80, 0x80],
    [0xe2, 0x28, 0xa1],
  ];
  const prefix = new TextEncoder().encode('WXYZ');
  const suffix = new TextEncoder().encode('QRST\0');

  for (const invalid of invalidSequences) {
    const bytes = new Uint8Array(prefix.length + invalid.length + suffix.length);
    bytes.set(prefix, 0);
    bytes.set(invalid, prefix.length);
    bytes.set(suffix, prefix.length + invalid.length);
    const result = await scan(bytes);
    assert.deepEqual(
      result.results.map(({ text, encoding }) => ({ text, encoding })),
      [
        { text: 'WXYZ', encoding: 'utf8' },
        { text: 'QRST', encoding: 'utf8' },
      ],
      `malformed sequence ${invalid.map((byte) => byte.toString(16)).join(' ')} must split evidence`,
    );
  }
});

test('#3690 source-backed UTF-16LE/BE scanning preserves Unicode and surrogate pairs', async () => {
  const expected = '猫😀語文';
  for (const encoding of ['le', 'be']) {
    const bytes = encodeUtf16(`${expected}\0`, encoding);
    const result = await scan(bytes, {
      utf16: encoding,
      minLength: 4,
      maxLength: 4,
    });
    const utf16 = result.results.filter((entry) => entry.encoding === `utf16${encoding}`);
    assert.deepEqual(
      utf16.map(({ text, fileOffset, byteLength }) => ({ text, fileOffset, byteLength })),
      [{
        text: expected,
        fileOffset: 0n,
        byteLength: encodeUtf16(expected, encoding).length,
      }],
    );
  }
});

test('#3690 UTF-16 surrogate pair split across ByteSource reads remains one string', async () => {
  const expected = '猫😀語文';
  for (const encoding of ['le', 'be']) {
    const bytes = encodeUtf16(`${expected}\0`, encoding);
    const result = await scan(bytes, {
      utf16: encoding,
      minLength: 4,
      maxLength: 4,
    }, { maxReadLength: 3 });
    const utf16 = result.results.filter((entry) => entry.encoding === `utf16${encoding}`);
    assert.deepEqual(utf16.map((entry) => entry.text), [expected]);
  }
});

test('#3690 malformed UTF-16 surrogates are not promoted to string evidence', async () => {
  for (const encoding of ['le', 'be']) {
    for (const malformed of ['\ud800\0', '\udc00\0']) {
      const result = await scan(encodeUtf16(malformed, encoding), {
        utf16: encoding,
        minLength: 2,
      });
      const utf16 = result.results.filter((entry) => entry.encoding === `utf16${encoding}`);
      assert.deepEqual(utf16, []);
    }
  }
});

test('#3690 ASCII behavior and global result limit remain unchanged', async () => {
  const bytes = new TextEncoder().encode('ABCD\0日本語文\0WXYZ\0');
  const result = await scan(bytes, { limit: 2 });
  assert.deepEqual(result.results.map((entry) => entry.text), ['ABCD', '日本語文']);
  assert.equal(result.capped, true);
});
