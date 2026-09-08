import assert from 'node:assert/strict';
import { parseLoadConfig } from '../../js/binary/pe-loader.js';

const IMAGE_BASE = 0x180000000n;
const LOAD_CONFIG_RVA = 0x1000;

function makeImage(fileSize = 0x200) {
  const section = {
    name: '.rdata',
    address: IMAGE_BASE + BigInt(LOAD_CONFIG_RVA),
    size: BigInt(fileSize),
    fileOffset: 0n,
    fileSize: BigInt(fileSize),
    perms: { read: true, write: false, execute: false },
  };
  return {
    bits: 64,
    imageBase: IMAGE_BASE,
    sections: [section],
    segments: [],
    metadata: {},
    warnings: [],
    functions: [],
    sectionAt(address) {
      return address >= section.address && address < section.address + section.size ? section : null;
    },
  };
}

function readerWithInternalSize(internalSize) {
  return {
    u32(offset) {
      assert.equal(offset, 0, 'load-config Size must be read from the mapped directory start');
      return internalSize;
    },
  };
}

function parseCase(internalSize, directorySize, fileSize = 0x200) {
  const image = makeImage(fileSize);
  parseLoadConfig(
    readerWithInternalSize(internalSize),
    { rva: LOAD_CONFIG_RVA, size: directorySize },
    image,
  );
  return image;
}

{
  const image = parseCase(4, 4);
  assert.equal(image.metadata.peMetadata.complete, true, 'matching Size values remain complete');
  assert.deepEqual(image.metadata.peMetadata.reasons, []);
}

{
  const image = parseCase(4, 8);
  assert.equal(image.metadata.peMetadata.complete, true, 'shorter versioned structure remains valid');
  assert.deepEqual(image.metadata.peMetadata.reasons, []);
}

{
  const image = parseCase(0x94, 0x80);
  assert.equal(image.metadata.peMetadata.complete, false, 'internal Size beyond Data Directory must be partial');
  assert(image.metadata.peMetadata.reasons.includes('load-config:size-mismatch'));
  assert.equal(image.metadata.loadConfig, undefined, 'clamped tail must not synthesize GuardCF metadata');
  assert.equal(image.functions.length, 0, 'clamped tail must not synthesize GuardCF function seeds');
}

{
  const image = parseCase(0x80, 0x80, 0x40);
  assert.equal(image.metadata.peMetadata.complete, false, 'short file backing remains partial');
  assert(image.metadata.peMetadata.reasons.includes('load-config:directory-span'));
}

console.log('issue-3714-pe-load-config-size-mismatch: PASS');
