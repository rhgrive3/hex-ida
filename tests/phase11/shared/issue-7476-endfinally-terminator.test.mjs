import test from 'node:test';
import assert from 'node:assert/strict';

import { liftCilMethod } from '../../../js/managed/cil/lifter-core.js';
import { validateCilEffectFunction } from '../../../js/managed/cil/validation.js';
import { lowerVMEffectsToSemanticIr } from '../../../js/managed/shared/bridge-v2.js';

// #7476 — `endfinally` (opcode 0xDC, alias `endfault`) transfers control back
// to the CLI exception mechanism (ECMA-335 III.3.35): falling out of a
// finally/fault block is not legal. The CIL frontend and validator already
// treat it as a terminal control effect, but the shared bridge did not — the
// instruction physically after `endfinally` stayed inside the handler's
// executable sequence and the unwind transfer was published as a *complete*
// generic barrier. It must be a block terminator with an explicit
// partial/unknown unwind representation, exactly like the rethrow treatment.

function cilImage({ clauseKind = 'finally', leadByte = 0x14 } = {}) {
  // 00: ldnull      (try)
  // 01: throw       (try — always throws; ret is unreachable on every path)
  // 02: endfinally  (handler [2,3))
  // 03: ret         (outside the handler; must not share the handler block)
  const bytecode = Uint8Array.from([leadByte, 0x7a, 0xdc, 0x2a]);
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
        kind: clauseKind,
        tryOffset: 0,
        tryLength: 2,
        handlerOffset: 2,
        handlerLength: 1,
        classTokenOrFilter: 0,
      }],
    }],
  };
}

function lowered(options = {}) {
  const effects = liftCilMethod(0, cilImage(options), {}, {
    complete: true, methodToken: 0x06000001, signature: { returnValue: null },
  });
  return { effects, lowered: lowerVMEffectsToSemanticIr(effects) };
}

test('#7476 the endfinally bundle keeps its exact terminal control effect upstream', () => {
  const { effects } = lowered();
  const bundle = effects.bundles.find((b) => b.mnemonic === 'endfinally');
  assert.ok(bundle, 'fixture: the endfinally bundle must exist');
  assert.deepEqual(bundle.controlEffects, [{ kind: 'endfinally' }]);
  assert.equal(bundle.completeness, 'exact');
});

test('#7476 the validator keeps treating endfinally as a terminal', () => {
  const { effects } = lowered();
  const validation = validateCilEffectFunction(effects);
  assert.equal(validation.status, 'valid');
  assert.equal(validation.completeness.specValidation, 'valid');
  assert.deepEqual(validation.errors, []);
});

test('#7476 the instruction after endfinally starts its own basic block', () => {
  const { lowered: loweredIr } = lowered();
  const ret = loweredIr.semanticIr.nodes.find((node) => node.metadata?.mnemonic === 'ret');
  const endfinally = loweredIr.semanticIr.nodes.find((node) => node.metadata?.mnemonic === 'endfinally');
  assert.ok(ret && endfinally, 'fixture: both nodes must exist');
  assert.notEqual(ret.blockId, endfinally.blockId,
    'post-handler ret must not share the handler executable sequence');
  assert.ok(loweredIr.cfg.blocks.some((block) => block.id === 'bb_0x3'),
    'the ret offset must be a block start');
});

test('#7476 the finally handler block has no normal fallthrough successor', () => {
  const { lowered: loweredIr } = lowered();
  const handler = loweredIr.cfg.blocks.find((block) => block.id === 'bb_0x2');
  assert.ok(handler, 'fixture: the handler must be its own block');
  assert.deepEqual(handler.successors, [],
    'endfinally returns control to the CLI exception mechanism: no normal edges');
});

test('#7476 endfinally lowers to an explicit unwind terminator, not a complete barrier', () => {
  const { lowered: loweredIr } = lowered();
  const endfinally = loweredIr.semanticIr.nodes.find((node) => node.metadata?.mnemonic === 'endfinally');
  assert.equal(endfinally.kind, 'trap', 'endfinally must keep terminal control identity');
  assert.equal(endfinally.completeness, 'partial',
    'the IR vocabulary cannot represent the unwind losslessly: fail closed to partial');
  assert.equal(endfinally.unknown?.reason, 'cil-endfinally-unwind-unrepresented');
  assert.equal(endfinally.metadata?.endfinally, true);
  assert.equal(endfinally.metadata?.controlEffectKind, 'endfinally');
});

test('#7476 a function containing endfinally is not published as complete', () => {
  const { lowered: loweredIr } = lowered();
  assert.equal(loweredIr.semanticIr.completeness, 'partial');
  assert.ok(loweredIr.semanticIr.unknowns.some(
    (unknown) => unknown?.reason === 'cil-endfinally-unwind-unrepresented'));
});

test('#7476 a fault clause lowered through the same opcode gets the same treatment', () => {
  const { lowered: loweredIr } = lowered({ clauseKind: 'fault' });
  const endfinally = loweredIr.semanticIr.nodes.find((node) => node.metadata?.mnemonic === 'endfinally');
  assert.ok(endfinally, 'fixture: the fault handler still ends with opcode 0xDC');
  assert.equal(endfinally.kind, 'trap');
  assert.equal(endfinally.completeness, 'partial');
  const ret = loweredIr.semanticIr.nodes.find((node) => node.metadata?.mnemonic === 'ret');
  assert.notEqual(ret.blockId, endfinally.blockId);
});

test('#7476 every non-rethrow managed terminal recognized by the validator is bridge-covered', () => {
  // Invariant: the bridge must not silently fall through any terminal control
  // kind the CIL validator already treats as terminal (return/throw/rethrow
  // are pre-existing bridge cases; endfinally is the #7476 addition).
  for (const kind of ['return', 'throw', 'rethrow', 'endfinally']) {
    const image = cilImage();
    const effects = liftCilMethod(0, image, {}, {
      complete: true, methodToken: 0x06000001, signature: { returnValue: null },
    });
    const terminalBundle = effects.bundles.find((b) => (b.controlEffects || []).some((e) => e.kind === kind));
    if (!terminalBundle) continue;
    const loweredIr = lowerVMEffectsToSemanticIr(effects);
    const handlerStart = loweredIr.cfg.blocks.find((block) => block.id === 'bb_0x2');
    assert.ok(handlerStart, `fixture: ${kind} handler must be a block`);
    assert.equal(handlerStart.successors.some((edge) => edge.kind === 'fallthrough'), false,
      `${kind} must be a bridge terminal: no fabricated fallthrough out of its block`);
  }
});
