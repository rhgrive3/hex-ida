import assert from 'node:assert/strict';
import test from 'node:test';

import { Emulator } from '../js/emu.js';

function faultOf(promise) {
  return promise.then(
    (value) => ({ value }),
    (error) => ({ code: error?.code, address: error?.details?.address, page: error?.details?.page }),
  );
}

test('#8695 load preserves the first unaligned byte as fault address', async () => {
  const emu = new Emulator();
  const outcome = await faultOf(emu.load(0xfffn, 2));

  assert.equal(outcome.code, 'unmapped-memory');
  assert.equal(outcome.address, 0xfffn);
  assert.equal(outcome.page, 0n);
});

test('#8695 later pages report the first byte required in that page', async () => {
  const emu = new Emulator({
    read: async (page) => page === 0n ? new Uint8Array(4096) : new Uint8Array(),
  });
  const outcome = await faultOf(emu.load(0xfffn, 2));

  assert.equal(outcome.code, 'unmapped-memory');
  assert.equal(outcome.address, 0x1000n);
  assert.equal(outcome.page, 0x1000n);
});

test('#8695 store preserves the unaligned write byte as fault address', async () => {
  const emu = new Emulator();
  const outcome = await faultOf(emu.store(1n, 1, 0n));

  assert.equal(outcome.code, 'unmapped-memory');
  assert.equal(outcome.address, 1n);
  assert.equal(outcome.page, 0n);
});
