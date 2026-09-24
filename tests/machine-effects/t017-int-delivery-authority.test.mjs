import assert from 'node:assert/strict';
import test from 'node:test';

import { createCapstoneX86Session } from '../phase5/helpers/capstone-session.mjs';
import { createX86DecodedInstruction } from '../../js/targets/architecture/x86_64/decoded-instruction.js';
import { dispatchX86MachineEffects, liftX86MachineEffects } from '../../js/targets/architecture/x86_64/effects/index.js';
import { liftX86ControlEffects } from '../../js/targets/architecture/x86_64/effects/control.js';
import { closeTrustedX86Partial } from '../../js/targets/architecture/x86_64/effects/trusted-decoder-terminal.js';
import { registerReceiverRevalidatedX86Row } from '../../js/targets/architecture/x86_64/receiver-provenance.js';
import { X86_LONG64_DECODER_WITNESSES } from '../../tools/validation/machine-effects/fixtures/x86-long64-decoder-witnesses.mjs';
import { bytesFromX86Long64WitnessHex } from '../../tools/validation/machine-effects/x86-long64-decoder-denominator.mjs';

test('T017 INT witness 238 lifts as exact-with-intrinsic with typed interrupt delivery intrinsic', async () => {
  const witness = X86_LONG64_DECODER_WITNESSES.find(([id]) => id === 238);
  assert.ok(witness, 'INT witness 238 must exist');
  const [id, name, hex] = witness;
  assert.equal(name, 'int');

  const session = await createCapstoneX86Session();
  try {
    const bytes = bytesFromX86Long64WitnessHex(hex);
    const decoded = session.decode(bytes, 0x100000n + BigInt(id) * 0x20n);
    assert.equal(decoded.length, 1);
    const instruction = createX86DecodedInstruction({
      ...decoded[0],
      instructionId:`t017-int-witness:${id}`,
    });

    for (const context of [{}, { closureMatrixTerminal:true }]) {
      const dispatched = dispatchX86MachineEffects(instruction, context);
      assert.equal(dispatched.ownerId, 'control');
      const result = dispatched.result;
      assert.equal(result.completeness, 'exact-with-intrinsic');
      assert.equal(result.controlEffect?.kind, 'indirect');
      assert.equal(result.unknownEffects, undefined);
      assert.equal(result.metadata?.operation, 'int');
      assert.equal(result.metadata?.vector, 0);
      assert.equal(result.metadata?.interruptDeliveryModeled, true);
    }
  } finally {
    session.close();
  }
});

test('T017 negative tests: malformed encoding or operands remain fail-closed', async () => {
  const session = await createCapstoneX86Session();
  try {
    const decoded = session.decode(new Uint8Array([0xcd, 0x80]), 0x400000n);
    assert.equal(decoded.length, 1);
    const instruction = createX86DecodedInstruction({
      ...decoded[0],
      instructionId: 't017-int-negative-missing-state',
    });

    // 1. Valid instruction lifts with typed intrinsic
    const validResult = dispatchX86MachineEffects(instruction, {}).result;
    assert.equal(validResult.completeness, 'exact-with-intrinsic');
    assert.equal(validResult.controlEffect.kind, 'indirect');

    // 2. Mismatched rawBytes vs immediate operand must fail closed
    const mismatchedInstruction = createX86DecodedInstruction({
      ...decoded[0],
      instructionId: 't017-int-negative-mismatched-bytes',
      rawBytes: Uint8Array.of(0xcd, 0x20), // immediate is 0x80, bytes say 0x20
    });
    const mismatchedResult = dispatchX86MachineEffects(mismatchedInstruction, {}).result;
    assert.equal(mismatchedResult.completeness, 'partial');
    assert.equal(mismatchedResult.controlEffect?.kind, 'unknown');
    assert.equal(mismatchedResult.unknownEffects?.reason, 'x86-int-encoding-unmodelled');

    // 3. Invalid operand width must fail closed
    const badWidthInstruction = createX86DecodedInstruction({
      ...decoded[0],
      instructionId: 't017-int-negative-bad-width',
      detail: {
        ...decoded[0].detail,
        operands: [{ ...decoded[0].detail.operands[0], widthBits: 16 }],
      },
    });
    const badWidthResult = dispatchX86MachineEffects(badWidthInstruction, {}).result;
    assert.equal(badWidthResult.completeness, 'partial');
    assert.equal(badWidthResult.controlEffect?.kind, 'unknown');
    assert.equal(badWidthResult.unknownEffects?.reason, 'x86-int-vector-width-unmodelled');
  } finally {
    session.close();
  }
});

test('INT delivery models architectural delivery via typed intrinsic without invented target or trap', async () => {
  const session = await createCapstoneX86Session();
  try {
    const bytes = bytesFromX86Long64WitnessHex('26cd00'); // ES: INT 0
    const decoded = session.decode(bytes, 0x200000n);
    assert.equal(decoded.length, 1);
    const instruction = createX86DecodedInstruction({
      ...decoded[0],
      instructionId: 'int-negative-missing-state:1',
    });

    const direct = liftX86ControlEffects(instruction);
    assert.equal(direct.completeness, 'exact-with-intrinsic');
    assert.equal(direct.controlEffect.kind, 'indirect');
    assert.notEqual(direct.controlEffect.kind, 'trap', 'INT must not be modeled as a simple trap');

    const intrinsicOp = direct.operations.find((op) => op.kind === 'intrinsic');
    assert.ok(intrinsicOp, 'must carry intrinsic operation');
    assert.equal(intrinsicOp.intrinsicId, 'x86.control.interrupt-delivery');
    assert.equal(intrinsicOp.effectSummary.memoryRead.scope, 'all');
    assert.equal(intrinsicOp.effectSummary.memoryWrite.scope, 'all');

    // Public / unbranded dispatch also lifts exact-with-intrinsic
    const publicResult = liftX86MachineEffects(instruction);
    assert.equal(publicResult.completeness, 'exact-with-intrinsic');
  } finally {
    session.close();
  }
});
