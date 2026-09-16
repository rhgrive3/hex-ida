import assert from 'node:assert/strict';
import test from 'node:test';

import { projectSemanticIrV2ToLegacyV1 } from '../../js/semantics/compat/semantic-ir-v2-to-v1.js';
import { lowerMachineEffectBundleToSemanticIr } from '../../js/semantics/ir/from-machine-effects.js';
import { liftX86MachineEffects } from '../../js/targets/architecture/x86_64/effects/index.js';
import { createCapstoneX86Session } from '../phase5/helpers/capstone-session.mjs';

function one(session, bytes, address = 0x520000n) {
  const decoded = session.decode(Uint8Array.from(bytes), address);
  assert.equal(decoded.length, 1);
  assert.equal(decoded[0].length, bytes.length);
  return decoded[0];
}

test('BSF undefined-result contract survives MachineEffects -> Semantic IR v2 -> legacy v1 projection', async () => {
  const session = await createCapstoneX86Session();
  try {
    const decoded = one(session, [0x0f, 0xbc, 0xc3]);
    const bundle = liftX86MachineEffects({ ...decoded, instructionId:'t017-compat-bsf' });
    const producer = bundle.operations.find((operation) => operation.undefinedResult?.class === 'conditional');
    assert.ok(producer, 'BSF must publish one conditional undefined-result producer');

    const semantic = lowerMachineEffectBundleToSemanticIr(bundle, {
      functionId:'t017-compat-function',
      blockId:'entry',
      entryBlockId:'entry',
      addressWidthBits:64,
    });
    const projected = projectSemanticIrV2ToLegacyV1(semantic);
    const carriers = projected.instructions.filter((instruction) => instruction.extra?.undefinedResult != null);
    assert.equal(carriers.length, 1, 'compat projection must preserve exactly one undefined-result carrier');
    assert.deepEqual(carriers[0].extra.undefinedResult, producer.undefinedResult);
    assert.equal(carriers[0].extra.undefinedResult.condition.operandIndex, 0);
    assert.equal(carriers[0].extra.undefinedResult.reason, 'x86-bsf-source-zero-destination-undefined');
  } finally {
    session.close();
  }
});
