import assert from 'node:assert/strict';
import test from 'node:test';

import { createX86DecodedInstruction } from '../../js/targets/architecture/x86_64/decoded-instruction.js';
import { dispatchX86MachineEffects } from '../../js/targets/architecture/x86_64/effects/index.js';

// `detailStatus` and `detailAvailable` describe the same fact. When both are
// supplied they must agree: a contradiction (`complete`+false /
// `unavailable`+true) is an input schema violation, and a surviving
// `unavailable`+`detailAvailable:true` record would carry unavailable detail
// into the structured exact MachineEffects path (#6046).

const base = {
  address: 0x1000n,
  length: 3,
  rawBytes: Uint8Array.from([0x48, 0x89, 0xd8]),
  mode: 'long-64',
  instructionCode: 1,
  instructionFamily: 'mov',
  instructionId: 'i0',
  detail: {
    operandCount: 2,
    operands: [
      { type: 'register', register: 'rax', widthBits: 64, access: 'write' },
      { type: 'register', register: 'rbx', widthBits: 64, access: 'read' },
    ],
  },
};

test('#6046: contradictory availability fields fail closed', () => {
  for (const patch of [
    { detailStatus: 'unavailable', detailAvailable: true },
    { detailStatus: 'complete', detailAvailable: false },
  ]) {
    assert.throws(
      () => createX86DecodedInstruction({ ...base, ...patch }),
      (error) => error?.message === 'x86-decoded-instruction-detail-availability-conflict',
      `${JSON.stringify(patch)} must be rejected`,
    );
  }
});

test('#6046: agreeing fields and single-field derivations are unchanged', () => {
  const bothUnavailable = createX86DecodedInstruction({ ...base, detailStatus: 'unavailable', detailAvailable: false });
  assert.equal(bothUnavailable.detailStatus, 'unavailable');
  assert.equal(bothUnavailable.detailAvailable, false);

  const bothComplete = createX86DecodedInstruction({ ...base, detailStatus: 'complete', detailAvailable: true });
  assert.equal(bothComplete.detailStatus, 'complete');
  assert.equal(bothComplete.detailAvailable, true);

  const statusOnly = createX86DecodedInstruction({ ...base, detailStatus: 'unavailable' });
  assert.equal(statusOnly.detailAvailable, false);

  const availableOnly = createX86DecodedInstruction({ ...base, detailAvailable: true });
  assert.equal(availableOnly.detailStatus, 'complete');
});

test('#6046: a conflicting record cannot reach the structured effects path', () => {
  assert.throws(
    () => dispatchX86MachineEffects(createX86DecodedInstruction({
      ...base,
      detailStatus: 'unavailable',
      detailAvailable: true,
    })),
    (error) => error?.message === 'x86-decoded-instruction-detail-availability-conflict',
  );
  // An honest unavailable record still falls back instead of lifting.
  const unavailable = createX86DecodedInstruction({ ...base, detailStatus: 'unavailable', detailAvailable: false });
  const dispatched = dispatchX86MachineEffects(unavailable, {});
  assert.equal(dispatched.ownerId, 'fallback');
  assert.equal(dispatched.result, null);
});
