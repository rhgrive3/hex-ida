import test from 'node:test';
import assert from 'node:assert/strict';
import { parseELF } from '../../js/binary/elf-core.js';

function elf64({ machine = 183, entry = 0x4000n, vaddr = 0x4000n, filesz = 0x200n, memsz = filesz, flags = 5 }) {
  const byteLength = 0x200;
  const bytes = new Uint8Array(byteLength);
  const view = new DataView(bytes.buffer);
  bytes.set([0x7f, 0x45, 0x4c, 0x46], 0);
  view.setUint8(4, 2); // ELFCLASS64
  view.setUint8(5, 1); // ELFDATA2LSB
  view.setUint8(6, 1); // EV_CURRENT
  view.setUint16(16, 2, true); // ET_EXEC
  view.setUint16(18, machine, true);
  view.setUint32(20, 1, true);
  view.setBigUint64(24, entry, true);
  view.setBigUint64(32, 64n, true); // e_phoff
  view.setBigUint64(40, 0n, true); // no section table
  view.setUint16(52, 64, true);
  view.setUint16(54, 56, true);
  view.setUint16(56, 1, true);
  view.setUint16(58, 64, true);

  const ph = 64;
  view.setUint32(ph, 1, true); // PT_LOAD
  view.setUint32(ph + 4, flags, true);
  view.setBigUint64(ph + 8, 0n, true);
  view.setBigUint64(ph + 16, vaddr, true);
  view.setBigUint64(ph + 24, vaddr, true);
  view.setBigUint64(ph + 32, filesz, true);
  view.setBigUint64(ph + 40, memsz, true);
  view.setBigUint64(ph + 48, 0x1000n, true);
  return bytes;
}

function entrySeeds(image) {
  return image.functions.filter((fn) => fn.source === 'entrypoint');
}

test('AArch64 keeps aligned file-backed entrypoint in executable PT_LOAD', () => {
  const image = parseELF(elf64({ entry: 0x4000n }));
  assert.equal(entrySeeds(image).length, 1);
  assert.equal(entrySeeds(image)[0].address, 0x4000n);
  assert.equal(entrySeeds(image)[0].confidence, 0.9);
});

test('AArch64 rejects entrypoint outside executable mapping', () => {
  const image = parseELF(elf64({ entry: 0x5003n }));
  assert.equal(entrySeeds(image).length, 0);
  assert.ok(image.warnings.some((warning) => warning.includes('Ignored ELF entrypoint')));
});

test('AArch64 rejects misaligned entrypoint inside executable mapping', () => {
  const image = parseELF(elf64({ entry: 0x4002n }));
  assert.equal(entrySeeds(image).length, 0);
  assert.ok(image.warnings.some((warning) => warning.includes('alignment')));
});

test('entrypoint requires file-backed instruction bytes', () => {
  const image = parseELF(elf64({ entry: 0x4100n, filesz: 0x100n, memsz: 0x200n }));
  assert.equal(entrySeeds(image).length, 0);
  assert.ok(image.warnings.some((warning) => warning.includes('file-backed')));
});

test('x86_64 rejects entrypoint in non-executable PT_LOAD', () => {
  const image = parseELF(elf64({ machine: 62, entry: 0x4000n, flags: 4 }));
  assert.equal(entrySeeds(image).length, 0);
  assert.ok(image.warnings.some((warning) => warning.includes('executable')));
});

test('AArch64 zero reset vector survives only when executable and file-backed', () => {
  const valid = parseELF(elf64({ entry: 0n, vaddr: 0n }));
  assert.equal(entrySeeds(valid).length, 1);
  assert.equal(valid.metadata.entrypointZeroEvidence, 'aarch64-executable-pt-load-at-zero');

  const nonExecutable = parseELF(elf64({ entry: 0n, vaddr: 0n, flags: 4 }));
  assert.equal(entrySeeds(nonExecutable).length, 0);
  assert.equal(nonExecutable.metadata.entrypointZeroEvidence, 'zero-sentinel-unproven');
});
