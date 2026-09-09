import assert from 'node:assert/strict';
import test from 'node:test';

import { Emulator } from '../js/emu.js';

function faultOf(promise) {
  return promise.then(
    (value) => ({ value }),
    (error) => ({ code: error?.code, address: error?.details?.address, page: error?.details?.page }),
  );
}

test('#5227 an underflowing 64-bit effective address wraps to the architectural page', async () => {
  const emu = new Emulator();
  emu.set('x1', 0n);
  const outcome = await faultOf(emu.execute('ldr', 'x0, [x1, #-8]', 0n));
  // 0 - 8 mod 2^64: the fault must name the top-of-address-space page, not
  // page 0 with a negative offset.
  assert.equal(outcome.code, 'unmapped-memory');
  assert.equal(outcome.address, 0xfffffffffffffff8n);
  assert.equal(outcome.page, 0xfffffffffffff000n);
});

test('#5227 an overflowing 64-bit effective address wraps modulo 2^64', async () => {
  const emu = new Emulator();
  emu.set('x1', 0xffffffffffffffffn);
  const outcome = await faultOf(emu.execute('ldr', 'x0, [x1, #8]', 0n));
  assert.equal(outcome.code, 'unmapped-memory');
  assert.equal(outcome.address, 0x7n);
  assert.equal(outcome.page, 0n);
});

test('#5227 post-index writeback of an underflowing displacement wraps to 2^64', async () => {
  const emu = new Emulator();
  emu.mapZero(0n, 16);
  emu.set('x1', 0n);
  await emu.execute('ldr', 'x0, [x1], #-8', 0n);
  // The transfer read page 0; the writeback 0 + (-8) wraps to the top.
  assert.equal(emu.get('x1'), 0xfffffffffffffff8n);
});

test('#5227 pre-index addresses and writebacks share the wrapped address', async () => {
  const emu = new Emulator();
  // Page 0 is mapped; the pre-indexed address 0xffffffffffffffff + 8 wraps
  // into it, and the same wrapped value is written back.
  emu.mapZero(0n, 16);
  emu.set('x1', 0xffffffffffffffffn);
  await emu.execute('ldr', 'x0, [x1, #8]!', 0n);
  assert.equal(emu.get('x1'), 0x7n);
});
