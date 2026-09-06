import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRiscvAttributes } from '../../../js/binary/riscv-isa.js';

function uleb(n) {
  const out = [];
  do { let b = n & 0x7f; n = Math.floor(n / 128); if (n) b |= 0x80; out.push(b); } while (n);
  return out;
}
function u32le(n) { return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]; }
function ntbs(s) { return [...Buffer.from(s, 'utf8'), 0]; }

const ARCH = 'rv64i2p1_m2p0_a2p1_f2p2_d2p2_c2p0_zicsr2p0_zifencei2p0';

function payload(attributes) {
  const subsubBody = attributes.flat();
  const subsub = [...uleb(1), ...u32le(1 + 4 + subsubBody.length), ...subsubBody];
  const vendor = ntbs('riscv');
  const subLen = 4 + vendor.length + subsub.length;
  return Uint8Array.from([0x41, ...u32le(subLen), ...vendor, ...subsub]);
}

const archAttr = () => [[...uleb(5), ...ntbs(ARCH)]];

test('6056: known Tag_RISCV_arch parses as before', () => {
  const out = parseRiscvAttributes(payload(archAttr()));
  assert.ok(out, 'expected a result');
  assert.equal(out.evidence, 'elf-attribute');
  assert.ok(out.canonical.includes('rv64'));
});

test('6056: unknown mandatory even tag 18 rejects the section', () => {
  const out = parseRiscvAttributes(payload([[...uleb(18), ...uleb(1)], ...archAttr()]));
  assert.equal(out, null);
});

test('6056: unknown mandatory odd tag 19 rejects the section', () => {
  const out = parseRiscvAttributes(payload([[...uleb(19), ...ntbs('future')], ...archAttr()]));
  assert.equal(out, null);
});

test('6056: unknown optional even tag 64 is skipped', () => {
  const out = parseRiscvAttributes(payload([[...uleb(64), ...uleb(7)], ...archAttr()]));
  assert.ok(out, 'expected the arch to survive an optional skip');
  assert.equal(out.evidence, 'elf-attribute');
});

test('6056: unknown optional odd tag 65 is skipped', () => {
  const out = parseRiscvAttributes(payload([[...uleb(65), ...ntbs('note')], ...archAttr()]));
  assert.ok(out, 'expected the arch to survive an optional skip');
  assert.equal(out.evidence, 'elf-attribute');
});

test('6056: malformed unknown optional value fails closed', () => {
  // Tag 64 claims an integer value but the sub-subsection ends immediately.
  const subsubBody = [...uleb(64)];
  const subsub = [...uleb(1), ...u32le(1 + 4 + subsubBody.length), ...subsubBody];
  const vendor = ntbs('riscv');
  const subLen = 4 + vendor.length + subsub.length;
  const out = parseRiscvAttributes(Uint8Array.from([0x41, ...u32le(subLen), ...vendor, ...subsub]));
  assert.equal(out, null);
});

test('6056: known tags 4/6/8/10/12/14/16 are not treated as unknown', () => {
  for (const tag of [4, 6, 8, 10, 12, 14, 16]) {
    const out = parseRiscvAttributes(payload([[...uleb(tag), ...uleb(1)], ...archAttr()]));
    assert.ok(out, `known tag ${tag} must not reject the section`);
    assert.equal(out.evidence, 'elf-attribute');
  }
});
