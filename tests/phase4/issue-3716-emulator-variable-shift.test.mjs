import assert from 'node:assert/strict';
import { Emulator } from '../../js/emu.js';

const MASK32 = 0xffffffffn;

function expectedShift(mnemonic, value, amount, bits) {
  const wide = bits === 64;
  const shift = amount & (wide ? 63n : 31n);
  if (mnemonic === 'lsl') return BigInt.asUintN(bits, value << shift);
  if (mnemonic === 'lsr') return BigInt.asUintN(bits, value) >> shift;
  if (mnemonic === 'asr') return BigInt.asUintN(bits, BigInt.asIntN(bits, value) >> shift);
  throw new Error(`unsupported mnemonic: ${mnemonic}`);
}

for (const mnemonic of ['lsl', 'lsr', 'asr']) {
  for (const amount of [0n, 31n, 32n, 33n, 63n]) {
    const emu = new Emulator({});
    const input = 0x80000001n;
    emu.set('w0', input);
    emu.set('w1', amount);
    await emu.execute(mnemonic, 'w2, w0, w1', 0n);
    assert.equal(
      emu.get('w2'),
      expectedShift(mnemonic, input & MASK32, amount, 32),
      `${mnemonic} W amount=${amount} must use amount modulo 32`,
    );
  }

  for (const amount of [0n, 63n, 64n, 65n]) {
    const emu = new Emulator({});
    const input = 0x8000000000000001n;
    emu.set('x0', input);
    emu.set('x1', amount);
    await emu.execute(mnemonic, 'x2, x0, x1', 0n);
    assert.equal(
      emu.get('x2'),
      expectedShift(mnemonic, input, amount, 64),
      `${mnemonic} X amount=${amount} must use amount modulo 64`,
    );
  }
}

for (const [dst, src, count, input] of [
  ['w2', 'w0', 'w1', 0x81234567n],
  ['x2', 'x0', 'x1', 0x8123456789abcdefn],
]) {
  const bits = dst.startsWith('w') ? 32 : 64;
  const amount = BigInt(bits);
  const emu = new Emulator({});
  emu.set(src, input);
  emu.set(count, amount);
  await emu.execute('ror', `${dst}, ${src}, ${count}`, 0n);
  assert.equal(emu.get(dst), BigInt.asUintN(bits, input), `ror ${bits}-bit full-width rotation remains identity`);
}

console.log('issue-3716-emulator-variable-shift: PASS');
