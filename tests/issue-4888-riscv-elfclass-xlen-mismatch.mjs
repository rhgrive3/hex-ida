import assert from 'node:assert/strict';
import { parseELF } from '../js/binary/elf-core.js';
import { resolveRiscvIsaProfile } from '../js/binary/riscv-isa.js';

// Issue #4888: an ELFCLASS64 RISC-V ELF whose `.riscv.attributes` (or a
// `$xrv32...` mapping symbol) declares an rv32 XLEN must not launder that
// attribute into an `exact:true` ISA profile that contradicts image.bits.

function uleb(n) {
  const out = [];
  do { let b = n & 0x7f; n = Math.floor(n / 128); if (n) b |= 0x80; out.push(b); } while (n);
  return out;
}
function u32le(n) { return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]; }
function ntbs(s) { return [...Buffer.from(s, 'utf8'), 0]; }

function attrPayload(arch) {
  const attrBytes = [...uleb(5), ...ntbs(arch)];
  const tagBytes = uleb(1);
  const subsub = [...tagBytes, ...u32le(tagBytes.length + 4 + attrBytes.length), ...attrBytes];
  const vendor = ntbs('riscv');
  return Uint8Array.from([0x41, ...u32le(4 + vendor.length + subsub.length), ...vendor, ...subsub]);
}

function stringTable(names) {
  const bytes = new Uint8Array(names.reduce((sum, name) => sum + Buffer.byteLength(name, 'utf8') + 1, 1));
  bytes[0] = 0;
  const offsets = [];
  let cursor = 1;
  for (const name of names) {
    offsets.push(cursor);
    bytes.set(Buffer.from(name, 'utf8'), cursor);
    cursor += Buffer.byteLength(name, 'utf8') + 1;
  }
  return { bytes, offsets };
}

function buildElf({ arch = null, mappingNames = [] }) {
  const attr = arch === null ? null : attrPayload(arch);
  const textContent = new Uint8Array(16);
  const symCount = mappingNames.length + 1;
  const strtab = stringTable(['', ...mappingNames]);

  let cursor = 64;
  const attrOff = cursor; if (attr) cursor += attr.length;
  const textOff = cursor; cursor += textContent.length;
  const symOff = cursor; cursor += symCount * 24;
  const strOff = cursor; cursor += strtab.bytes.length;
  const shstrOff = cursor;

  const sections = [{ name: '', type: 0, flags: 0n, off: 0, size: 0, link: 0, info: 0, entsize: 0n, addralign: 0n }];
  if (attr) sections.push({ name: '.riscv.attributes', type: 0x70000003, flags: 0n, off: attrOff, size: attr.length, link: 0, info: 0, entsize: 0n, addralign: 0n });
  sections.push({ name: '.text', type: 1, flags: 6n, off: textOff, size: textContent.length, link: 0, info: 0, entsize: 0n, addralign: 4n });
  if (mappingNames.length) sections.push({ name: '.symtab', type: 2, flags: 0n, off: symOff, size: symCount * 24, link: 0, info: 0, entsize: 24n, addralign: 8n });
  const strtabIndex = sections.push({ name: '.strtab', type: 3, flags: 0n, off: strOff, size: strtab.bytes.length, link: 0, info: 0, entsize: 0n, addralign: 1n }) - 1;
  if (mappingNames.length) sections[strtabIndex - 1].link = strtabIndex;
  const shstrtab = stringTable(['', ...sections.slice(1).map((s) => s.name), '.shstrtab']);
  cursor += shstrtab.bytes.length;
  const shOff = (cursor + 7) & ~7;
  sections.push({ name: '.shstrtab', type: 3, flags: 0n, off: shstrOff, size: shstrtab.bytes.length, link: 0, info: 0, entsize: 0n, addralign: 1n });
  const textIndex = 1 + (attr ? 1 : 0);

  const total = shOff + sections.length * 64;
  const buf = new Uint8Array(total);
  const dv = new DataView(buf.buffer);
  buf.set(attr || [], attrOff);
  buf.set(textContent, textOff);
  buf.set(strtab.bytes, strOff);
  buf.set(shstrtab.bytes, shstrOff);
  mappingNames.forEach((name, i) => {
    const p = symOff + (i + 1) * 24;
    dv.setUint32(p, strtab.offsets[i + 1], true);
    dv.setUint8(p + 4, 0);
    dv.setUint8(p + 5, 0);
    dv.setUint16(p + 6, textIndex, true);
    dv.setBigUint64(p + 8, 4n, true);
    dv.setBigUint64(p + 16, 0n, true);
  });

  buf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0], 0);
  dv.setUint16(16, 1, true);
  dv.setUint16(18, 243, true);
  dv.setUint32(20, 1, true);
  dv.setBigUint64(24, 0n, true);
  dv.setBigUint64(32, 0n, true);
  dv.setBigUint64(40, BigInt(shOff), true);
  dv.setUint16(52, 64, true);
  dv.setUint16(58, 64, true);
  dv.setUint16(60, sections.length, true);
  dv.setUint16(62, sections.length - 1, true);
  sections.forEach((s, i) => {
    const o = shOff + i * 64;
    dv.setUint32(o, shstrtab.offsets[i], true);
    dv.setUint32(o + 4, s.type, true);
    dv.setBigUint64(o + 8, s.flags, true);
    dv.setBigUint64(o + 16, 0n, true);
    dv.setBigUint64(o + 24, BigInt(s.off), true);
    dv.setBigUint64(o + 32, BigInt(s.size), true);
    dv.setUint32(o + 40, s.link, true);
    dv.setUint32(o + 44, s.info, true);
    dv.setBigUint64(o + 48, s.addralign, true);
    dv.setBigUint64(o + 56, s.entsize, true);
  });
  return { buf };
}

