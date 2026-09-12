import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeRiscvIsaString,
  parseRiscvAttributes,
  parseRiscvMappingSymbol,
} from '../../../js/binary/riscv-isa.js';

function u32le(value) {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

function attributesFor(arch) {
  const encoder = new TextEncoder();
  const archBytes = [...encoder.encode(arch), 0];
  const attributes = [5, ...archBytes];
  const fileSubsection = [1, ...u32le(1 + 4 + attributes.length), ...attributes];
  const vendor = [...encoder.encode('riscv'), 0];
  const vendorSubsection = [...u32le(4 + vendor.length + fileSubsection.length), ...vendor, ...fileSubsection];
  return Uint8Array.from([0x41, ...vendorSubsection]);
}

function expectCompressed(isa) {
  const profile = normalizeRiscvIsaString(isa);
  assert.ok(profile, `${isa} should parse`);
  assert.equal(profile.compressedInstructions, true, `${isa} should carry compressed-instruction capability`);
  assert.equal(profile.instructionAlignment, 2, `${isa} should imply IALIGN=16`);
}

test('#4077 Zce implies Zca compressed-instruction capability for RV32/RV64 and versioned tokens', () => {
  for (const isa of ['rv32im_zce', 'rv64im_zce', 'rv64i2p1_m2p0_zce1p0']) expectCompressed(isa);
});

test('#4077 existing direct C/Zca controls remain compressed while unrelated Z extensions do not', () => {
  for (const isa of ['rv32imc', 'rv32im_zca']) expectCompressed(isa);
  for (const isa of ['rv64im', 'rv64im_zicsr']) {
    const profile = normalizeRiscvIsaString(isa);
    assert.ok(profile, `${isa} should parse`);
    assert.equal(profile.compressedInstructions, false);
    assert.equal(profile.instructionAlignment, 4);
  }
});

test('#4077 Zce implication propagates through ELF attributes and mapping-symbol evidence', () => {
  const file = parseRiscvAttributes(attributesFor('rv32im_zce'));
  assert.ok(file);
  assert.equal(file.canonical, 'rv32im_zce');
  assert.equal(file.compressedInstructions, true);
  assert.equal(file.instructionAlignment, 2);
  assert.equal(file.evidence, 'elf-attribute');

  const mapping = parseRiscvMappingSymbol('$xrv64im_zce');
  assert.ok(mapping?.isa);
  assert.equal(mapping.isa.canonical, 'rv64im_zce');
  assert.equal(mapping.isa.compressedInstructions, true);
  assert.equal(mapping.isa.instructionAlignment, 2);
  assert.equal(mapping.isa.evidence, 'mapping-symbol');
});
