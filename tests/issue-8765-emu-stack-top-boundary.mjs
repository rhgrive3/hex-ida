import assert from 'node:assert/strict';
import test from 'node:test';

import { Emulator, STACK_TOP } from '../js/emu.js';

function faultOf(promise) {
  return promise.then(
    (value) => ({ value }),
    (error) => ({ code: error?.code, address: error?.details?.address, page: error?.details?.page }),
  );
}

test('#8765 keeps the formal stack top exclusive for loads and stores', async () => {
  const valid = new Emulator();
  await valid.load(STACK_TOP - 1n, 1);
  await valid.store(STACK_TOP - 1n, 1, 0x5a);

  const loadOutside = await faultOf(new Emulator().load(STACK_TOP, 1));
  assert.equal(loadOutside.code, 'unmapped-memory');
  assert.equal(loadOutside.address, STACK_TOP);
  assert.equal(loadOutside.page, STACK_TOP);

  const storeOutside = await faultOf(new Emulator().store(STACK_TOP, 1, 0x5a));
  assert.equal(storeOutside.code, 'unmapped-memory');
  assert.equal(storeOutside.address, STACK_TOP);
  assert.equal(storeOutside.page, STACK_TOP);
});
