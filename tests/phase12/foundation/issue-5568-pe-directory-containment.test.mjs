import assert from 'node:assert/strict';
import test from 'node:test';

import { inspectFormatSafeImage } from '../../../js/rebuild/format-safe.js';

// #5568 — the format-safe PE parser must bound the Data Directory probe by
// SizeOfOptionalHeader (Microsoft PE/COFF). With NumberOfRvaAndSizes > 4 but
// no directory space in the header, the Certificate Table entry previously
// aliased section-table bytes and could fabricate signature state.

function buildPe32({ optionalHeaderSize, numberOfRvaAndSizes, certInSectionTable }) {
  const bytes = new Uint8Array(0x200);
  const view = new DataView(bytes.buffer);
  bytes.set([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00], 0); // DOS
  view.setUint32(0x3c, 0x40, true); // e_lfanew
  bytes.set([0x50, 0x45, 0x00, 0x00], 0x40); // PE\0\0
  view.setUint16(0x44, 0x014c, true); // IMAGE_FILE_MACHINE_I386
  view.setUint16(0x46, 1, true); // one section
  view.setUint16(0x54, optionalHeaderSize, true); // SizeOfOptionalHeader
  view.setUint16(0x58, 0x0102, true); // characteristics
  const optional = 0x40 + 24;
  view.setUint16(optional, 0x10b, true); // PE32 magic
  view.setUint32(optional + 92, numberOfRvaAndSizes, true);
  const sectionTable = optional + optionalHeaderSize;
  if (certInSectionTable) {
    // Decoy "certificate entry" inside the first section header (offset+32..39)
    view.setUint32(sectionTable + 32, 0x100, true);
    view.setUint32(sectionTable + 36, 0x10, true);
    bytes[0x100] = 0xaa; // table bytes exist
  }
  return bytes;
}

test('#5568 a directory probe past SizeOfOptionalHeader fails closed', () => {
  const bytes = buildPe32({ optionalHeaderSize: 96, numberOfRvaAndSizes: 5, certInSectionTable: true });
  assert.throws(() => inspectFormatSafeImage(bytes), /format-safe-pe-data-directory-truncated/);
});

test('#5568 the same contradictory declaration fails even without decoy bytes', () => {
  const bytes = buildPe32({ optionalHeaderSize: 96, numberOfRvaAndSizes: 5, certInSectionTable: false });
  assert.throws(() => inspectFormatSafeImage(bytes), /format-safe-pe-data-directory-truncated/);
});

test('#5568 PE32 containment still applies when the header is exactly minimal+directory', () => {
  const bytes = buildPe32({ optionalHeaderSize: 112, numberOfRvaAndSizes: 16, certInSectionTable: false });
  // 16 entries × 8 = 128 bytes needed, only 112−96 = 16 available → rejected.
  assert.throws(() => inspectFormatSafeImage(bytes), /format-safe-pe-data-directory-truncated/);
});

test('#5568 a directory that fits the optional header keeps parsing', () => {
  // 96 + 5*8 = 136-byte header: the five probed entries fit the declared space.
  const bytes = buildPe32({ optionalHeaderSize: 136, numberOfRvaAndSizes: 5, certInSectionTable: false });
  const info = inspectFormatSafeImage(bytes);
  assert.equal(info.format, 'pe');
  assert.equal(info.snapshot.signatureState, 'unsigned', 'no decoy bytes may fabricate signature state');
});
