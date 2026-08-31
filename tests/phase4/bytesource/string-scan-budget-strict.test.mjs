import assert from 'node:assert/strict';
import test from 'node:test';
import { ByteSource, MemoryByteSource } from '../../../js/binary/source.js';
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
