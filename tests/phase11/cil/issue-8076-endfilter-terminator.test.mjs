import assert from 'node:assert/strict';
import test from 'node:test';

import { liftCilMethod } from '../../../js/managed/cil/lifter-core.js';
import { validateCilEffectFunction } from '../../../js/managed/cil/validation.js';
import { lowerVMEffectsToSemanticIr } from '../../../js/managed/shared/bridge-lowering-v2.js';

// #8076: the CIL frontend and validator keep `endfilter` (FE 11) as a terminal
// control effect, but the shared bridge treated `kind:'endfilter'` as a generic
// complete barrier and emitted a normal fallthrough edge from the filter block
// to the handler. `endfilter` returns the filter decision to the CLI exception
// mechanism; sequential execution into the handler is not a legal transfer.

function buildFilterImage() {
  return {
    moduleId: 'managed-mod:issue-8076',
    vmSpecEdition: 'ecma-335',
    methodBodies: [{
      bytecode: Uint8Array.from([
        0xde, 0x07, // 00: leave.s -> 09   (normal try exit)
        0x26,       // 02: pop             (filter entry: exception object)
        0x17,       // 03: ldc.i4.1        (filter accepts)
        0xfe, 0x11, // 04: endfilter       (terminal filter decision)
        0x26,       // 06: pop             (handler entry: exception object)
        0xde, 0x00, // 07: leave.s -> 09
        0x2a,       // 09: ret
      ]),
      codeOffset: 0,
      headerOffset: 0,
      maxStack: 1,
      isTiny: false,
      exceptionClauses: [{
        kind: 'filter',
        tryOffset: 0,
        tryLength: 2,
        handlerOffset: 6,
        handlerLength: 3,
        classTokenOrFilter: 2, // FilterOffset
      }],
    }],
  };
}

function lowerFilterFixture() {
  const image = buildFilterImage();
  const effects = liftCilMethod(0, image, {}, {
    complete: true,
    methodToken: 0x06000001,
    signature: { returnValue: null },
  });
  const validation = validateCilEffectFunction(effects);
  const lowered = lowerVMEffectsToSemanticIr(effects);
  return { effects, validation, lowered };
}

test('#8076 endfilter lowers to an exceptional trap, not a complete barrier', () => {
  const { lowered } = lowerFilterFixture();
  const endfilterNode = lowered.semanticIr.nodes.find((n) => n.metadata?.mnemonic === 'endfilter');
  assert.ok(endfilterNode, 'endfilter node must exist in the Semantic IR');
  assert.equal(endfilterNode.kind, 'trap');
  assert.equal(endfilterNode.completeness, 'partial');
  assert.equal(endfilterNode.unknown?.reason, 'managed-endfilter-exception-unrepresented');
  assert.equal(endfilterNode.metadata?.exceptionFilterDecision, true);
  assert.equal(endfilterNode.metadata?.controlEffectKind, 'endfilter');
});

test('#8076 the filter block has no fallthrough edge into the handler', () => {
  const { lowered } = lowerFilterFixture();
  const filterBlock = lowered.cfg.blocks.find((b) => b.id === 'bb_0x2');
  assert.ok(filterBlock, 'filter block (endfilter at offset 4, leader 0x2) must exist');
  const fallthrough = (filterBlock.successors ?? []).filter((s) => s.kind === 'fallthrough');
  assert.deepEqual(fallthrough, []);
});

test('#8076 the filter decision degrades the function aggregate', () => {
  const { lowered, validation } = lowerFilterFixture();
  assert.equal(lowered.semanticIr.completeness, 'partial');
  const reasons = (lowered.semanticIr.unknowns ?? []).map((u) => u.reason);
  assert.ok(reasons.includes('managed-endfilter-exception-unrepresented'));
  assert.equal(validation.status, 'valid');
});

test('#8076 the normal try-exit path keeps its leave transfer', () => {
  const { lowered } = lowerFilterFixture();
  const leaveNode = lowered.semanticIr.nodes.find((n) => n.metadata?.mnemonic === 'leave.s' && n.blockId === 'bb_0x0');
  assert.ok(leaveNode, 'leave node in the try block must exist');
  assert.ok((leaveNode.targets ?? []).includes('bb_0x9'), 'leave must keep its branch target');
});
