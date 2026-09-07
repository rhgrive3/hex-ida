import assert from 'node:assert/strict';
import {
  GNU_PROPERTY_AARCH64_FEATURE_1_AND,
  GNU_PROPERTY_AARCH64_FEATURE_1_BTI,
  NT_GNU_PROPERTY_TYPE_0,
  PT_GNU_PROPERTY,
  parseAarch64GnuProperty,
} from '../../js/binary/elf-gnu-property.js';

const ELF_SIZE = 0x300;
const PHOFF = 0x40;
const PHENTSIZE = 56;
const PROPERTY_OFFSET = 0x100;

function putU16(view, offset, value) {
  view.setUint16(offset, value, true);
}

function putU32(view, offset, value) {
  view.setUint32(offset, value >>> 0, true);
}

function putU64(view, offset, value) {
  view.setBigUint64(offset, BigInt(value), true);
}

function makeElf(programHeaders) {
  const bytes = new Uint8Array(ELF_SIZE);
  const view = new DataView(bytes.buffer);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 0);
  putU16(view, 18, 183);
  putU64(view, 32, PHOFF);
  putU16(view, 54, PHENTSIZE);
  putU16(view, 56, programHeaders.length);
  for (let index = 0; index < programHeaders.length; index++) {
    const ph = programHeaders[index];
    const offset = PHOFF + index * PHENTSIZE;
    putU32(view, offset, ph.type ?? PT_GNU_PROPERTY);
    putU64(view, offset + 8, ph.offset ?? PROPERTY_OFFSET);
    putU64(view, offset + 32, ph.filesz ?? 0);
  }
  return { bytes, view };
}

function writePropertyNote(view, bytes, {
  offset = PROPERTY_OFFSET,
  descsz = 16,
  propertyType = GNU_PROPERTY_AARCH64_FEATURE_1_AND,
  dataSize = 4,
  value = GNU_PROPERTY_AARCH64_FEATURE_1_BTI,
} = {}) {
  putU32(view, offset, 4);
  putU32(view, offset + 4, descsz);
  putU32(view, offset + 8, NT_GNU_PROPERTY_TYPE_0);
  bytes.set([0x47, 0x4e, 0x55, 0x00], offset + 12);
  putU32(view, offset + 16, propertyType);
  putU32(view, offset + 20, dataSize);
  if (dataSize >= 4) putU32(view, offset + 24, value);
}

function resultTuple(result) {
  return [result.loaderPolicy, result.btiRequested, result.pacRequested];
}

{
  const { bytes } = makeElf([{ type:1, filesz:0 }]);
  assert.deepEqual(resultTuple(parseAarch64GnuProperty(bytes)), [
    'feature-bit-absent', false, false,
  ]);
}

{
  const { bytes, view } = makeElf([{ filesz:32 }]);
  writePropertyNote(view, bytes);
  const result = parseAarch64GnuProperty(bytes);
  assert.deepEqual(resultTuple(result), ['bti-requested', true, false]);
  assert.equal(result.featureBits, GNU_PROPERTY_AARCH64_FEATURE_1_BTI);
}

{
  const { bytes, view } = makeElf([{ filesz:32 }]);
  writePropertyNote(view, bytes, { propertyType:0xc0000002 });
  assert.deepEqual(resultTuple(parseAarch64GnuProperty(bytes)), [
    'feature-bit-absent', false, false,
  ]);
}

{
  const { bytes } = makeElf([{ filesz:(1024 * 1024) + 1 }]);
  const result = parseAarch64GnuProperty(bytes);
  assert.deepEqual(resultTuple(result), ['unknown', null, null]);
  assert.match(result.warnings[0], /outside bounded input/);
}

{
  const { bytes } = makeElf([{ filesz:8 }]);
  const result = parseAarch64GnuProperty(bytes);
  assert.deepEqual(resultTuple(result), ['unknown', null, null]);
  assert.match(result.warnings[0], /truncated GNU property note header/);
}

{
  const { bytes, view } = makeElf([{ filesz:20 }]);
  putU32(view, PROPERTY_OFFSET, 0xfffffff0);
  putU32(view, PROPERTY_OFFSET + 4, 0);
  putU32(view, PROPERTY_OFFSET + 8, NT_GNU_PROPERTY_TYPE_0);
  const result = parseAarch64GnuProperty(bytes);
  assert.deepEqual(resultTuple(result), ['unknown', null, null]);
  assert.match(result.warnings[0], /malformed GNU property note/);
}

{
  const { bytes, view } = makeElf([{ filesz:32 }]);
  writePropertyNote(view, bytes, { dataSize:8 });
  const result = parseAarch64GnuProperty(bytes);
  assert.deepEqual(resultTuple(result), ['unknown', null, null]);
  assert.match(result.warnings[0], /FEATURE_1_AND size 8/);
}

{
  const { bytes, view } = makeElf([{ filesz:36 }]);
  writePropertyNote(view, bytes, { descsz:17 });
  const result = parseAarch64GnuProperty(bytes);
  assert.deepEqual(resultTuple(result), ['unknown', null, null]);
}

{
  const { bytes, view } = makeElf([
    { filesz:32 },
    { offset:0x180, filesz:(1024 * 1024) + 1 },
  ]);
  writePropertyNote(view, bytes);
  const result = parseAarch64GnuProperty(bytes);
  assert.deepEqual(resultTuple(result), ['unknown', null, null]);
  assert.equal(result.featureBits, GNU_PROPERTY_AARCH64_FEATURE_1_BTI);
  assert.equal(result.evidence.length, 1);
}

console.log('issue-3730-elf-gnu-property-incomplete: PASS');