// 1. ELFCLASS64 + rv64i2p1 keeps its exact profile.
{
  const { buf } = buildElf({ arch: 'rv64i2p1' });
  const image = parseELF(buf);
  assert.equal(image.arch, 'riscv64');
  assert.equal(image.bits, 64);
  assert.equal(image.metadata.riscvIsa.file.xlen, 64);
  assert.equal(image.metadata.riscvIsa.evidence, 'elf-attribute');
  const profile = resolveRiscvIsaProfile(image.metadata.riscvIsa, 0x1000n);
  assert.equal(profile.canonical, 'rv64i2p1');
  assert.equal(profile.xlen, 64);
  assert.equal(profile.exact, true);
}

// 2. ELFCLASS64 + multi-token rv64 string behaves as before.
{
  const { buf } = buildElf({ arch: 'rv64i2p1_m2p0' });
  const image = parseELF(buf);
  const profile = resolveRiscvIsaProfile(image.metadata.riscvIsa, 0x1000n);
  assert.equal(profile.canonical, 'rv64i2p1_m2p0');
  assert.equal(profile.instructionAlignment, 4);
  assert.equal(profile.exact, true);
}

// 3. ELFCLASS64 + rv32i2p1: diagnostic and no exact evidence laundering.
{
  const { buf } = buildElf({ arch: 'rv32i2p1' });
  const image = parseELF(buf);
  assert.equal(image.arch, 'riscv64');
  assert.ok(image.warnings.some((w) => /XLEN 32 disagrees with ELFCLASS64/.test(w)),
    `expected a disagreement diagnostic, got: ${JSON.stringify(image.warnings)}`);
  assert.equal(image.metadata.riscvIsa.file, null);
  assert.notEqual(image.metadata.riscvIsa.evidence, 'elf-attribute');
  const profile = resolveRiscvIsaProfile(image.metadata.riscvIsa, 0x1000n);
  assert.notEqual(profile.xlen, 32, 'rv32 attribute must never yield an xlen:32 profile for ELFCLASS64');
  assert.notEqual(profile.exact, true, 'rv32 attribute must not be promoted to exact:true');
}

// 4. Malformed Tag_RISCV_arch keeps the existing missing/malformed path.
{
  const { buf } = buildElf({ arch: 'not-a-valid-isa' });
  const image = parseELF(buf);
  assert.ok(image.warnings.includes('RISC-V Tag_RISCV_arch is missing or malformed'));
  assert.equal(image.metadata.riscvIsa.file, null);
}

// 5. No attributes section keeps the assumed RV64IMC fallback policy.
{
  const { buf } = buildElf({ arch: null });
  const image = parseELF(buf);
  assert.equal(image.metadata.riscvIsa.file, null);
  assert.equal(image.metadata.riscvIsa.evidence, 'missing');
  const profile = resolveRiscvIsaProfile(image.metadata.riscvIsa, 0x1000n);
  assert.equal(profile.canonical, 'rv64imc-assumed');
  assert.equal(profile.exact, false);
}

// 6a. A matching mapping symbol keeps its exact mapping-symbol profile.
{
  const { buf } = buildElf({ arch: 'rv64i2p1_m2p0', mappingNames: ['$xrv64i2p1_c2p0'] });
  const image = parseELF(buf);
  const address = image.metadata.riscvIsa.mappings[0].address;
  const profile = resolveRiscvIsaProfile(image.metadata.riscvIsa, address);
  assert.equal(profile.canonical, 'rv64i2p1_c2p0');
  assert.equal(profile.xlen, 64);
  assert.equal(profile.exact, true);
  assert.equal(profile.evidence, 'mapping-symbol');
}

// 6b. A $xrv32... mapping symbol must not contradict the ELFCLASS64 XLEN.
{
  const { buf } = buildElf({ arch: 'rv64i2p1_m2p0', mappingNames: ['$xrv32i2p1'] });
  const image = parseELF(buf);
  assert.ok(image.warnings.some((w) => /XLEN 32 disagrees with ELFCLASS64/.test(w)),
    `expected a disagreement diagnostic for the mapping symbol, got: ${JSON.stringify(image.warnings)}`);
  const address = image.metadata.riscvIsa.mappings[0].address;
  const profile = resolveRiscvIsaProfile(image.metadata.riscvIsa, address);
  assert.notEqual(profile.xlen, 32, 'mapping-symbol rv32 must not yield xlen:32 under ELFCLASS64');
  assert.notEqual(profile.evidence, 'mapping-symbol', 'the contradictory mapping ISA must not authorize evidence');
}

console.log('issue #4888 RISC-V ELFCLASS/Tag_RISCV_arch XLEN cross-check regression: PASS');
