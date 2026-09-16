import assert from 'node:assert/strict';
import test from 'node:test';

import { scanStrings } from '../js/binary/strings.js';
import { MemoryByteSource } from '../js/binary/source.js';
import { scanSourceStrings } from '../js/bytesource/strings.js';

const bytes = new TextEncoder().encode('日本語');

function image() {
  return Object.freeze({
    bytes,
    sections: [],
    segments: [],
    endian: 'little',
    fileSize: BigInt(bytes.length),
    size: BigInt(bytes.length),
    offsetToAddress(offset) { return offset; },
  });
}

test('#3937 source-backed scanStrings parity: non-ASCII UTF-8 is not lost vs resident', async () => {
  const opts = { minLength: 3, utf16: false };
  const resident = scanStrings(image(), opts);
  const source = await scanSourceStrings(image(), new MemoryByteSource(bytes), opts);

  const residentTexts = resident.map((r) => r.text).sort();
  const sourceTexts = source.results.map((r) => r.text).sort();

  assert.deepEqual(sourceTexts, residentTexts);
  assert.ok(sourceTexts.includes('日本語'), 'source-backed must extract 日本語 like resident');
  assert.ok(source.results.every((r) => r.encoding === 'utf8'));
});
