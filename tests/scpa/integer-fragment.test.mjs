import test from 'node:test';
import assert from 'node:assert/strict';
import { workFor } from './helpers.mjs';
import { checkIntegerFragmentBytes as check } from '../../js/core/evidence/arm64-integer-fragment.js';

// Independent test-side encoders and concrete arithmetic; neither is imported
// by production. This is deterministic differential coverage, not an ISA oracle.
const mask = bits => (1n << BigInt(bits)) - 1n;
const words = values => {
  const bytes = new Uint8Array(values.length * 4), view = new DataView(bytes.buffer);
  values.forEach((value, i) => view.setUint32(i * 4, value >>> 0, true));
  return bytes;
};
const mov = (bits, opc, imm, hw = 0, rd = 0) => ((bits === 64 ? 0x80000000 : 0) | (opc << 29) | 0x12800000 | (hw << 21) | (imm << 5) | rd) >>> 0;
const add = (bits, sub, imm, rn = 0, rd = 0, shift = 0) => ((bits === 64 ? 0x80000000 : 0) | (sub ? 0x40000000 : 0) | 0x11000000 | (shift << 22) | (imm << 10) | (rn << 5) | rd) >>> 0;
const logical = (bits, opc, invert, kind, amount, rn = 0, rm = 1, rd = 2) => ((bits === 64 ? 0x80000000 : 0) | (opc << 29) | 0x0a000000 | (kind << 22) | (invert << 21) | (rm << 16) | (amount << 10) | (rn << 5) | rd) >>> 0;
function claim(value, bits = 64, register = 'x0') {
  const v = BigInt(value) & mask(bits);
  return { register, bits, constant: String(v), knownOne: String(v), knownZero: String(mask(bits) ^ v),
    range: { kind: 'interval', lower: String(v), upper: String(v) } };
}
function top(bits = 64, register = 'x0') {
  return { register, bits, constant: null, knownOne: '0', knownZero: '0', range: { kind: 'full', lower: '0', upper: String(mask(bits)) } };
}
function evaluate(t, instructions, conclusion, limits) {
  return check(words(instructions), conclusion, { work: workFor(t, limits) });
}

for (const bits of [32, 64]) {
  test(`MOVZ/MOVN/MOVK cover ${bits}-bit lanes, zero extension and wraparound`, t => {
    const work = workFor(t), run = (insns, c) => check(words(insns), c, { work });
    for (let hw = 0; hw < bits / 16; hw++) for (const imm of [0, 1, 0x8000, 0xffff]) {
      for (const opc of [0, 2]) {
        const value = (opc === 0 ? ~(BigInt(imm) << BigInt(16 * hw)) : BigInt(imm) << BigInt(16 * hw)) & mask(bits);
        assert.equal(run([mov(bits, opc, imm, hw)], claim(value)).status, 'verified');
        const changed = (value & ~(65535n << BigInt(16 * hw))) | (7n << BigInt(16 * hw));
        assert.equal(run([mov(bits, opc, imm, hw), mov(bits, 3, 7, hw)], claim(changed)).status, 'verified');
      }
    }
    assert.equal(run([mov(bits, 0, 0), add(bits, false, 1)], claim(0)).status, 'verified');
    assert.equal(run([mov(bits, 2, 0), add(bits, true, 1)], claim(mask(bits))).status, 'verified');
    assert.equal(run([mov(bits, 2, 1), add(bits, false, 4095, 0, 0, 1)], claim(1 + 4095 * 4096)).status, 'verified');
  });
  test(`all ${bits}-bit logical variants and shifts match concrete test arithmetic`, t => {
    const work = workFor(t, { workUnits: 200000 });
    const a = bits === 64 ? 0x9234000000000000n : 0x92340000n;
    const b = bits === 64 ? 0x8100000000000000n : 0x81000000n;
    for (const opc of [0, 1, 2, 3]) for (const invert of [0, 1]) for (const kind of [0, 1, 2, 3]) {
      for (let amount = 0; amount < bits; amount++) {
        const n = BigInt(amount), width = BigInt(bits);
        let shifted = kind === 0 ? b << n : kind === 1 ? b >> n
          : kind === 2 ? (b - (1n << width)) >> n : (b >> n) | (b << (width - n));
        shifted &= mask(bits);
        if (invert) shifted ^= mask(bits);
        const expected = opc === 0 || opc === 3 ? a & shifted : opc === 1 ? a | shifted : a ^ shifted;
        const insns = [mov(bits, 2, 0x9234, bits / 16 - 1, 0), mov(bits, 2, 0x8100, bits / 16 - 1, 1), logical(bits, opc, invert, kind, amount)];
        const result = check(words(insns), claim(expected, 64, 'x2'), { work });
        assert.equal(result.status, 'verified', `${bits}/${opc}/${invert}/${kind}/${amount}`);
      }
    }
  });
}

