import assert from 'node:assert/strict';
import { fingerprintImage, fingerprintBytes } from '../js/binary/fingerprint.js';

function makeImage(buffer, { sections = [], segments = [] } = {}) {
  return {
    bytes: buffer,
    sections,
    segments,
  };
}

function makeSourceImage(buffer, { sections = [], segments = [] } = {}) {
  return {
    source: {
      async readExactly(offset, length) {
        const off = Number(offset);
        return buffer.subarray(off, off + length);
      },
    },
    sections,
    segments,
  };
}

const EXEC = { read: true, write: false, execute: true };

function pseudoBytes(length, salt) {
  let state = (salt * 2654435761 + 1) >>> 0;
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    out[i] = state & 0xff;
  }
  return out;
}

function section(name, { address, fileOffset, fileSize, flags = 0x6n, source = 'section-header', perms = EXEC }) {
  return { name, source, flags, address, fileOffset, fileSize, size: fileSize, perms };
}

function segment(name, { address, fileOffset, fileSize, perms = EXEC }) {
  return { name, address, fileOffset, fileSize, size: fileSize, perms };
}

// 1. #4672 minimal counterexample: a byte inside the executable file-backed
//    segment but outside every section must still be covered by the fingerprint.
{
  const buffer = pseudoBytes(0x100, 1);
  const other = buffer.slice();
  other[0x20] ^= 0xff;

  const seg = segment('LOAD_EXEC', { address: 0x1000n, fileOffset: 0n, fileSize: 0x100n });
  const sec = section('.text', { address: 0x1000n, fileOffset: 0n, fileSize: 0x10n });
  const meta = { sections: [sec], segments: [seg] };

  const a = fingerprintImage(makeImage(buffer, meta));
  const b = fingerprintImage(makeImage(other, meta));

  assert.notEqual(a.hash, b.hash, 'a change to section-external segment bytes must change the fingerprint');
  assert.equal(a.bytes, 0x100, 'the whole file-backed segment range must be hashed exactly once');
}

// 2. An executable segment fully covered by one section must keep the plain
//    section hash (and the plain segment hash) without double counting.
{
  const buffer = pseudoBytes(0x400, 2);

  const sec = section('.text', { address: 0x1000n, fileOffset: 0n, fileSize: 0x400n });
  const seg = segment('LOAD_EXEC', { address: 0x1000n, fileOffset: 0n, fileSize: 0x400n });

  const together = fingerprintImage(makeImage(buffer, { sections: [sec], segments: [seg] }));
  const sectionsOnly = fingerprintImage(makeImage(buffer, { sections: [sec], segments: [] }));
  const segmentsOnly = fingerprintImage(makeImage(buffer, { sections: [], segments: [seg] }));

  assert.equal(together.hash, sectionsOnly.hash, 'a fully covered segment must not change the fingerprint');
  assert.equal(together.hash, segmentsOnly.hash, 'sectionless fallback must hash the same mapped bytes');
  assert.equal(together.bytes, 0x400, 'covered bytes must not be hashed twice');
}

// 3. The fingerprint must be the digest of the canonical ascending union of
//    file-backed mapped ranges, independent of which metadata described them.
{
  const buffer = pseudoBytes(0x400, 3);

  const seg = segment('LOAD_EXEC', { address: 0x2000n, fileOffset: 0n, fileSize: 0x400n });
  const sec = section('.text', { address: 0x2300n, fileOffset: 0x300n, fileSize: 0x100n });

  const fp = fingerprintImage(makeImage(buffer, { sections: [sec], segments: [seg] }));

  assert.equal(fp.bytes, 0x400, 'the union of file-backed ranges must be hashed once');
  assert.equal(fp.hash, fingerprintBytes(buffer), 'hash must be the digest of file bytes in ascending file-offset order');
}

