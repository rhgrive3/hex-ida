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

test('6060: trailing truncated tag after arch fails the parse', () => {
  const out = parseRiscvAttributes(payload([...archAttr(), [0x80]]));
  assert.equal(out, null);
});

test('6060: trailing unterminated string after arch fails the parse', () => {
  // Odd unknown tag 65 (>= 64, optional) with a string that never NUL-terminates.
  const out = parseRiscvAttributes(payload([...archAttr(), [...uleb(65), ...Buffer.from('note', 'utf8')]]));
  assert.equal(out, null);
});

test('6060: unknown mandatory tag after arch fails the parse', () => {
  const out = parseRiscvAttributes(payload([...archAttr(), [...uleb(18), ...uleb(1)]]));
  assert.equal(out, null);
});

test('6060: valid optional attribute after arch still parses', () => {
  const out = parseRiscvAttributes(payload([...archAttr(), [...uleb(64), ...uleb(7)]]));
  assert.ok(out, 'expected the arch to survive a valid optional tail');
  assert.equal(out.evidence, 'elf-attribute');
});

test('6060: clean arch-only payload still parses', () => {
  const out = parseRiscvAttributes(payload(archAttr()));
  assert.ok(out, 'expected a result');
  assert.ok(out.canonical.includes('rv64'));
});

test('6060: no arch tag still yields null', () => {
  const out = parseRiscvAttributes(payload([[ ...uleb(64), ...uleb(7) ]]));
  assert.equal(out, null);
});

for (const garbage of [[0x00], [0x00, 0x00], [0x00, 0x00, 0x00], [0xff]]) {
  test(`6060: ${garbage.length}-byte garbage suffix after a valid section fails the parse`, () => {
    const clean = payload(archAttr());
    const out = parseRiscvAttributes(Uint8Array.from([...clean, ...garbage]));
    assert.equal(out, null);
  });
}
