import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeRiscvIsaString,
  parseCanonicalRiscvElfIsa,
  parseRiscvAttributes,
  parseRiscvMappingSymbol,
  resolveRiscvIsaProfile,
} from '../../../js/binary/riscv-isa.js';

const CANONICAL = 'rv64i2p1_m2p0_a2p1_f2p2_d2p2_c2p0_zicsr2p0_zifencei2p0';

function u32le(value) {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

function uleb(n) {
  const out = [];
  do { let b = n & 0x7f; n = Math.floor(n / 128); if (n) b |= 0x80; out.push(b); } while (n);
  return out;
}

function attributesFor(arch) {
  const encoder = new TextEncoder();
  const archBytes = [...encoder.encode(arch), 0];
  const attributes = [...uleb(5), ...archBytes];
  const fileSubsection = [1, ...u32le(1 + 4 + attributes.length), ...attributes];
  const vendor = [...encoder.encode('riscv'), 0];
  const vendorSubsection = [...u32le(4 + vendor.length + fileSubsection.length), ...vendor, ...fileSubsection];
  return Uint8Array.from([0x41, ...vendorSubsection]);
}

function metadata({ file = null, mappings = [], sections = [{ start:0x1000n, end:0x3000n, sectionIndex:1 }] }) {
  return { file, mappings, sections, evidence:file ? 'elf-attribute' : 'missing' };
}

function fileEvidence(arch) {
  const profile = parseRiscvAttributes(attributesFor(arch));
  assert.ok(profile, `${arch} must remain an observable Tag_RISCV_arch interpretation`);
  return profile;
}

test('#4084 canonical versioned Tag_RISCV_arch keeps exact ELF evidence', () => {
  const result = resolveRiscvIsaProfile(metadata({ file:fileEvidence(CANONICAL) }), 0x1800n, { allowAssumed:false });
  assert.equal(result?.exact, true);
  assert.equal(result?.canonical, CANONICAL);
  assert.equal(result?.evidence, 'elf-attribute');
});

test('#4084 version-omitted Tag_RISCV_arch must not become exact evidence', () => {
  for (const arch of ['rv64gc', 'rv64imc', 'rv64i', 'rv32im_zce']) {
    const result = resolveRiscvIsaProfile(metadata({ file:fileEvidence(arch) }), 0x1800n, { allowAssumed:false });
    assert.equal(result?.exact, false, `${arch} must not be promoted to exact:true`);
    assert.equal(result?.canonical, arch, 'the observed ISA facts stay available as non-exact data');
  }
});

test('#4084 unexpanded g abbreviation is never canonical ELF identity', () => {
  assert.equal(parseCanonicalRiscvElfIsa('rv64gc'), null);
  assert.equal(parseCanonicalRiscvElfIsa('rv64g2p1_c2p0'), null);
  assert.equal(parseCanonicalRiscvElfIsa('rv32g'), null);
  assert.equal(parseCanonicalRiscvElfIsa(CANONICAL)?.canonical, CANONICAL);
});

test('#4084 canonical contract rejects ordering, separator, case and duplicate violations', () => {
  for (const isa of [
    'RV64I2P1_M2P0',
    'rv64i2p1__m2p0',
    'rv64i2p1_m2p0_',
    'rv64i2p1_c2p0_m2p0',
    'rv64i2p1_m2p0_m2p0',
    'rv64i2p1_zicsr2p0_b2p0',
    'rv64i2p1_x2p0',
    'rv64m2p0_i2p0',
    'rv64i2p1_m2p0 ',
    'rv64im2p0',
  ]) assert.equal(parseCanonicalRiscvElfIsa(isa), null, `${isa} must be rejected`);
  assert.equal(parseCanonicalRiscvElfIsa('rv64i2p1_m2p0_c2p0_zicsr2p0_zifencei2p0')?.instructionAlignment, 2);
  assert.equal(parseCanonicalRiscvElfIsa('rv32e2p1_m2p0')?.xlen, 32);
});

test('#4084 canonical $x<ISA> mapping symbol keeps exact mapping evidence', () => {
  const mapping = parseRiscvMappingSymbol('$xrv64i2p1_m2p0_c2p0');
  assert.equal(mapping?.isa?.canonical, 'rv64i2p1_m2p0_c2p0');
  const result = resolveRiscvIsaProfile(metadata({
    file:fileEvidence('rv64i2p1_m2p0'),
    mappings:[{ address:0x1000n, sectionIndex:1, kind:'instruction', isa:mapping.isa }],
  }), 0x1800n, { allowAssumed:false });
  assert.equal(result?.exact, true);
  assert.equal(result?.evidence, 'mapping-symbol');
  assert.equal(result?.canonical, 'rv64i2p1_m2p0_c2p0');
});

test('#4084 non-canonical mapping ISA cannot authorize itself and cannot override file canonical ISA', () => {
  const file = fileEvidence('rv64i2p1_m2p0');
  for (const name of ['$xrv64gc', '$xrv64imc', '$xrv64i']) {
    const mapping = parseRiscvMappingSymbol(name);
    assert.ok(mapping?.isa, `${name} stays an observable mapping interpretation`);
    const result = resolveRiscvIsaProfile(metadata({
      file,
      mappings:[{ address:0x1000n, sectionIndex:1, kind:'instruction', isa:mapping.isa }],
    }), 0x1800n, { allowAssumed:false });
    assert.notEqual(result?.evidence, 'mapping-symbol', `${name} must not become mapping evidence authority`);
    assert.equal(result?.canonical, 'rv64i2p1_m2p0', `${name} must not override the file-level canonical ISA`);
    assert.equal(result?.instructionAlignment, 4, `${name} must not override file-level IALIGN`);
    assert.equal(result?.exact, true, 'the canonical file evidence survives the malformed mapping');
  }
});

test('#4084 non-canonical mapping over a non-canonical file stays non-exact', () => {
  const mapping = parseRiscvMappingSymbol('$xrv64gc');
  const result = resolveRiscvIsaProfile(metadata({
    file:fileEvidence('rv64imc'),
    mappings:[{ address:0x1000n, sectionIndex:1, kind:'instruction', isa:mapping.isa }],
  }), 0x1800n, { allowAssumed:false });
  assert.equal(result?.exact, false);
});

test('#4084 hand-built non-canonical metadata cannot reach exact:true', () => {
  const result = resolveRiscvIsaProfile({
    file:{ canonical:'rv64imc', xlen:64, compressedInstructions:true, instructionAlignment:2, evidence:'elf-attribute' },
    mappings:[],
    sections:[],
  }, 0n, { allowAssumed:false });
  assert.equal(result?.exact, false);
  assert.equal(result?.instructionAlignment, 2);
});

test('#4084 permissive user-input interpretation stays independent of ELF strictness', () => {
  const permissive = normalizeRiscvIsaString(' rv64gc ');
  assert.equal(permissive?.canonical, 'rv64gc');
  assert.equal(permissive?.compressedInstructions, true);
  assert.equal(permissive?.instructionAlignment, 2);
  assert.equal(parseCanonicalRiscvElfIsa('rv64gc'), null);
  assert.equal(parseCanonicalRiscvElfIsa(null), null);
  assert.equal(parseCanonicalRiscvElfIsa(42), null);
});
