import assert from 'node:assert/strict';
import test from 'node:test';

import { Emulator } from '../js/emu.js';

test('issue #5927 - external call log resolves the callee target label', () => {
  const lookedUp = [];
  const emulator = new Emulator({
    labelFor(address) {
      lookedUp.push(address);
      if (address === 0x1000n) return 'call-site';
      if (address === 0x2000n) return 'external-callee';
      return null;
    },
  });
  emulator.x[30] = 0x1004n;

  assert.equal(emulator.externalReturn(0x1000n, 0x2000n), 0x1004n);
  assert.deepEqual(lookedUp, [0x2000n]);
  assert.equal(emulator.log.at(-1).call, 'external-callee');
  assert.equal(emulator.x[0], 0n);
});
