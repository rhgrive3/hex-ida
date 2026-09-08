import assert from 'node:assert/strict';
import test from 'node:test';

import { liftCilMethod } from '../../../js/managed/cil/lifter-core.js';
import { validateCilEffectFunction } from '../../../js/managed/cil/validation.js';
import { lowerVMEffectsToSemanticIr } from '../../../js/managed/shared/bridge-v2.js';

// #7476: `endfinally` (0xDC, shared with `endfault`) transfers control back to
// the CLI exception mechanism (ECMA-335 III.3.35). The bridge used to miss it
// in its terminator coverage, so the instruction after the handler stayed in
// the same basic block as an executable successor and the unwind itself was
// published as a *complete* generic barrier.

function finallyImage({ handlerKind = 'finally' } = {}) {
  const bytecode = Uint8Array.from([
    0x14, // 00: ldnull
    0x7a, // 01: throw
    0xdc, // 02: endfinally / endfault (handler [02,03))
    0x2a, // 03: ret — outside the handler, unreachable on the unwind path
  ]);
  return {
    moduleId: 'managed-mod:test',
    vmSpecEdition: 'ecma-335',
    methodBodies: [{
      bytecode,
      codeOffset: 0,
      headerOffset: 0,
      maxStack: 1,
      isTiny: false,
      exceptionClauses: [{
        kind: handlerKind,
        tryOffset: 0,
        tryLength: 2,
        handlerOffset: 2,
        handlerLength: 1,
        classTokenOrFilter: 0,
      }],
    }],
  };
}

function loweredFor(handlerKind) {
  const effects = liftCilMethod(0, finallyImage({ handlerKind }), {}, {
    complete: true,
    methodToken: 0x06000001,
    signature: { returnValue: null },
  });
  const validation = validateCilEffectFunction(effects);
  const lowered = lowerVMEffectsToSemanticIr(effects);
  return { effects, validation, lowered };
}

const blockOf = (lowered, offset) => {
  const hex = `0x${offset.toString(16)}`;
  return lowered.semanticIr.nodes.filter((node) => node.blockId === `bb_${hex}`);
};

for (const handlerKind of ['finally', 'fault']) {
  test(`#7476 ${handlerKind}: endfinally is a terminator, not a fallthrough barrier`, () => {
    const { effects, validation, lowered } = loweredFor(handlerKind);

    const bundle = effects.bundles.find((item) => item.bytecodeOffset === 2);
    assert.equal(bundle.controlEffects[0].kind, 'endfinally');
    assert.equal(bundle.completeness, 'exact');
    assert.equal(validation.status, 'valid');

    // The post-handler ret must live outside the handler's block: here the
    // ret ends the method, so no further block is required — but it may not
    // share bb_0x2 with the unwind, and the handler must not fall through.
    const retNode = lowered.semanticIr.nodes.find((node) => node.kind === 'return');
    assert.ok(retNode, 'ret node exists');
    assert.notEqual(retNode.blockId, 'bb_0x2');
    const handlerBlock = lowered.cfg.blocks.find((block) => block.id === 'bb_0x2');
    assert.deepEqual(handlerBlock.successors.filter((edge) => edge.kind === 'fallthrough'), []);

    // The unwind itself degrades to a partial trap, never a complete barrier.
    const unwind = blockOf(lowered, 2).find((node) => node.metadata?.mnemonic === 'endfinally');
    assert.ok(unwind, 'endfinally node exists');
    assert.equal(unwind.kind, 'trap');
    assert.equal(unwind.completeness, 'partial');
    assert.equal(unwind.unknown?.reason, 'managed-endfinally-exception-unrepresented');
    assert.equal(unwind.metadata?.exceptionUnwind, true);
  });
}

test('#7476 the whole lowered function is partial while the unwind is unrepresentable', () => {
  const { lowered } = loweredFor('finally');
  assert.equal(lowered.semanticIr.completeness, 'partial');
});
