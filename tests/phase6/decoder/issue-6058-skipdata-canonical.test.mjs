import test from 'node:test';
import assert from 'node:assert/strict';
import { createX86DecodedInstruction } from '../../../js/targets/architecture/x86_64/decoded-instruction.js';
import { dispatchX86MachineEffects } from '../../../js/targets/architecture/x86_64/effects/index.js';

function skipdataRecord(overrides = {}) {
  return {
    address: 0x1000n,
    size: 1,
    length: 1,
    rawBytes: new Uint8Array([0xff]),
    mode: 'long-64',
    decoderSemanticVersion: 'capstone-5-x86-structured-v2',
    instructionCode: 0,
    opcodeId: 0,
    instructionFamily: '.byte',
    mnemonic: '.byte',
    opStr: '0xff',
    detailAvailable: false,
    detailStatus: 'skipdata',
    detail: { unavailableFacts: ['all-structured-x86-detail'] },
    ...overrides,
  };
}

test('6058: SKIPDATA record canonicalizes instead of throwing', () => {
  let record = null;
  assert.doesNotThrow(() => { record = createX86DecodedInstruction(skipdataRecord()); });
  assert.equal(record.instructionCode, 0);
  assert.equal(record.detailStatus, 'skipdata');
  assert.equal(record.detailAvailable, false);
});

test('6058: SKIPDATA dispatches to the effects fallback', () => {
  const dispatch = dispatchX86MachineEffects(skipdataRecord());
  assert.equal(dispatch.ownerId, 'fallback');
  assert.equal(dispatch.result, null);
});

test('6058: nonzero code with skipdata status is rejected', () => {
  assert.throws(
    () => createX86DecodedInstruction(skipdataRecord({ instructionCode: 1, opcodeId: 1 })),
    /x86-decoded-instruction-id-required/,
  );
});

test('6058: zero code without skipdata status is still rejected', () => {
  assert.throws(
    () => createX86DecodedInstruction(skipdataRecord({ instructionCode: 0, opcodeId: 0, detailStatus: 'unavailable' })),
    /x86-decoded-instruction-id-required/,
  );
});
