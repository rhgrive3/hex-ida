import assert from 'node:assert/strict';
import test from 'node:test';

import { createX86DecodedInstruction } from '../../js/targets/architecture/x86_64/decoded-instruction.js';
import { dispatchX86MachineEffects } from '../../js/targets/architecture/x86_64/effects/index.js';

function nop(extra = {}) {
  return createX86DecodedInstruction({
    address: 0n,
    length: 1,
    rawBytes: Uint8Array.of(0x90),
    mode: 'long-64',
    instructionId: 'nop',
    instructionCode: 1,
    instructionFamily: 'nop',
    mnemonic: 'nop',
    detailAvailable: true,
    detailStatus: 'complete',
    detail: { operandCount: 0, operands: [], implicitReads: [], implicitWrites: [] },
    ...extra,
  });
}

test('canonical x86 bytes cannot be mutated through the published record', () => {
  const decoded = nop();
  decoded.rawBytes[0] = 0x91;
  assert.deepEqual([...decoded.rawBytes], [0x90]);
  assert.equal(decoded.instructionFamily, 'nop');
});

test('contradictory detail flags never open the exact effects gate', () => {
  for (const status of ['unavailable', 'partial', 'malformed']) {
    const decoded = nop({ detailAvailable: true, detailStatus: status });
    assert.equal(decoded.detailAvailable, false, `status ${status} must not stay available`);
    assert.equal(decoded.detailStatus, status);
    const dispatch = dispatchX86MachineEffects(decoded);
    assert.equal(dispatch.ownerId, 'fallback', `status ${status} must fall back`);
    assert.equal(dispatch.result, null);
  }
});

test('consistent detail inputs keep their existing gate behavior', () => {
  const available = nop();
  assert.equal(available.detailAvailable, true);
  assert.equal(available.detailStatus, 'complete');
  assert.notEqual(dispatchX86MachineEffects(available).ownerId, 'fallback');

  const fromStatus = nop({ detailStatus: 'complete' });
  assert.equal(fromStatus.detailAvailable, true);

  const unavailable = nop({ detailAvailable: false, detailStatus: 'unavailable' });
  assert.equal(unavailable.detailAvailable, false);
  assert.equal(dispatchX86MachineEffects(unavailable).ownerId, 'fallback');
});
