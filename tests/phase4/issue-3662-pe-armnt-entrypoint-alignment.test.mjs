import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePE } from '../../js/binary/pe.js';

const MACHINE_ARM = 0x01c0;
const MACHINE_ARMNT = 0x01c4;
const MACHINE_ARM64 = 0xaa64;

function makePE({ machine, entryRva, bits = machine === MACHINE_ARM64 ? 64 : 32 }) {
  const bytes = new Uint8Array(0x400);
  const view = new DataView(bytes.buffer);
  const pe = 0x80;
  const coff = pe + 4;
  const optionalSize = bits === 64 ? 0xf0 : 0xe0;
  const opt = coff + 20;
  const section = opt + optionalSize;
  const imageBase = bits === 64 ? 0x140000000n : 0x10000000n;

  view.setUint16(0, 0x5a4d, true);
  view.setUint32(0x3c, pe, true);
  view.setUint32(pe, 0x00004550, true);
  view.setUint16(coff, machine, true);
  view.setUint16(coff + 2, 1, true);
  view.setUint16(coff + 16, optionalSize, true);
  view.setUint16(coff + 18, 0x0002, true);

  view.setUint16(opt, bits === 64 ? 0x20b : 0x10b, true);
  view.setUint32(opt + 16, entryRva, true);
  if (bits === 64) view.setBigUint64(opt + 24, imageBase, true);
  else view.setUint32(opt + 28, Number(imageBase), true);
  view.setUint32(opt + 32, 0x1000, true);
  view.setUint32(opt + 36, 0x200, true);
  view.setUint32(opt + 56, 0x2000, true);
  view.setUint32(opt + 60, 0x200, true);
  view.setUint16(opt + 68, 3, true);
  view.setUint32(opt + (bits === 64 ? 108 : 92), 0, true);

  bytes.set(new TextEncoder().encode('.text'), section);
  view.setUint32(section + 8, 0x200, true);
  view.setUint32(section + 12, 0x1000, true);
  view.setUint32(section + 16, 0x200, true);
  view.setUint32(section + 20, 0x200, true);
  view.setUint32(section + 36, 0x60000020, true);
  bytes[0x200] = 0x70;
  bytes[0x201] = 0x47;
  bytes[0x202] = 0x00;
  bytes[0x203] = 0xbf;

  return bytes;
}

function entrypointSeed(image) {
  return image.functions.find((seed) => seed.source === 'entrypoint') ?? null;
}

test('ARMNT accepts a 2-byte-aligned Thumb-2 entrypoint', () => {
  const image = parsePE(makePE({ machine: MACHINE_ARMNT, entryRva: 0x1002 }));
  assert.equal(image.metadata.entrypointValid, true);
  assert.equal(image.metadata.entrypointDiagnostic, null);
  assert.equal(entrypointSeed(image)?.address, 0x10001002n);
});

test('ARMNT still rejects an odd entrypoint', () => {
  const image = parsePE(makePE({ machine: MACHINE_ARMNT, entryRva: 0x1001 }));
  assert.equal(image.metadata.entrypointValid, false);
  assert.match(image.metadata.entrypointDiagnostic, /2-byte aligned/);
  assert.equal(entrypointSeed(image), null);
});

test('ARM64 keeps 4-byte entrypoint alignment', () => {
  const rejected = parsePE(makePE({ machine: MACHINE_ARM64, entryRva: 0x1002 }));
  assert.equal(rejected.metadata.entrypointValid, false);
  assert.match(rejected.metadata.entrypointDiagnostic, /4-byte aligned/);
  assert.equal(entrypointSeed(rejected), null);

  const accepted = parsePE(makePE({ machine: MACHINE_ARM64, entryRva: 0x1004 }));
  assert.equal(accepted.metadata.entrypointValid, true);
  assert.equal(entrypointSeed(accepted)?.address, 0x140001004n);
});

test('classic ARM keeps the existing 4-byte policy', () => {
  const image = parsePE(makePE({ machine: MACHINE_ARM, entryRva: 0x1002 }));
  assert.equal(image.metadata.entrypointValid, false);
  assert.match(image.metadata.entrypointDiagnostic, /4-byte aligned/);
  assert.equal(entrypointSeed(image), null);
});
