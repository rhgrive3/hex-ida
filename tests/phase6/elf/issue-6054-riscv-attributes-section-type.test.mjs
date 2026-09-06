import assert from 'node:assert/strict';
import test from 'node:test';
import { parseELF } from '../../../js/binary/elf-core.js';

function uleb(n) {
  const out = [];
  do { let b = n & 0x7f; n = Math.floor(n / 128); if (n) b |= 0x80; out.push(b); } while (n);
  return out;
}
function u32le(n) { return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]; }
function ntbs(s) { return [...Buffer.from(s, 'utf8'), 0]; }

function buildAttrPayload() {
  const archStr = 'rv64i2p1_m2p0_a2p1_f2p2_d2p2_c2p0_zicsr2p0_zifencei2p0';
  const attrPayload = [...uleb(5), ...ntbs(archStr)];
  const tagBytes = uleb(1);
  const subsubLen = tagBytes.length + 4 + attrPayload.length;
  const subsub = [...tagBytes, ...u32le(subsubLen), ...attrPayload];
  const vendor = ntbs('riscv');
  const subLen = 4 + vendor.length + subsub.length;
  return Uint8Array.from([0x41, ...u32le(subLen), ...vendor, ...subsub]);
}

function buildElf(sectionType) {
  const attr = buildAttrPayload();
  const shstr = Uint8Array.from([0, ...Buffer.from('.riscv.attributes'), 0, ...Buffer.from('.shstrtab'), 0]);
  const nameAttr = 1;
  const nameShstr = 1 + '.riscv.attributes'.length + 1;
  const ehsize = 64;
  const attrOff = ehsize;
  const shstrOff = attrOff + attr.length;
  const shOff = (shstrOff + shstr.length + 7) & ~7;
  const shentsize = 64;
  const total = shOff + 3 * shentsize;
  const buf = new Uint8Array(total);
  const dv = new DataView(buf.buffer);
  buf.set(attr, attrOff);
  buf.set(shstr, shstrOff);
  buf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0], 0);
  dv.setUint16(16, 2, true); dv.setUint16(18, 243, true); dv.setUint32(20, 1, true);
  dv.setBigUint64(24, 0n, true); dv.setBigUint64(32, 0n, true); dv.setBigUint64(40, BigInt(shOff), true);
  dv.setUint32(48, 0, true); dv.setUint16(52, 64, true); dv.setUint16(54, 0, true); dv.setUint16(56, 0, true);
  dv.setUint16(58, 64, true); dv.setUint16(60, 3, true); dv.setUint16(62, 2, true);
  const writeSh = (i, name, type, off, size) => {
    const o = shOff + i * shentsize;
    dv.setUint32(o, name, true); dv.setUint32(o + 4, type, true);
    dv.setBigUint64(o + 8, 0n, true); dv.setBigUint64(o + 16, 0n, true);
    dv.setBigUint64(o + 24, BigInt(off), true); dv.setBigUint64(o + 32, BigInt(size), true);
    dv.setUint32(o + 40, 0, true); dv.setUint32(o + 44, 0, true);
    dv.setBigUint64(o + 48, 1n, true); dv.setBigUint64(o + 56, 0n, true);
  };
  writeSh(0, 0, 0, 0, 0);
  writeSh(1, nameAttr, sectionType, attrOff, attr.length);
  writeSh(2, nameShstr, 3, shstrOff, shstr.length);
  return buf;
}

test('6054: SHT_RISCV_ATTRIBUTES is required for exact ISA evidence', () => {
  const good = parseELF(buildElf(0x70000003));
  assert.equal(good.metadata.riscvIsa?.evidence, 'elf-attribute');
  assert.ok(good.metadata.riscvIsa?.file?.canonical?.includes('rv64'));
});

test('6054: SHT_PROGBITS masquerading as .riscv.attributes is not authoritative', () => {
  const forged = parseELF(buildElf(1));
  assert.notEqual(forged.metadata.riscvIsa?.evidence, 'elf-attribute', 'forged PROGBITS must not become elf-attribute');
  assert.equal(forged.metadata.riscvIsa?.file ?? null, null);
});

test('6054: other processor-specific type is not authoritative', () => {
  const forged = parseELF(buildElf(0x70000004));
  assert.notEqual(forged.metadata.riscvIsa?.evidence, 'elf-attribute');
});
