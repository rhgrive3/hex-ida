import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GNU_PROPERTY_AARCH64_FEATURE_1_AND,
  GNU_PROPERTY_AARCH64_FEATURE_1_BTI,
  GNU_PROPERTY_AARCH64_FEATURE_1_GCS,
  GNU_PROPERTY_AARCH64_FEATURE_1_PAC,
  NT_GNU_PROPERTY_TYPE_0,
  PT_GNU_PROPERTY,
  parseAarch64GnuProperty,
} from '../../../js/binary/elf-gnu-property.js';
import { parseELF } from '../../../js/binary/elf-loader.js';

const ELF_SIZE = 0x300;
const PHOFF = 0x40;
const PHENTSIZE = 56;
const PROPERTY_OFFSET = 0x100;

function makeElf(featureBits, { propertyType = GNU_PROPERTY_AARCH64_FEATURE_1_AND, filesz = 32 } = {}) {
  const bytes = new Uint8Array(ELF_SIZE);
  const view = new DataView(bytes.buffer);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0);
  view.setUint16(16, 2, true);
  view.setUint16(18, 183, true);
  view.setUint32(20, 1, true);
  view.setBigUint64(32, BigInt(PHOFF), true);
  view.setUint16(52, 64, true);
  view.setUint16(54, PHENTSIZE, true);
  view.setUint16(56, 1, true);
  view.setUint32(PHOFF, PT_GNU_PROPERTY, true);
  view.setBigUint64(PHOFF + 8, BigInt(PROPERTY_OFFSET), true);
  view.setBigUint64(PHOFF + 32, BigInt(filesz), true);

  view.setUint32(PROPERTY_OFFSET, 4, true);
  view.setUint32(PROPERTY_OFFSET + 4, 16, true);
  view.setUint32(PROPERTY_OFFSET + 8, NT_GNU_PROPERTY_TYPE_0, true);
  bytes.set([0x47, 0x4e, 0x55, 0x00], PROPERTY_OFFSET + 12);
  view.setUint32(PROPERTY_OFFSET + 16, propertyType, true);
  view.setUint32(PROPERTY_OFFSET + 20, 4, true);
  view.setUint32(PROPERTY_OFFSET + 24, featureBits, true);
  return bytes;
}

test('#6166 exports the standard FEATURE_1_GCS bit', () => {
  assert.equal(GNU_PROPERTY_AARCH64_FEATURE_1_GCS, 1 << 2);
});

test('#6166 reports GCS-only and combined FEATURE_1 flags', () => {
  const gcs = parseAarch64GnuProperty(makeElf(GNU_PROPERTY_AARCH64_FEATURE_1_GCS));
  assert.equal(gcs.loaderPolicy, 'bti-not-requested');
  assert.equal(gcs.btiRequested, false);
  assert.equal(gcs.pacRequested, false);
  assert.equal(gcs.gcsRequested, true);
  assert.equal(gcs.featureBits, GNU_PROPERTY_AARCH64_FEATURE_1_GCS);
  assert.equal(gcs.evidence[0].featureBits, GNU_PROPERTY_AARCH64_FEATURE_1_GCS);

  const all = parseAarch64GnuProperty(makeElf(
    GNU_PROPERTY_AARCH64_FEATURE_1_BTI
      | GNU_PROPERTY_AARCH64_FEATURE_1_PAC
      | GNU_PROPERTY_AARCH64_FEATURE_1_GCS,
  ));
  assert.equal(all.btiRequested, true);
  assert.equal(all.pacRequested, true);
  assert.equal(all.gcsRequested, true);
  assert.equal(all.featureBits, 0x7);
});

test('#6166 preserves the fully-scanned absent-bit and unknown policies', () => {
  const recognizedZero = parseAarch64GnuProperty(makeElf(0));
  assert.equal(recognizedZero.loaderPolicy, 'bti-not-requested');
  assert.equal(recognizedZero.featureBits, 0);
  assert.equal(recognizedZero.btiRequested, false);
  assert.equal(recognizedZero.pacRequested, false);
  assert.equal(recognizedZero.gcsRequested, false);

  const absent = parseAarch64GnuProperty(makeElf(0, { propertyType: 0 }));
  assert.equal(absent.loaderPolicy, 'feature-bit-absent');
  assert.equal(absent.btiRequested, false);
  assert.equal(absent.pacRequested, false);
  assert.equal(absent.gcsRequested, false);

  const incomplete = parseAarch64GnuProperty(makeElf(GNU_PROPERTY_AARCH64_FEATURE_1_GCS, { filesz: 8 }));
  assert.equal(incomplete.loaderPolicy, 'unknown');
  assert.equal(incomplete.btiRequested, null);
  assert.equal(incomplete.pacRequested, null);
  assert.equal(incomplete.gcsRequested, null);

  const unavailable = parseAarch64GnuProperty(new Uint8Array(32));
  assert.equal(unavailable.loaderPolicy, 'unavailable');
  assert.equal(unavailable.gcsRequested, null);
});

test('#6166 publishes GCS through the public ELF loader consumer', () => {
  const image = parseELF(makeElf(GNU_PROPERTY_AARCH64_FEATURE_1_GCS));
  assert.equal(image.arch, 'arm64');
  assert.equal(image.metadata.arm64Bti.gcsRequested, true);
  assert.equal(image.metadata.arm64Bti.featureBits, GNU_PROPERTY_AARCH64_FEATURE_1_GCS);
});
