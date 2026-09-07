import assert from 'node:assert/strict';
import {
  GNU_PROPERTY_AARCH64_FEATURE_1_AND,
  GNU_PROPERTY_AARCH64_FEATURE_1_BTI,
  GNU_PROPERTY_AARCH64_FEATURE_1_GCS,
  GNU_PROPERTY_AARCH64_FEATURE_1_PAC,
  NT_GNU_PROPERTY_TYPE_0,
  PT_GNU_PROPERTY,
  parseAarch64GnuProperty,
} from '../../js/binary/elf-gnu-property.js';

const ELF_SIZE = 0x300;
const PHOFF = 0x40;
const PHENTSIZE = 56;
const PROPERTY_OFFSET = 0x100;

function makeElf() {
  const bytes = new Uint8Array(ELF_SIZE);
  const view = new DataView(bytes.buffer);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 0);
  view.setUint16(18, 183, true);
  view.setBigUint64(32, BigInt(PHOFF), true);
  view.setUint16(54, PHENTSIZE, true);
  view.setUint16(56, 1, true);
  view.setUint32(PHOFF, PT_GNU_PROPERTY, true);
  view.setBigUint64(PHOFF + 8, BigInt(PROPERTY_OFFSET), true);
  view.setBigUint64(PHOFF + 32, 32n, true);
  return { bytes, view };
}

function writeFeatureProperty(view, bytes, value) {
  view.setUint32(PROPERTY_OFFSET, 4, true);
  view.setUint32(PROPERTY_OFFSET + 4, 16, true);
  view.setUint32(PROPERTY_OFFSET + 8, NT_GNU_PROPERTY_TYPE_0, true);
  bytes.set([0x47, 0x4e, 0x55, 0x00], PROPERTY_OFFSET + 12);
  view.setUint32(PROPERTY_OFFSET + 16, GNU_PROPERTY_AARCH64_FEATURE_1_AND, true);
  view.setUint32(PROPERTY_OFFSET + 20, 4, true);
  view.setUint32(PROPERTY_OFFSET + 24, value, true);
}

{
  assert.equal(GNU_PROPERTY_AARCH64_FEATURE_1_GCS, 1 << 2);
}

{
  const { bytes, view } = makeElf();
  writeFeatureProperty(view, bytes, GNU_PROPERTY_AARCH64_FEATURE_1_GCS);
  const result = parseAarch64GnuProperty(bytes);
  assert.equal(result.loaderPolicy, 'bti-not-requested');
  assert.equal(result.btiRequested, false);
  assert.equal(result.pacRequested, false);
  assert.equal(result.gcsRequested, true);
  assert.equal(result.featureBits, GNU_PROPERTY_AARCH64_FEATURE_1_GCS);
}

{
  const { bytes, view } = makeElf();
  writeFeatureProperty(view, bytes, GNU_PROPERTY_AARCH64_FEATURE_1_BTI | GNU_PROPERTY_AARCH64_FEATURE_1_PAC | GNU_PROPERTY_AARCH64_FEATURE_1_GCS);
  const result = parseAarch64GnuProperty(bytes);
  assert.equal(result.loaderPolicy, 'bti-requested');
  assert.equal(result.btiRequested, true);
  assert.equal(result.pacRequested, true);
  assert.equal(result.gcsRequested, true);
  assert.equal(result.featureBits, GNU_PROPERTY_AARCH64_FEATURE_1_BTI | GNU_PROPERTY_AARCH64_FEATURE_1_PAC | GNU_PROPERTY_AARCH64_FEATURE_1_GCS);
}

{
  const { bytes, view } = makeElf();
  writeFeatureProperty(view, bytes, GNU_PROPERTY_AARCH64_FEATURE_1_BTI);
  const result = parseAarch64GnuProperty(bytes);
  assert.equal(result.gcsRequested, false);
}

{
  const { bytes, view } = makeElf();
  writeFeatureProperty(view, bytes, 0);
  const result = parseAarch64GnuProperty(bytes);
  assert.equal(result.loaderPolicy, 'bti-not-requested');
  assert.equal(result.gcsRequested, false);
}

{
  const truncated = parseAarch64GnuProperty(new Uint8Array(32));
  assert.equal(truncated.loaderPolicy, 'unavailable');
  assert.equal(truncated.gcsRequested, null);
}
{
  const notElf = parseAarch64GnuProperty(new Uint8Array(128));
  assert.equal(notElf.loaderPolicy, 'not-elf');
  assert.equal(notElf.gcsRequested, null);
}
console.log('issue-6166-elf-gnu-property-gcs: PASS');