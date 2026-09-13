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

function expectProfile(isa, compressed) {
  const profile = normalizeRiscvIsaString(isa);
  assert.ok(profile, `${isa} should parse`);
  assert.equal(profile.compressedInstructions, compressed, `${isa} compressed-instructions expectation`);
  assert.equal(profile.instructionAlignment, compressed ? 2 : 4, `${isa} IALIGN expectation`);
  return profile;
}

test('#4170 versioned single-letter concatenation detects the C extension per the ISA naming spec', () => {
  expectProfile('rv64imac', true);
  expectProfile('rv64i2p0m2p0a2p1c2p0', true);
  expectProfile('rv64i2p0m2p0a2p1f2p2d2p2c2p0', true);
  expectProfile('rv64i2_m2_a2_c2', true);
});

test('#4170 versioned single-letter concatenation without C stays uncompressed and never borrows a c from multi-letter extensions', () => {
  expectProfile('rv64i2p0m2p0a2p1', false);
  expectProfile('rv64i2p0_zicsr2p0', false);
  expectProfile('rv64i2p0zicsr2p0', false);
  expectProfile('rv64i2p1', false);
  expectProfile('rv64g2p0', false);
});

test('#4170 existing single-letter and abbreviated forms keep their semantics', () => {
  expectProfile('rv64gc', true);
  expectProfile('rv64g2p0c2p0', true);
  expectProfile('rv32imc', true);
  expectProfile('rv64im', false);
  expectProfile('rv64im_zicsr', false);
});

test('#4170 versioned concatenation propagates through ELF attributes and mapping-symbol evidence', () => {
  const arch = 'rv64i2p0m2p0a2p1f2p2d2p2c2p0';
  const file = parseRiscvAttributes(attributesFor(arch));
  assert.ok(file);
  assert.equal(file.canonical, arch);
  assert.equal(file.compressedInstructions, true);
  assert.equal(file.instructionAlignment, 2);
  assert.equal(file.evidence, 'elf-attribute');

  const mapping = parseRiscvMappingSymbol(`$x${arch}.8`);
  assert.ok(mapping?.isa);
  assert.equal(mapping.isa.canonical, arch);
  assert.equal(mapping.isa.compressedInstructions, true);
  assert.equal(mapping.isa.instructionAlignment, 2);
  assert.equal(mapping.isa.evidence, 'mapping-symbol');
});
