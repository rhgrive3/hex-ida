import assert from 'node:assert/strict';
import test from 'node:test';

import { createCapstoneX86Session } from '../phase5/helpers/capstone-session.mjs';
import { createX86DecodedInstruction } from '../../js/targets/architecture/x86_64/decoded-instruction.js';
import { dispatchX86MachineEffects, liftX86MachineEffects } from '../../js/targets/architecture/x86_64/effects/index.js';
import { liftX86ControlEffects } from '../../js/targets/architecture/x86_64/effects/control.js';

test('INT imm8 regression: lifts as exact-with-intrinsic with declared architectural effects', async () => {
  const capstone = await createCapstoneX86Session();
  try {
    for (const vector of [0x00, 0x03, 0x20, 0x80, 0xff]) {
      const bytes = new Uint8Array([0xcd, vector]);
      const decoded = capstone.decode(bytes, 0x400000n);
      assert.equal(decoded.length, 1);
      const instruction = createX86DecodedInstruction({
        ...decoded[0],
        instructionId: `int-regression:0x${vector.toString(16)}`,
      });

      const control = liftX86ControlEffects(instruction);
      assert.equal(control.completeness, 'exact-with-intrinsic');
      assert.equal(control.controlEffect.kind, 'indirect');
      assert.equal(control.unknownEffects, undefined);
      assert.equal(control.metadata?.operation, 'int');
      assert.equal(control.metadata?.vector, vector);
      assert.equal(control.metadata?.interruptDeliveryModeled, true);

      const intrinsic = control.operations.find((op) => op.kind === 'intrinsic');
      assert.ok(intrinsic, 'must carry intrinsic operation');
      assert.equal(intrinsic.intrinsicId, 'x86.control.interrupt-delivery');
      assert.equal(intrinsic.effectSummary.inputs.length, 4, 'vector, return RIP, RSP, and RFLAGS are intrinsic inputs');
      assert.equal(intrinsic.effectSummary.memoryRead.scope, 'all');
      assert.deepEqual(intrinsic.effectSummary.memoryRead.spaces, ['memory']);
      assert.equal(intrinsic.effectSummary.memoryWrite.scope, 'all');
      assert.deepEqual(intrinsic.effectSummary.memoryWrite.spaces, ['memory']);
      assert.equal(intrinsic.metadata?.deliveryContract, 'x86-long64-interrupt-delivery/v1');
      assert.equal(intrinsic.effectSummary.memoryRead.detail?.kind, 'x86-interrupt-delivery-reads');
      assert.equal(intrinsic.effectSummary.memoryWrite.detail?.kind, 'x86-interrupt-delivery-writes');
      assert.equal(control.controlEffect.target?.kind, 'x86-interrupt-delivery-target');
      assert.equal(control.controlEffect.target?.vector, vector);
      assert.ok(intrinsic.effectSummary.registersRead.includes('sys:x86.IDTR'));
      assert.ok(intrinsic.effectSummary.registersRead.includes('sys:x86.CPL'));
      assert.ok(intrinsic.effectSummary.registersRead.includes('sys:x86.GDTR'));
      assert.ok(intrinsic.effectSummary.registersRead.includes('sys:x86.TR'));
      assert.ok(intrinsic.effectSummary.registersRead.includes('rsp'));
      assert.ok(intrinsic.effectSummary.registersRead.includes('rflags'));
      assert.ok(intrinsic.effectSummary.registersWritten.includes('rsp'));
      assert.ok(intrinsic.effectSummary.registersWritten.includes('rflags'));

      const machine = liftX86MachineEffects(instruction);
      assert.equal(machine.completeness, 'exact-with-intrinsic');
      assert.equal(machine.controlEffect.kind, 'indirect');

      const dispatched = dispatchX86MachineEffects(instruction);
      assert.equal(dispatched.ownerId, 'control');
      assert.equal(dispatched.result.completeness, 'exact-with-intrinsic');
    }
  } finally {
    capstone.close();
  }
});
