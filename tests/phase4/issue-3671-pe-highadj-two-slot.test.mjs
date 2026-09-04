import assert from 'node:assert/strict';
import test from 'node:test';
import { ByteView } from '../../js/binary/reader.js';
import { createPEMetadataBudget, parseBaseRelocations } from '../../js/binary/pe-loader.js';

const IMAGE_BASE = 0x140000000n;
const PAGE_RVA = 0x1000;
const MACHINE_AMD64 = 0x8664;

function makeBlock(words) {
  const bytes = new Uint8Array(8 + words.length * 2);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, PAGE_RVA, true);
  view.setUint32(4, bytes.length, true);
  for (let i = 0; i < words.length; i++) view.setUint16(8 + i * 2, words[i], true);
  return bytes;
}

function makeImage(fileSize) {
  const section = {
    index: 1,
    address: IMAGE_BASE + BigInt(PAGE_RVA),
    size: 0x1000n,
    fileOffset: 0n,
    fileSize: BigInt(fileSize),
    perms: { read: true, write: false, execute: false },
  };
  return {
    imageBase: IMAGE_BASE,
    bits: 64,
    sections: [section],
    segments: [],
    relocations: [],
    warnings: [],
    metadata: {},
    addressToOffset(address) {
      const delta = BigInt(address) - section.address;
      return delta >= 0n && delta < section.fileSize ? section.fileOffset + delta : null;
    },
  };
}

function parseWords(words, limits = null) {
  const bytes = makeBlock(words);
  const image = makeImage(bytes.length);
  const budget = createPEMetadataBudget(image, limits ? { limits } : {});
  parseBaseRelocations(new ByteView(bytes), { rva: PAGE_RVA, size: bytes.length }, image, MACHINE_AMD64, budget);
  return { image, budget };
}

test('HIGHADJ consumes the following slot instead of decoding it as HIGHLOW', () => {
  const { image } = parseWords([0x4100, 0x3004]);
  assert.deepEqual(image.relocations.map(({ address, type }) => ({ address, type })), [
    { address: IMAGE_BASE + 0x1100n, type: 4 },
  ]);
  assert.equal(image.metadata.peMetadata.complete, true);
});

test('HIGHADJ treats the second word as opaque adjustment payload even when its high nibble resembles DIR64', () => {
  const { image } = parseWords([0x4110, 0xa008]);
  assert.deepEqual(image.relocations.map(({ address, type }) => ({ address, type })), [
    { address: IMAGE_BASE + 0x1110n, type: 4 },
  ]);
});

test('a final-slot HIGHADJ is partial and never becomes authoritative relocation evidence', () => {
  const { image } = parseWords([0x0000, 0x4100]);
  assert.deepEqual(image.relocations, []);
  assert.equal(image.metadata.peMetadata.complete, false);
  assert.ok(image.metadata.peMetadata.reasons.includes('relocations:truncated-highadj'));
});

test('the HIGHADJ adjustment word is charged to the shared metadata input budget', () => {
  const { image, budget } = parseWords([0x4100, 0x3004], { inputBytes: 11 });
  assert.deepEqual(image.relocations, []);
  assert.equal(budget.used.inputBytes, 10);
  assert.equal(image.metadata.peMetadata.complete, false);
  assert.ok(image.metadata.peMetadata.reasons.includes('budget:relocation-highadj-adjustment:inputBytes'));
});

test('ordinary one-slot HIGHLOW relocations keep their existing decode', () => {
  const { image } = parseWords([0x3004]);
  assert.deepEqual(image.relocations.map(({ address, type }) => ({ address, type })), [
    { address: IMAGE_BASE + 0x1004n, type: 3 },
  ]);
});
