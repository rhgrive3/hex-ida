import assert from 'node:assert/strict';
import test from 'node:test';

import { Emulator } from '../../js/emu.js';

// #5235: SCVTF/UCVTF to an S register must round once (integer -> binary32).
// x0 = 0x0020000020000001 = 9007199791611905 sits 1 above the binary32
// midpoint, so single rounding goes up: 0x5a000001. Rounding through binary64
// first loses the low bits and lands on 0x5a000000 (one ULP low).
test('#5235 scvtf s0, x0 rounds directly to binary32 (no double rounding)', async () => {
  const emu = new Emulator();
  emu.set('x0', 0x0020000020000001n);
  await emu.execute('scvtf', 's0, x0', 0n);
  const raw = emu.fpBits({ k: 'reg', cls: 'fp', num: 0, text: 's0', bits: 32 });
  assert.equal(raw.toString(16), '5a000001', `expected 0x5a000001, got 0x${raw.toString(16)}`);
});

test('#5235 ucvtf s0, x0 rounds directly to binary32', async () => {
  const emu = new Emulator();
  emu.set('x0', 0x0020000020000001n);
  await emu.execute('ucvtf', 's0, x0', 0n);
  const raw = emu.fpBits({ k: 'reg', cls: 'fp', num: 0, text: 's0', bits: 32 });
  assert.equal(raw.toString(16), '5a000001', `expected 0x5a000001, got 0x${raw.toString(16)}`);
});

test('#5235 scvtf s0, x0 midpoint ties to even', async () => {
  // Exactly at the binary32 midpoint: ties-to-even picks 0x5a000000.
  const emu = new Emulator();
  emu.set('x0', 0x0020000020000000n);
  await emu.execute('scvtf', 's0, x0', 0n);
  const raw = emu.fpBits({ k: 'reg', cls: 'fp', num: 0, text: 's0', bits: 32 });
  assert.equal(raw.toString(16), '5a000000', `expected 0x5a000000, got 0x${raw.toString(16)}`);
});

test('#5235 d-register conversion keeps exact binary64 behavior', async () => {
  const emu = new Emulator();
  // 0x0010000000000001 = 2^52 + 1 needs 53 significand bits, exactly what
  // binary64 carries, so the double must reproduce the integer exactly.
  const x = 0x0010000000000001n;
  emu.set('x0', x);
  await emu.execute('scvtf', 'd0, x0', 0n);
  const raw = emu.fpBits({ k: 'reg', cls: 'fp', num: 0, text: 'd0', bits: 64 });
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, raw, true);
  assert.equal(view.getFloat64(0, true), Number(x));
});

test('#5235 w-register source and negative values stay exact', async () => {
  const emu = new Emulator();
  emu.set('w0', 0x80000001n);
  await emu.execute('scvtf', 's0, w0', 0n);
  const raw = emu.fpBits({ k: 'reg', cls: 'fp', num: 0, text: 's0', bits: 32 });
  // -2147483647 is exactly representable in binary32.
  assert.equal(raw.toString(16), 'cf000000', `expected 0xcf000000, got 0x${raw.toString(16)}`);
});
