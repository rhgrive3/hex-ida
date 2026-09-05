import test from 'node:test';
import assert from 'node:assert/strict';
import { createX86DecodedInstruction } from '../js/targets/architecture/x86_64/decoded-instruction.js';
import { dispatchX86MachineEffects } from '../js/targets/architecture/x86_64/effects/index.js';

function mov(overrides = {}) {
  return {
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
    ...overrides,
  };
}

test('6046: coherent pairs are accepted', () => {
  const complete = createX86DecodedInstruction(mov({ detailStatus: 'complete', detailAvailable: true }));
  assert.equal(complete.detailStatus, 'complete');
  assert.equal(complete.detailAvailable, true);
  const unavailable = createX86DecodedInstruction(mov({ detailStatus: 'unavailable', detailAvailable: false }));
  assert.equal(unavailable.detailStatus, 'unavailable');
  assert.equal(unavailable.detailAvailable, false);
});

test('6046: single-sided inputs derive the other field', () => {
  const fromStatus = createX86DecodedInstruction(mov({ detailStatus: 'complete' }));
  assert.equal(fromStatus.detailAvailable, true);
  const fromFlag = createX86DecodedInstruction(mov({ detailAvailable: true }));
  assert.equal(fromFlag.detailStatus, 'complete');
  const defaulted = createX86DecodedInstruction(mov({}));
  assert.equal(defaulted.detailStatus, 'unavailable');
  assert.equal(defaulted.detailAvailable, false);
});

test('6046: contradictory pairs are rejected', () => {
  assert.throws(
    () => createX86DecodedInstruction(mov({ detailStatus: 'unavailable', detailAvailable: true })),
    /detail-availability-contradiction/,
  );
  assert.throws(
    () => createX86DecodedInstruction(mov({ detailStatus: 'complete', detailAvailable: false })),
    /detail-availability-contradiction/,
  );
});

test('6046: unavailable records still dispatch to the fallback', () => {
  const decoded = createX86DecodedInstruction(mov({ detailStatus: 'unavailable', detailAvailable: false }));
  const dispatch = dispatchX86MachineEffects(decoded, {});
  assert.equal(dispatch.ownerId, 'fallback');
  assert.equal(dispatch.result, null);
});
