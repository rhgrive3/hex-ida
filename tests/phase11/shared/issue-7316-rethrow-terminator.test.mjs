import test from 'node:test';
import assert from 'node:assert/strict';

import { liftCilMethod } from '../../../js/managed/cil/lifter-core.js';
import { lowerVMEffectsToSemanticIr } from '../../../js/managed/shared/bridge-v2.js';

function cilImage() {
  const bytecode = Uint8Array.from([
    0x17,       // 00: ldc.i4.1
    0x16,       // 01: ldc.i4.0
    0x5b,       // 02: div
    0x26,       // 03: pop
    0xde, 0x04, // 04: leave.s -> 0x0a
    0x26,       // 06: pop              (catch exception object)
    0xfe, 0x1a, // 07: rethrow          (terminal)
    0x00,       // 09: nop              (outside handler; must not be fallthrough)
    0x2a,       // 0a: ret              (normal leave target)
  ]);
  return {
    moduleId: 'managed-mod:test',
    vmSpecEdition: 'ecma-335',
    methodBodies: [{
      bytecode,
      codeOffset: 0,
      headerOffset: 0,
      maxStack: 2,
      isTiny: false,
      exceptionClauses: [{
        kind: 'catch',
        tryOffset: 0,
        tryLength: 6,
        handlerOffset: 6,
        handlerLength: 3,
        classTokenOrFilter: 0x01000001,
      }],
    }],
  };
}

function lowered() {
  const effects = liftCilMethod(0, cilImage(), {}, {
    complete: true, methodToken: 0x06000001, signature: { returnValue: null },
  });
  return lowerVMEffectsToSemanticIr(effects);
}

test('#7316 a catch handler ending in rethrow has no normal fallthrough successor', () => {
  const { cfg } = lowered();
  const handler = cfg.blocks.find((block) => block.id === 'bb_0x6');
  assert.ok(handler, 'fixture: the catch handler must be its own block');
  assert.equal(
    handler.successors.some((edge) => edge.kind === 'fallthrough'),
    false,
    'rethrow is a terminal exceptional transfer: no fallthrough to the next block',
  );
});

test('#7316 instructions after rethrow start their own block instead of absorbing into the handler', () => {
  const { cfg } = lowered();
  const nopBlock = cfg.blocks.find((block) => block.id === 'bb_0x9');
  assert.ok(nopBlock, 'the instruction after rethrow must begin a new basic block');
  const handler = cfg.blocks.find((block) => block.id === 'bb_0x6');
  assert.ok(
    !handler.successors.some((edge) => edge.to === 'bb_0x9' && edge.kind !== 'exception'),
    'the handler must not reach the post-rethrow instruction by normal control',
  );
});

test('#7316 rethrow lowers to an explicit exceptional terminator, not a complete barrier', () => {
  const { semanticIr } = lowered();
  const rethrow = semanticIr.nodes.find((node) => node.metadata?.mnemonic === 'rethrow');

  assert.ok(rethrow, 'fixture: the rethrow node must exist');
  assert.equal(rethrow.kind, 'trap', 'rethrow must keep exceptional control identity');
  assert.equal(rethrow.completeness, 'partial',
    'the IR vocabulary cannot represent rethrow losslessly: fail closed to partial');
  assert.equal(rethrow.unknown?.reason, 'managed-rethrow-exception-unrepresented');
  assert.equal(rethrow.metadata?.exceptionRethrow, true);
  assert.equal(rethrow.metadata?.controlEffectKind, 'rethrow');
});

test('#7316 a function containing rethrow is not published as complete', () => {
  const { semanticIr } = lowered();
  assert.equal(semanticIr.completeness, 'partial');
  assert.ok(semanticIr.unknowns.some((unknown) => unknown?.reason === 'managed-rethrow-exception-unrepresented'));
});
