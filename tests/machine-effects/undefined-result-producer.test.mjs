import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createMachineOperation,
  createTemporaryValue,
  serializeMachineEffectBundle,
} from '../../js/semantics/effects/index.js';
import { projectSemanticIrV2ToLegacyV1 } from '../../js/semantics/compat/semantic-ir-v2-to-v1.js';
import { lowerMachineEffectBundleToSemanticIr } from '../../js/semantics/ir/from-machine-effects.js';
import { liftX86MachineEffects } from '../../js/targets/architecture/x86_64/effects/index.js';
import { createCapstoneX86Session } from '../phase5/helpers/capstone-session.mjs';

test('real x86 DIV producer retains fully undefined flags through canonical and compatibility paths', async () => {
  const session = await createCapstoneX86Session();
  try {
    const [decoded] = session.decode(Uint8Array.of(0x48, 0xf7, 0xf3), 0x1000n); // div rbx
    const bundle = liftX86MachineEffects({ ...decoded, instructionId: 'me01:x86-div' });
    const sources = bundle.operations.filter((operation) => operation.kind === 'intrinsic'
      && operation.intrinsicId.startsWith('x86.flag.undefined.'));
    assert.equal(sources.length, 6);
    assert.ok(sources.every((operation) => operation.undefinedResult?.class === 'fully'
      && operation.undefinedResult.mask === '0x1'));

    const serialized = JSON.parse(serializeMachineEffectBundle(bundle));
    assert.deepEqual(serialized.operations.filter((operation) => operation.undefinedResult).map((operation) => operation.undefinedResult),
      sources.map((operation) => operation.undefinedResult));

    const semantic = lowerMachineEffectBundleToSemanticIr(bundle, { functionId: 'me01-x86-div', blockId: 'entry', addressWidthBits: 64 });
    const maskedNodes = semantic.nodes.filter((node) => node.attributes?.machineEffects?.undefinedResult);
    assert.equal(maskedNodes.length, 6);
    const legacy = projectSemanticIrV2ToLegacyV1(semantic);
    const projectedMasks = legacy.instructions.filter((instruction) => instruction.extra?.undefinedResult);
    assert.equal(projectedMasks.length, 6);
    assert.ok(projectedMasks.every((instruction) => instruction.op === 'unknown'));
  } finally {
    session.close();
  }
});

test('named exceptional and unsupported conditions never carry a guessed concrete result', () => {
  const cases = [
    ['divide-by-zero', 'conditional', { kind: 'divisor-zero', operand: 'divisor' }],
    ['signed-overflow', 'conditional', { kind: 'signed-quotient-overflow', operand: 'dividend-divisor' }],
    ['shift-count-width-boundary', 'operand-dependent', { kind: 'count-at-least-width', operand: 'count' }],
    ['unsupported-operand-form', 'fully', null],
    ['unknown-effect', 'partial', null],
  ];
  for (const [reason, resultClass, condition] of cases) {
    const widthBits = 32;
    const operation = createMachineOperation({
      kind: 'value', opcode: 'architectural-boundary', inputs: [],
      outputs: [createTemporaryValue(`me01-${reason}`, { kind: 'bitvector', widthBits })],
      undefinedResult: {
        widthBits,
        mask: resultClass === 'partial' ? '0xffff0000' : '0xffffffff',
        class: resultClass,
        reason,
        ...(condition == null ? {} : { condition }),
      },
    });
    assert.equal(operation.undefinedResult.reason, reason);
    assert.equal('value' in operation.undefinedResult, false);
  }
});
