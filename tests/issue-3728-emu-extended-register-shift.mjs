import assert from 'node:assert/strict';
import { Emulator } from '../js/emu.js';

const MASK64 = (1n << 64n) - 1n;

async function addExtended(dst, lhs, rhs, modifier) {
  const emu = new Emulator();
  emu.set('x1', 10n);
  emu.set(rhs.text, rhs.value);
  const ops = `${dst}, x1, ${rhs.text}${modifier ? ', ' + modifier : ''}`;
  await emu.execute('add', ops, 0n);
  return emu.get('x0');
}

const extendedCases = [
  ['x0', { text: 'w2', value: 0xffffn }, 'sxth #1', 8n],
  ['x0', { text: 'w2', value: 0x0001ffffn }, 'uxth #2', 262150n],
  ['x0', { text: 'x2', value: MASK64 }, 'sxtx #3', 2n],
  ['x0', { text: 'x2', value: 0x10n }, 'uxtx #3', 138n],
  ['x0', { text: 'w2', value: 0x1ffn }, 'sxtb #1', 8n],
  ['x0', { text: 'w2', value: 0x1ffn }, 'uxtb #2', 1030n],
  ['x0', { text: 'w2', value: 0xffffffffn }, 'sxtw #2', 6n],
  ['x0', { text: 'w2', value: 0x2n }, 'uxtw #1', 14n],
  ['x0', { text: 'w2', value: 0xffffn }, 'sxth', 9n],
  ['x0', { text: 'w2', value: 0xffffn }, 'sxth #0', 9n],
  ['x0', { text: 'x2', value: MASK64 }, 'sxtx', 9n],
  ['x0', { text: 'x2', value: MASK64 }, 'sxtx #0', 9n],
  ['x0', { text: 'w2', value: 0x12345678n }, 'uxth #4', 354186n],
];

for (const [dst, rhs, modifier, expected] of extendedCases) {
  const actual = await addExtended(dst, 'x1', rhs, modifier);
  assert.equal(
    actual,
    expected,
    `ADD ${dst}, x1, ${rhs.text}, ${modifier || '<modifier omitted>'} must be ${expected} but was ${actual}`,
  );
}

{
  const emu = new Emulator();
  emu.mapZero(0x1000n, 0x200);
  for (let i = 0; i < 16; i++) await emu.store(0x1000n + BigInt(i), 1, BigInt(i + 1));
  await emu.store(0x10f8n, 8, 0xdeadbeefcafef00dn);
  emu.set('x1', 0x1100n);
  emu.set('x2', MASK64);
  await emu.execute('ldr', 'x0, [x1, x2, sxtx #3]', 0n);
  assert.equal(emu.get('x0'), 0xdeadbeefcafef00dn, 'register offset [x1, x2, sxtx #3] must index x1 - 8');
}

{
  const emu = new Emulator();
  emu.set('x1', 10n);
  emu.set('x2', 0xabcdefn);
  const failures = [];
  for (const modifier of ['ror #3', 'msl #4']) {
    try {
      const value = await emu.execute('add', `x0, x1, x2, ${modifier}`, 0n);
      failures.push(`${modifier} evaluated to ${value}`);
    } catch (error) {
      if (error?.code !== 'unsupported-shift' && error?.code !== 'illegal-shift-amount') {
        failures.push(`${modifier} faulted with ${error?.code}`);
      }
    }
  }
  assert.deepEqual(failures, [], 'unsupported shifted-register modifiers must fail closed, not return the raw register');
}

{
  const emu = new Emulator();
  emu.set('x1', 10n);
  emu.set('w2', 0xffffn);
  let code = null;
  try {
    await emu.execute('add', 'x0, x1, w2, sxth #7', 0n);
  } catch (error) { code = error?.code; }
  assert.equal(code, 'illegal-shift-amount', 'an out-of-range extended-register shift must fail closed');
}

console.log(`issue #3728 emulator extended-register shifts: ok (${extendedCases.length} cases)`);
