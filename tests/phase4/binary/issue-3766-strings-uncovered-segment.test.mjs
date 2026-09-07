import assert from 'node:assert/strict';
import { scanStrings } from '../../../js/binary/strings.js';
import { scanSourceStrings } from '../../../js/bytesource/strings.js';
import { MemoryByteSource } from '../../../js/binary/source.js';

const encoder = new TextEncoder();
const bytes = encoder.encode('HEAD\0GAPX\0TAIL\0OUTX\0');

function imageFor({ sections, segments }) {
  return {
    endian: 'little',
    bytes,
    sections,
    segments,
    offsetToAddress(offset) {
      return offset < 15n ? 0x1000n + offset : null;
    },
  };
}

class CountingSource extends MemoryByteSource {
  constructor(input) {
    super(input);
    this.reads = [];
  }
  async read(offset, length, options = {}) {
    this.reads.push([offset, length]);
    return super.read(offset, length, options);
  }
}

const sections = [
  { name: '.head', fileOffset: 0n, fileSize: 5n, perms: { execute: false } },
  { name: '.tail', fileOffset: 10n, fileSize: 5n, perms: { execute: false } },
];
const segments = [
  { name: 'LOAD', fileOffset: 0n, fileSize: 15n, perms: { execute: false } },
];

{
  const image = imageFor({ sections, segments });
  const resident = scanStrings(image, { minLength: 4, utf16: false });
  assert.deepEqual(resident.map((x) => x.text), ['HEAD', 'GAPX', 'TAIL']);
  assert.deepEqual(resident.map((x) => x.fileOffset), [0n, 5n, 10n]);
  assert.ok(!resident.some((x) => x.text === 'OUTX'));

  const source = new CountingSource(bytes);
  const streamed = await scanSourceStrings(image, source, { minLength: 4, utf16: false });
  assert.deepEqual(streamed.results.map((x) => x.text), ['HEAD', 'GAPX', 'TAIL']);
  assert.deepEqual(streamed.results.map((x) => x.fileOffset), [0n, 5n, 10n]);
  assert.deepEqual(source.reads, [[0n, 5], [5n, 5], [10n, 5]], 'section/segment overlap must not be read twice');
}

{
  const image = imageFor({
    sections: [{ name: '.all', fileOffset: 0n, fileSize: 15n, perms: { execute: false } }],
    segments,
  });
  const source = new CountingSource(bytes);
  const streamed = await scanSourceStrings(image, source, { minLength: 4, utf16: false });
  assert.deepEqual(streamed.results.map((x) => x.text), ['HEAD', 'GAPX', 'TAIL']);
  assert.deepEqual(source.reads, [[0n, 15]], 'fully section-covered segment must not add a second scan');
}

{
  const image = imageFor({ sections: [], segments });
  const resident = scanStrings(image, { minLength: 4, utf16: false });
  const streamed = await scanSourceStrings(image, bytes, { minLength: 4, utf16: false });
  assert.deepEqual(resident.map((x) => x.text), ['HEAD', 'GAPX', 'TAIL']);
  assert.deepEqual(streamed.results.map((x) => x.text), ['HEAD', 'GAPX', 'TAIL']);
}

{
  const image = imageFor({
    sections: [{ name: '.text', fileOffset: 0n, fileSize: 5n, perms: { execute: true } }],
    segments: [{ name: 'LOAD', fileOffset: 0n, fileSize: 10n, perms: { execute: false } }],
  });
  const resident = scanStrings(image, { minLength: 4, utf16: false });
  const streamed = await scanSourceStrings(image, bytes, { minLength: 4, utf16: false });
  assert.deepEqual(resident.map((x) => x.text), ['GAPX']);
  assert.deepEqual(streamed.results.map((x) => x.text), ['GAPX']);
}

{
  const image = imageFor({ sections: [], segments: [] });
  const resident = scanStrings(image, { minLength: 4, utf16: false });
  const streamed = await scanSourceStrings(image, bytes, { minLength: 4, utf16: false });
  assert.deepEqual(resident.map((x) => x.text), ['HEAD', 'GAPX', 'TAIL', 'OUTX']);
  assert.deepEqual(streamed.results.map((x) => x.text), ['HEAD', 'GAPX', 'TAIL', 'OUTX']);
}

console.log('issue-3766-strings-uncovered-segment: PASS');
