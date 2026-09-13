import assert from 'node:assert/strict';
import { scanStrings } from '../js/binary/strings.js';
import { scanSourceStrings } from '../js/bytesource/strings.js';

// Issue #5653: resident scanStrings must respect includeExecutable:false
// on sectionless images with executable segments, matching scanSourceStrings.

function makeImage(bytes, { sections = [], segments = [], endian = 'little' } = {}) {
  return {
    bytes,
    endian,
    sections,
    segments,
    offsetToAddress(off) {
      const n = BigInt(off);
      for (const seg of segments) {
        const start = BigInt(seg.fileOffset ?? 0);
        const size = BigInt(seg.fileSize ?? 0);
        if (n >= start && n < start + size) {
          return BigInt(seg.address ?? 0n) + (n - start);
        }
      }
      return n;
    },
  };
}

// 1. sectionless + executable-only segment + default options (includeExecutable: false)
{
  const bytes = new TextEncoder().encode('EXEC_STRING_1234\0');
  const image = makeImage(bytes, {
    sections: [],
    segments: [
      {
        name: 'LOAD_EXEC',
        address: 0x1000n,
        fileOffset: 0n,
        fileSize: BigInt(bytes.length),
        perms: { read: true, write: false, execute: true },
      },
    ],
  });

  const resident = scanStrings(image, { minLength: 4 });
  assert.equal(resident.length, 0, 'resident: executable segment must not be scanned by default');

  const streamed = await scanSourceStrings(image, bytes, { minLength: 4 });
  assert.equal(streamed.results.length, 0, 'source-backed: executable segment must not be scanned by default');
}

// 2. same fixture + includeExecutable: true
{
  const bytes = new TextEncoder().encode('EXEC_STRING_1234\0');
  const image = makeImage(bytes, {
    sections: [],
    segments: [
      {
        name: 'LOAD_EXEC',
        address: 0x1000n,
        fileOffset: 0n,
        fileSize: BigInt(bytes.length),
        perms: { read: true, write: false, execute: true },
      },
    ],
  });

  const resident = scanStrings(image, { minLength: 4, includeExecutable: true, utf16: false });
  assert.equal(resident.length, 1);
  assert.equal(resident[0].text, 'EXEC_STRING_1234');
  assert.equal(resident[0].address, 0x1000n);

  const streamed = await scanSourceStrings(image, bytes, { minLength: 4, includeExecutable: true, utf16: false });
  assert.equal(streamed.results.length, 1);
  assert.equal(streamed.results[0].text, 'EXEC_STRING_1234');
  assert.equal(streamed.results[0].address, 0x1000n);
}

// 3. sectionless + non-executable segment -> default scans
{
  const bytes = new TextEncoder().encode('DATA_STRING_5678\0');
  const image = makeImage(bytes, {
    sections: [],
    segments: [
      {
        name: 'LOAD_DATA',
        address: 0x2000n,
        fileOffset: 0n,
        fileSize: BigInt(bytes.length),
        perms: { read: true, write: true, execute: false },
      },
    ],
  });

  const resident = scanStrings(image, { minLength: 4, utf16: false });
  assert.equal(resident.length, 1);
  assert.equal(resident[0].text, 'DATA_STRING_5678');
  assert.equal(resident[0].address, 0x2000n);

  const streamed = await scanSourceStrings(image, bytes, { minLength: 4, utf16: false });
  assert.equal(streamed.results.length, 1);
  assert.equal(streamed.results[0].text, 'DATA_STRING_5678');
  assert.equal(streamed.results[0].address, 0x2000n);
}

// 4. sections and segments both empty (raw image fallback)
{
  const bytes = new TextEncoder().encode('RAW_STRING_9999\0');
  const image = makeImage(bytes, { sections: [], segments: [] });

  const resident = scanStrings(image, { minLength: 4, utf16: false });
  assert.equal(resident.length, 1);
  assert.equal(resident[0].text, 'RAW_STRING_9999');

  const streamed = await scanSourceStrings(image, bytes, { minLength: 4, utf16: false });
  assert.equal(streamed.results.length, 1);
  assert.equal(streamed.results[0].text, 'RAW_STRING_9999');
}

// 5. mixed segments: one executable, one data
{
  const part1 = new TextEncoder().encode('EXEC_SECRET_001\0');
  const part2 = new TextEncoder().encode('DATA_PUBLIC_002\0');
  const bytes = new Uint8Array(part1.length + part2.length);
  bytes.set(part1, 0);
  bytes.set(part2, part1.length);

  const image = makeImage(bytes, {
    sections: [],
    segments: [
      {
        name: 'TEXT',
        address: 0x1000n,
        fileOffset: 0n,
        fileSize: BigInt(part1.length),
        perms: { read: true, write: false, execute: true },
      },
      {
        name: 'DATA',
        address: 0x2000n,
        fileOffset: BigInt(part1.length),
        fileSize: BigInt(part2.length),
        perms: { read: true, write: true, execute: false },
      },
    ],
  });

  const resident = scanStrings(image, { minLength: 4, utf16: false });
  assert.equal(resident.length, 1);
  assert.equal(resident[0].text, 'DATA_PUBLIC_002');
  assert.equal(resident[0].address, 0x2000n);

  const streamed = await scanSourceStrings(image, bytes, { minLength: 4, utf16: false });
  assert.equal(streamed.results.length, 1);
  assert.equal(streamed.results[0].text, 'DATA_PUBLIC_002');
  assert.equal(streamed.results[0].address, 0x2000n);
}

console.log('issue #5653 sectionless string scanner executable filter regressions: PASS');
