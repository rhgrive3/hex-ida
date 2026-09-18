import assert from 'node:assert/strict';
import test from 'node:test';

import { createCapstoneX86Session } from '../phase5/helpers/capstone-session.mjs';
import { createX86DecodedInstruction } from '../../js/targets/architecture/x86_64/decoded-instruction.js';
import { dispatchX86MachineEffects } from '../../js/targets/architecture/x86_64/effects/index.js';
import { X86_LONG64_DECODER_WITNESSES } from '../../tools/validation/machine-effects/fixtures/x86-long64-decoder-witnesses.mjs';
import { bytesFromX86Long64WitnessHex } from '../../tools/validation/machine-effects/x86-long64-decoder-denominator.mjs';

test('T017 validation context cannot invent INT delivery state', async () => {
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
      assert.equal(result.completeness, 'partial', 'validation context is not delivery-state authority');
      assert.equal(result.controlEffect?.kind, 'unknown');
      assert.equal(result.unknownEffects?.reason, 'x86-int-delivery-state-unmodelled');
      assert.equal(result.metadata?.terminalizedBy, undefined);
    }
  } finally {
    session.close();
  }
});
