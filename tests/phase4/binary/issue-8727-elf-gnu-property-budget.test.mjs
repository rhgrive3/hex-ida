import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GNU_PROPERTY_AARCH64_FEATURE_1_AND,
  GNU_PROPERTY_AARCH64_FEATURE_1_BTI,
  GNU_PROPERTY_AARCH64_FEATURE_1_PAC,
  NT_GNU_PROPERTY_TYPE_0,
  PT_GNU_PROPERTY,
  parseAarch64GnuProperty,
} from '../../../js/binary/elf-gnu-property.js';
import { parseELF } from '../../../js/binary/elf-loader.js';

const PHOFF = 0x40;
const PHENTSIZE = 56;

function putU32(view, offset, value) {
  view.setUint32(offset, value >>> 0, true);
}

function putU64(view, offset, value) {
  view.setBigUint64(offset, BigInt(value), true);
}

function writeFeatureNote(view, bytes, offset, featureBits) {
  putU32(view, offset, 4);
  putU32(view, offset + 4, 16);
  putU32(view, offset + 8, NT_GNU_PROPERTY_TYPE_0);
  bytes.set([0x47, 0x4e, 0x55, 0x00], offset + 12);
  putU32(view, offset + 16, GNU_PROPERTY_AARCH64_FEATURE_1_AND);
  putU32(view, offset + 20, 4);
  putU32(view, offset + 24, featureBits);
}

function makeElf(programHeaders, notes) {
  const end = Math.max(
    PHOFF + programHeaders.length * PHENTSIZE,
    ...notes.map(({ offset, count = 1 }) => offset + count * 32),
  );
  const bytes = new Uint8Array(end);
  const view = new DataView(bytes.buffer);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0);
  putU32(view, 16, 2);
  view.setUint16(18, 183, true);
  putU32(view, 20, 1);
  putU64(view, 32, PHOFF);
  view.setUint16(52, 64, true);
  view.setUint16(54, PHENTSIZE, true);
  view.setUint16(56, programHeaders.length, true);
  for (let index = 0; index < programHeaders.length; index++) {
    const header = programHeaders[index];
    const offset = PHOFF + index * PHENTSIZE;
    putU32(view, offset, PT_GNU_PROPERTY);
    putU64(view, offset + 8, header.offset);
    putU64(view, offset + 32, header.filesz);
    putU64(view, offset + 48, 8);
  }
  for (const { offset, featureBits, count = 1 } of notes) {
    for (let index = 0; index < count; index++) {
      writeFeatureNote(view, bytes, offset + index * 32, featureBits);
    }
  }
  return bytes;
}

test('#8727 bounds the exact repeated-span public ELF counterexample', () => {
  const programHeaderCount = 1536;
  const noteCount = 4096;
  const propertyOffset = PHOFF + programHeaderCount * PHENTSIZE;
  const propertyBytes = noteCount * 32;
  const bytes = makeElf(
    Array.from({ length: programHeaderCount }, () => ({
      offset: propertyOffset,
      filesz: propertyBytes,
    })),
    [{ offset: propertyOffset, count: noteCount, featureBits: GNU_PROPERTY_AARCH64_FEATURE_1_BTI }],
  );

  assert.equal(bytes.length, 217152);
  const image = parseELF(bytes);
  const property = image.metadata.arm64Bti;

  assert.equal(property.loaderPolicy, 'bti-requested');
  assert.equal(property.btiRequested, true);
  assert.equal(property.evidence.length, noteCount);
  assert.ok(property.evidence.length < 1_000_000, 'aliased headers must not retain millions of records');
  assert.equal(property.budget.uniqueSpans, 1);
  assert.equal(property.budget.duplicateSpanHeaders, programHeaderCount - 1);
  assert.equal(property.budget.aggregatePropertyBytes, propertyBytes);
  assert.ok(property.budget.propertyOperations <= property.budget.maxPropertyOperations);
  assert.ok(property.budget.propertyEntries <= property.budget.maxPropertyEntries);
  assert.equal(property.budget.evidenceRecords, property.evidence.length);
  assert.equal(property.budget.exhausted, false);
  assert.equal(property.warnings.some((warning) => warning.includes('budget exhausted')), false);
});

test('#8727 preserves distinct FEATURE_1_AND semantics', () => {
  const first = 0x100;
  const second = first + 32;
  const result = parseAarch64GnuProperty(
    makeElf(
      [
        { offset: first, filesz: 32 },
        { offset: second, filesz: 32 },
      ],
      [
        { offset: first, featureBits: GNU_PROPERTY_AARCH64_FEATURE_1_BTI | GNU_PROPERTY_AARCH64_FEATURE_1_PAC },
        { offset: second, featureBits: GNU_PROPERTY_AARCH64_FEATURE_1_BTI },
      ],
    ),
  );

  assert.equal(result.loaderPolicy, 'bti-requested');
  assert.equal(result.featureBits, GNU_PROPERTY_AARCH64_FEATURE_1_BTI);
  assert.equal(result.btiRequested, true);
  assert.equal(result.pacRequested, false);
  assert.deepEqual(result.evidence.map((item) => item.fileOffset), [first + 16, second + 16]);
  assert.equal(result.budget.uniqueSpans, 2);
  assert.equal(result.budget.duplicateSpanHeaders, 0);
});

test('#8727 fails closed with deterministic evidence-budget state', () => {
  const result = parseAarch64GnuProperty(
    makeElf(
      [{ offset: 0x100, filesz: 64 }],
      [{ offset: 0x100, count: 2, featureBits: GNU_PROPERTY_AARCH64_FEATURE_1_BTI }],
    ),
    { maxEvidenceRecords: 1 },
  );

  assert.equal(result.loaderPolicy, 'unknown');
  assert.equal(result.btiRequested, null);
  assert.equal(result.pacRequested, null);
  assert.equal(result.gcsRequested, null);
  assert.equal(result.evidence.length, 1);
  assert.equal(result.budget.exhausted, true);
  assert.equal(result.budget.exhaustedReason, 'evidence-records');
  assert.equal(result.warnings.at(-1), 'GNU property parser budget exhausted: evidence-records');
});

test('#8727 admits aggregate span bytes before scanning a new span', () => {
  const result = parseAarch64GnuProperty(
    makeElf(
      [
        { offset: 0x100, filesz: 32 },
        { offset: 0x120, filesz: 32 },
      ],
      [
        { offset: 0x100, featureBits: GNU_PROPERTY_AARCH64_FEATURE_1_BTI },
        { offset: 0x120, featureBits: GNU_PROPERTY_AARCH64_FEATURE_1_PAC },
      ],
    ),
    { maxAggregatePropertyBytes: 32 },
  );

  assert.equal(result.loaderPolicy, 'unknown');
  assert.equal(result.btiRequested, null);
  assert.equal(result.pacRequested, null);
  assert.equal(result.budget.uniqueSpans, 1);
  assert.equal(result.budget.aggregatePropertyBytes, 32);
  assert.equal(result.budget.exhaustedReason, 'aggregate-property-bytes');
  assert.equal(result.evidence.length, 1);
  assert.equal(result.warnings.at(-1), 'GNU property parser budget exhausted: aggregate-property-bytes');
});

console.log('issue #8727 ELF/AArch64 GNU property resource-budget regressions: PASS');
