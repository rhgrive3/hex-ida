import assert from 'node:assert/strict';
import { Emulator } from '../js/emu.js';

function expectedShift(mnemonic, value, amount, width) {
  const shift = BigInt(amount) & (width === 64 ? 63n : 31n);
  const unsigned = BigInt.asUintN(width, BigInt(value));
  if (mnemonic === 'lsl') return BigInt.asUintN(width, unsigned << shift);
  if (mnemonic === 'lsr') return unsigned >> shift;
  if (mnemonic === 'asr') {
    return BigInt.asUintN(width, BigInt.asIntN(width, unsigned) >> shift);
  }
  if (mnemonic === 'ror') {
    if (shift === 0n) return unsigned;
    const bits = BigInt(width);
    return BigInt.asUintN(width, (unsigned >> shift) | (unsigned << (bits - shift)));
  }
  throw new Error(`unsupported shift mnemonic: ${mnemonic}`);
}

async function executeVariableShift(mnemonic, width, value, amount) {
  const emu = new Emulator();
  const prefix = width === 64 ? 'x' : 'w';
  emu.set(`${prefix}0`, value);
  emu.set(`${prefix}1`, amount);
  await emu.execute(mnemonic, `${prefix}2, ${prefix}0, ${prefix}1`, 0n);
  return emu.get(`${prefix}2`);
}

const sourceByMnemonic = {
  lsl: { 32: 0x80000001n, 64: 0x8000000000000001n },
  lsr: { 32: 0x80000001n, 64: 0x8000000000000001n },
  asr: { 32: 0x80000001n, 64: 0x8000000000000001n },
};

for (const mnemonic of ['lsl', 'lsr', 'asr']) {
  for (const amount of [0n, 31n, 32n, 33n, 63n]) {
    const value = sourceByMnemonic[mnemonic][32];
    const actual = await executeVariableShift(mnemonic, 32, value, amount);
    assert.equal(
      actual,
      expectedShift(mnemonic, value, amount, 32),
      `${mnemonic.toUpperCase()} W shift ${amount} must use amount modulo 32`,
    );
  }

  for (const amount of [0n, 63n, 64n, 65n]) {
    const value = sourceByMnemonic[mnemonic][64];
    const actual = await executeVariableShift(mnemonic, 64, value, amount);
    assert.equal(
      actual,
      expectedShift(mnemonic, value, amount, 64),
      `${mnemonic.toUpperCase()} X shift ${amount} must use amount modulo 64`,
    );
  }
}

// ROR already used width-aware modulo semantics; keep it pinned while sharing the
// same boundary cases that exposed #3716.
for (const [width, value, amounts] of [
  [32, 0x80000001n, [0n, 31n, 32n, 33n, 63n]],
  [64, 0x8000000000000001n, [0n, 63n, 64n, 65n]],
]) {
  for (const amount of amounts) {
    const actual = await executeVariableShift('ror', width, value, amount);
    assert.equal(
      actual,
      expectedShift('ror', value, amount, width),
      `ROR ${width}-bit shift ${amount} must remain width-aware`,
    );
  }
}

console.log('issue #3716 emulator variable shifts: ok');
