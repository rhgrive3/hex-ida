import assert from 'node:assert/strict';
import { parseAarch64GnuProperty, attachAarch64GnuPropertyEvidence } from '../../../js/binary/elf-gnu-property.js';

// Issue #4349: parseAarch64GnuProperty() never read the PT_GNU_PROPERTY
// program header's p_align, so an ELF64 property segment whose alignment
// violates the loader contract (ELF64_GNU_PROPERTY_ALIGN=8, ELF32=4) was
// still parsed and its FEATURE_1_BTI bit reported as `bti-requested`.
// glibc's _dl_process_pt_gnu_property skips notes with any other p_align,
// so the parser must not mint BTI/PAC evidence from a nonconforming segment.

const PT_GNU_PROPERTY = 0x6474e553;
const NT_GNU_PROPERTY_TYPE_0 = 5;
const FEATURE_1_AND = 0xc0000000;
const FEATURE_1_BTI = 1;
const FEATURE_1_PAC = 2;

function makeElf({ bits = 64, pAlign = 8, featureBits = FEATURE_1_BTI } = {}) {
  const noteOffset = 120;
  const descSize = bits === 64 ? 16 : 12;
  const noteSize = 12 + 4 + descSize;
  const bytes = new Uint8Array(noteOffset + noteSize);
  const view = new DataView(bytes.buffer);
  const u32 = (o, x) => view.setUint32(o, x >>> 0, true);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, bits === 64 ? 2 : 1, 1, 1, 0], 0);
  view.setUint16(16, 2, true);
  view.setUint16(18, 183, true); // EM_AARCH64
  view.setUint32(20, 1, true);
  const ph = bits === 64 ? 64 : 52;
  const phentsize = bits === 64 ? 56 : 32;
  if (bits === 64) {
    view.setBigUint64(32, BigInt(ph), true);
    view.setUint16(54, phentsize, true);
    view.setUint16(56, 1, true);
    u32(ph, PT_GNU_PROPERTY);
    view.setBigUint64(ph + 8, BigInt(noteOffset), true);
    view.setBigUint64(ph + 32, BigInt(noteSize), true);
    view.setBigUint64(ph + 48, BigInt(pAlign), true);
  } else {
    view.setUint32(28, ph, true);
    view.setUint16(42, phentsize, true);
    view.setUint16(44, 1, true);
    u32(ph, PT_GNU_PROPERTY);
    u32(ph + 4, noteOffset);
    u32(ph + 16, noteSize);
    u32(ph + 28, pAlign);
  }
  u32(noteOffset, 4); // namesz ("GNU\0")
  u32(noteOffset + 4, descSize);
  u32(noteOffset + 8, NT_GNU_PROPERTY_TYPE_0);
  bytes.set([0x47, 0x4e, 0x55, 0x00], noteOffset + 12);
  u32(noteOffset + 16, FEATURE_1_AND);
  u32(noteOffset + 20, 4);
  u32(noteOffset + 24, featureBits);
  return bytes;
}

function parse(bytes) {
  return parseAarch64GnuProperty(bytes);
}

// The loader contract gate is what the issue's minimal counterexample pins:
// ELF64 with p_align=4 must not report a BTI request.
{
  const result = parse(makeElf({ pAlign: 4 }));
  assert.equal(result.loaderPolicy, 'unknown');
  assert.equal(result.btiRequested, null);
  assert.equal(result.pacRequested, null);
  assert.equal(result.featureBits, undefined);
  assert.deepEqual(result.evidence, []);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /p_align 4 does not satisfy the 64-bit GNU property alignment 8/);
}

// Conforming ELF64 segment still parses exactly as before.
{
  const result = parse(makeElf({ pAlign: 8 }));
  assert.equal(result.loaderPolicy, 'bti-requested');
  assert.equal(result.btiRequested, true);
  assert.equal(result.featureBits, FEATURE_1_BTI);
  assert.equal(result.evidence.length, 1);
  assert.deepEqual(result.warnings, []);
}

// glibc requires exact equality, not a minimum: p_align=16 is skipped too.
{
  const result = parse(makeElf({ pAlign: 16 }));
  assert.equal(result.loaderPolicy, 'unknown');
  assert.equal(result.btiRequested, null);
  assert.match(result.warnings[0], /p_align 16 does not satisfy the 64-bit GNU property alignment 8/);
}

// ELF32 adopts at 4 and rejects at 8.
{
  const conforming = parse(makeElf({ bits: 32, pAlign: 4 }));
  assert.equal(conforming.loaderPolicy, 'bti-requested');
  assert.equal(conforming.btiRequested, true);

  const nonconforming = parse(makeElf({ bits: 32, pAlign: 8 }));
  assert.equal(nonconforming.loaderPolicy, 'unknown');
  assert.equal(nonconforming.btiRequested, null);
  assert.match(nonconforming.warnings[0], /p_align 8 does not satisfy the 32-bit GNU property alignment 4/);
}

// A conforming segment keeps its evidence even when another segment is
// nonconforming; the nonconforming one contributes nothing.
{
  const bytes = new Uint8Array(0x300);
  const view = new DataView(bytes.buffer);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0);
  view.setUint16(16, 2, true);
  view.setUint16(18, 183, true);
  view.setBigUint64(32, 64n, true);
  view.setUint16(54, 56, true);
  view.setUint16(56, 2, true);
  const buildSegment = (index, pAlign, featureBits) => {
    const noteOffset = 0x100 + index * 0x40;
    const ph = 64 + index * 56;
    view.setUint32(ph, PT_GNU_PROPERTY, true);
    view.setBigUint64(ph + 8, BigInt(noteOffset), true);
    view.setBigUint64(ph + 32, 32n, true);
    view.setBigUint64(ph + 48, BigInt(pAlign), true);
    view.setUint32(noteOffset, 4, true);
    view.setUint32(noteOffset + 4, 16, true);
    view.setUint32(noteOffset + 8, NT_GNU_PROPERTY_TYPE_0, true);
    bytes.set([0x47, 0x4e, 0x55, 0x00], noteOffset + 12);
    view.setUint32(noteOffset + 16, FEATURE_1_AND, true);
    view.setUint32(noteOffset + 20, 4, true);
    view.setUint32(noteOffset + 24, featureBits, true);
  };
  buildSegment(0, 8, FEATURE_1_BTI);
  buildSegment(1, 4, FEATURE_1_PAC);
  const result = parse(bytes);
  assert.equal(result.loaderPolicy, 'bti-requested');
  assert.equal(result.btiRequested, true);
  assert.equal(result.pacRequested, false, 'nonconforming segment PAC evidence is not merged');
  assert.equal(result.evidence.length, 1);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /PT_GNU_PROPERTY 1 is ignored/);
}

// The published image metadata must carry the same fail-closed policy.
{
  const image = attachAarch64GnuPropertyEvidence(
    { format: 'elf', arch: 'arm64', metadata: {}, warnings: [] },
    makeElf({ pAlign: 4 }),
    {},
  );
  assert.equal(image.metadata.arm64Bti.loaderPolicy, 'unknown');
  assert.equal(image.metadata.arm64Bti.btiRequested, null);
  assert.match(image.warnings[0], /AArch64 GNU property: PT_GNU_PROPERTY 0 is ignored/);
}

console.log('issue #4349 GNU property p_align loader contract regression: PASS');