// 4. Metadata insertion order must not change the fingerprint.
{
  const buffer = pseudoBytes(0x400, 4);

  const low = section('.lo', { address: 0x1000n, fileOffset: 0n, fileSize: 0x100n });
  const high = section('.hi', { address: 0x1200n, fileOffset: 0x200n, fileSize: 0x100n });
  const gap = segment('LOAD_GAP', { address: 0x1100n, fileOffset: 0x100n, fileSize: 0x100n });

  const forward = fingerprintImage(makeImage(buffer, { sections: [low, high], segments: [gap] }));
  const reversed = fingerprintImage(makeImage(buffer, { sections: [high, low], segments: [gap] }));

  assert.equal(forward.hash, reversed.hash, 'section array order must not change the fingerprint');
  assert.equal(forward.bytes, 0x300, 'the disjoint mapped ranges must all be hashed once');

  const segmentsOnly = fingerprintImage(makeImage(buffer, { sections: [], segments: [high, gap, low] }));
  assert.equal(forward.hash, segmentsOnly.hash, 'segment array order must not change the fingerprint either');
}

// 5. Overlapping sections must not double-hash the same file bytes.
{
  const buffer = pseudoBytes(0x300, 5);

  const secA = section('.a', { address: 0x1000n, fileOffset: 0n, fileSize: 0x200n });
  const secB = section('.b', { address: 0x1100n, fileOffset: 0x100n, fileSize: 0x200n });
  const unionSec = section('.u', { address: 0x1000n, fileOffset: 0n, fileSize: 0x300n });

  const overlapping = fingerprintImage(makeImage(buffer, { sections: [secA, secB], segments: [] }));
  const single = fingerprintImage(makeImage(buffer, { sections: [unionSec], segments: [] }));

  assert.equal(overlapping.bytes, 0x300, 'overlapping section bytes must be hashed once');
  assert.equal(overlapping.hash, single.hash, 'the union of overlapping sections must equal the canonical range digest');
}

// 6. executableOnly:false must cover every file-backed mapped range exactly
//    once, including bytes shared with a non-mapped section.
{
  const buffer = pseudoBytes(0x200, 6);

  const debug = section('.debug_x', {
    address: null,
    fileOffset: 0n,
    fileSize: 0x100n,
    source: 'unmapped-section',
    flags: 0n,
    perms: { read: true, write: false, execute: false },
  });
  const dataSeg = segment('LOAD_DATA', {
    address: 0x5000n,
    fileOffset: 0x80n,
    fileSize: 0x100n,
    perms: { read: true, write: true, execute: false },
  });

  const fp = fingerprintImage(makeImage(buffer, { sections: [debug], segments: [dataSeg] }), { executableOnly: false });

  assert.equal(fp.scope, 'all-mappings');
  assert.equal(fp.bytes, 0x180, 'the mapped file range union must be hashed once under all-mappings');
  assert.equal(fp.hash, fingerprintBytes(buffer.subarray(0, 0x180)), 'all-mappings hash must be the canonical ascending digest');
}

// 7. Resident and source-backed paths must agree on the canonical ranges,
//    including when the metadata arrays are listed in a different order.
{
  const buffer = pseudoBytes(0x400, 7);

  const low = section('.lo', { address: 0x1000n, fileOffset: 0n, fileSize: 0x100n });
  const high = section('.hi', { address: 0x1200n, fileOffset: 0x200n, fileSize: 0x100n });
  const gap = segment('LOAD_GAP', { address: 0x1100n, fileOffset: 0x100n, fileSize: 0x100n });

  const resident = fingerprintImage(makeImage(buffer, { sections: [low, high], segments: [gap] }));
  const sourceShuffled = await fingerprintImage(makeSourceImage(buffer, { sections: [gap, high, low], segments: [] }));
  const sourceForward = await fingerprintImage(makeSourceImage(buffer, { sections: [low, high], segments: [gap] }));

  assert.equal(sourceShuffled.hash, resident.hash, 'source-backed digest must match the resident canonical digest under any listing order');
  assert.equal(sourceForward.hash, resident.hash, 'source-backed digest must match the resident digest');
  assert.equal(sourceShuffled.bytes, resident.bytes);
}

console.log('issue #4672 fingerprint mapped-range union tests: PASS');