test('MOVK partial entry facts and logical zero-register facts remain conservative', t => {
  const c = top(); c.knownOne = '7'; c.knownZero = String(65535 ^ 7);
  assert.equal(evaluate(t, [mov(64, 3, 7)], c).status, 'verified');
  assert.equal(evaluate(t, [mov(64, 3, 7)], claim(7)).status, 'unknown');
  assert.equal(evaluate(t, [logical(64, 0, 0, 0, 0, 0, 31, 0)], claim(0)).status, 'verified');
  // XOR of the same unknown input loses correlation, so it must not refute 0.
  assert.equal(evaluate(t, [logical(64, 2, 0, 0, 0, 0, 0, 0)], claim(0)).status, 'unknown');
  assert.equal(evaluate(t, [add(32, false, 1)], { ...top(), knownZero: String(mask(64) ^ mask(32)) }).status, 'verified');
});

test('range conclusions are checked by containment, not merely constant equality', t => {
  const c = { ...top(), range: { kind: 'interval', lower: '0', upper: '100' } };
  assert.equal(evaluate(t, [mov(64, 2, 42)], c).status, 'verified');
  assert.equal(evaluate(t, [mov(64, 2, 42)], { ...c, range: { ...c.range, upper: '41' } }).status, 'rejected');
  const wrapped = { ...top(), range: { kind: 'wrapped', lower: '100', upper: '10' } };
  assert.equal(evaluate(t, [mov(64, 2, 5)], wrapped).status, 'verified');
  assert.equal(evaluate(t, [mov(64, 0, 0)], wrapped).status, 'verified');
  assert.equal(evaluate(t, [mov(64, 2, 50)], wrapped).status, 'rejected');
  assert.equal(evaluate(t, [mov(64, 3, 5)], wrapped).status, 'unknown');
});

for (const [name, instruction] of [
  ['load', 0xf94003e0], ['store', 0xf90003e0], ['branch', 0x14000001], ['call', 0x94000001],
  ['return', 0xd65f03c0], ['hint other than NOP', 0xd503205f], ['zero encoding', 0],
  ['ADD SP', 0x910003e0], ['ADD to SP', 0x9100001f], ['ADDS', 0xb1000400],
  ['reserved move-wide opc', mov(64, 1, 1)], ['unallocated W halfword', mov(32, 2, 1, 2)],
  ['unallocated W logical shift', logical(32, 1, 0, 0, 32)],
]) test(`${name} is a hard unsupported cut, even before a later constant write`, t => {
  const value = evaluate(t, [mov(64, 2, 7), instruction, mov(64, 2, 7)], claim(7));
  assert.equal(value.status, 'unknown'); assert.equal(value.detail.at, 4);
});

test('64-bit precision, NOP and writes to ZR cannot invent entry facts', t => {
  assert.equal(evaluate(t, [mov(64, 2, 0xffff, 3), 0xd503201f], claim(0xffff000000000000n)).status, 'verified');
  assert.equal(evaluate(t, [mov(64, 2, 7, 0, 31)], claim(7)).status, 'unknown');
  assert.equal(evaluate(t, [mov(64, 2, 7)], claim(8)).status, 'rejected');
});

test('malformed integers, widths, masks, fields and byte bounds fail closed', t => {
  for (const edit of [c => { c.constant = '9007199254740993.0'; }, c => { c.constant = '01'; },
    c => { c.constant = '18446744073709551616'; }, c => { c.constant = '9'.repeat(1000); },
    c => { c.knownZero = '7'; }, c => { c.register = 'x31'; }, c => { c.bits = 8; },
    c => { c.range.upper = '-1'; }, c => { c.range.kind = 'full'; }, c => { c.trusted = true; }]) {
    const c = claim(7); edit(c); assert.throws(() => evaluate(t, [mov(64, 2, 7)], c), /integer-fragment/);
  }
  for (const bytes of [new Uint8Array(), new Uint8Array(3), new Uint8Array(260), [0, 0, 0, 0]]) {
    assert.throws(() => check(bytes, claim(0), { work: workFor(t) }), /byte-budget/);
  }
  assert.equal(evaluate(t, Array(64).fill(0xd503201f), top()).status, 'verified');
});

test('parent work limits and cancellation apply before integer replay returns', t => {
  assert.throws(() => evaluate(t, [mov(64, 2, 7)], claim(7), { workUnits: 15 }), /workUnits|budget/);
  const work = workFor(t); work.dispose();
  assert.throws(() => check(words([mov(64, 2, 7)]), claim(7), { work }), /disposed|cancelled/);
});
