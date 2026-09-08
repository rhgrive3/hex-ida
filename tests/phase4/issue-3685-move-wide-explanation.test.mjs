import assert from 'node:assert/strict';
import { explain } from '../../js/arm64.js';
import { lang, setLang } from '../../js/i18n.js';

console.log('Testing #3685 ARM64 move-wide presentation...');

const previousLang = lang();
try {
  setLang('en');

  // Keep the established no-shift presentation stable.
  const movzNoShift = explain('movz', 'x0, #1', 0n, {});
  assert.equal(movzNoShift.pseudo, 'x0 = 1');
  assert.equal(movzNoShift.summary, 'Set x0 to 1, zeroing every other bit.');
  const movnNoShift = explain('movn', 'x0, #0', 0n, {});
  assert.equal(movnNoShift.pseudo, 'x0 = ~0');
  assert.equal(movnNoShift.summary, 'Put the bitwise inverse of 0 into x0 — how small negative constants are made.');

  // An explicit LSL #0 is a legal move-wide encoding and remains visible.
  for (const [register, shifts, bits] of [
    ['w0', [0, 16], 32],
    ['x0', [0, 16, 32, 48], 64],
  ]) {
    for (const shift of shifts) {
      const result = explain('movz', `${register}, #1, lsl #${shift}`, 0n, {});
      assert.equal(result.handlerError, undefined);
      assert.equal(result.pseudo, `${register} = 1 << ${shift}`);
      assert.match(result.summary, new RegExp(`${shift} bits`));
      assert.match(result.summary, new RegExp(`${bits}-bit width`));
    }
  }

  for (const [register, shifts, bits] of [
    ['w0', [0, 16], 32],
    ['x0', [0, 16, 32, 48], 64],
  ]) {
    for (const shift of shifts) {
      const result = explain('movn', `${register}, #1, lsl #${shift}`, 0n, {});
      const mask = bits === 32 ? '0xFFFFFFFF' : '0xFFFFFFFFFFFFFFFF';
      assert.equal(result.pseudo, `${register} = ~(1 << ${shift}) & ${mask}`);
      assert.match(result.summary, new RegExp(`${shift} bits`));
      assert.match(result.summary, new RegExp(`limited to ${bits} bits`));
    }
  }

  // MOVN must parenthesize the shifted immediate and bound NOT to W/X width.
  const movnW = explain('movn', 'w0, #0x1234, lsl #16', 0n, {});
  assert.equal(movnW.pseudo, 'w0 = ~(4660 << 16) & 0xFFFFFFFF');
  assert.match(movnW.summary, /shifted left by 16 bits/);
  assert.match(movnW.summary, /limited to 32 bits/);
  const movnX = explain('movn', 'x0, #0x1234, lsl #32', 0n, {});
  assert.equal(movnX.pseudo, 'x0 = ~(4660 << 32) & 0xFFFFFFFFFFFFFFFF');
  assert.match(movnX.summary, /shifted left by 32 bits/);
  assert.match(movnX.summary, /limited to 64 bits/);

  // MOVK owns its field-position presentation and must not regress.
  const movk = explain('movk', 'x0, #0x1234, lsl #16', 0n, {});
  assert.equal(movk.pseudo, 'x0[31:16] = 4660');
  assert.match(movk.summary, /starting at bit 16/);

  setLang('ja');
  const movzJapanese = explain('movz', 'w0, #1, lsl #16', 0n, {});
  assert.match(movzJapanese.summary, /16 ビット左/);
  assert.match(movzJapanese.summary, /32 ビット幅/);
  const movnJapanese = explain('movn', 'x0, #0x1234, lsl #32', 0n, {});
  assert.match(movnJapanese.summary, /32 ビット左/);
  assert.match(movnJapanese.summary, /64 ビット幅/);
  assert.match(movnJapanese.detail.join(' '), /64 ビット幅/);
} finally {
  setLang(previousLang);
}

console.log('#3685 ARM64 move-wide presentation: PASS');
