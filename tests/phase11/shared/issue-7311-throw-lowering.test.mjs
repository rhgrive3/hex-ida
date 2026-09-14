import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createManagedMethodId,
  createVMOperationId,
  createVMEffectBundle,
  createVMEffectFunction,
  buildManagedMethodSummary,
  decompileManagedMethod,
  lowerVMEffectsToSemanticIr,
} from '../../../js/managed/index.js';

// #7311: the shared bridge collapsed an explicit VM `throw` (which carries the
// thrown exception operand) into the same Semantic IR `trap` kind as a runtime
// trap, published the function as `complete`, and the decompiler fabricated
// `throw Exception();` for both. The lowering now keeps the throw identity in
// node metadata with the operand as its input, fails closed to `partial` until
// Semantic IR gains a dedicated `throw` kind, and the summary/decompiler
// preserve the thrown value.

function fixture(bundles, { frontendId = 'jvm', exceptionRegions = [] } = {}) {
  const methodId = createManagedMethodId('mod-7311', 'f');
  return createVMEffectFunction({
    methodId,
    frontendId,
    bundles: bundles.map((bundle, index) => createVMEffectBundle({
      frontendId,
      methodId,
      operationId: createVMOperationId(methodId, index * 2),
      bytecodeOffset: index * 2,
      ...bundle,
    })),
    exceptionRegions,
    aggregateCompleteness: 'exact',
  });
}

const ACONST = {
  mnemonic: 'aconst_null',
  producedValues: [{ bits: 32 }],
  completeness: 'exact',
};
const ATHROW = {
  mnemonic: 'athrow',
  consumedValues: [{ id: 'exception', bits: 32 }],
  controlEffects: [{ kind: 'throw' }],
  completeness: 'exact',
};
const TRAP = {
  mnemonic: 'athrow_trap',
  controlEffects: [{ kind: 'trap' }],
  completeness: 'exact',
};

test('#7311 an explicit throw keeps its operand and fails closed to partial', () => {
  const lowered = lowerVMEffectsToSemanticIr(fixture([ACONST, ATHROW]));
  const throwOp = createVMOperationId(lowered.methodId, 2);
  const node = lowered.semanticIr.nodes.find((n) => n.sourceEffectIds?.includes(throwOp));

  assert.equal(node.kind, 'trap', 'the only representable exceptional node kind is still trap');
  assert.equal(node.inputs.length, 1, 'the thrown exception operand must ride as the node input');
  assert.equal(node.metadata?.exceptionThrow, true, 'the language-throw identity must survive lowering');
  assert.equal(node.completeness, 'partial', 'the lowering is not allowed to claim completeness');
  assert.equal(node.unknown?.reason, 'managed-throw-exception-unrepresented');
  assert.equal(lowered.semanticIr.completeness, 'partial', 'the function must not publish complete');
  assert.ok(lowered.semanticIr.unknowns.some((u) => u.reason === 'managed-throw-exception-unrepresented'));
});

test('#7311 a true runtime trap stays complete and unmarked', () => {
  const lowered = lowerVMEffectsToSemanticIr(fixture([TRAP]));
  const trapOp = createVMOperationId(lowered.methodId, 0);
  const node = lowered.semanticIr.nodes.find((n) => n.sourceEffectIds?.includes(trapOp));

  assert.equal(node.kind, 'trap');
  assert.notEqual(node.metadata?.exceptionThrow, true, 'a runtime trap is not a language throw');
  assert.equal(node.completeness, 'complete');
  assert.equal(lowered.semanticIr.completeness, 'complete');
});

test('#7311 the summary records the thrown value instead of a generic trap', () => {
  const lowered = lowerVMEffectsToSemanticIr(fixture([ACONST, ATHROW]));
  const node = lowered.semanticIr.nodes.find((n) => n.metadata?.exceptionThrow === true);
  const summary = buildManagedMethodSummary(lowered);

  assert.deepEqual(summary.thrownExceptions, [{
    kind: 'throw',
    nodeId: node.id,
    thrownValueId: node.inputs[0],
  }]);
  assert.equal(summary.completeness, 'partial', 'a language throw keeps the summary honest');
});

test('#7311 the summary keeps a runtime trap generic and complete', () => {
  const lowered = lowerVMEffectsToSemanticIr(fixture([TRAP]));
  const summary = buildManagedMethodSummary(lowered);

  assert.deepEqual(summary.thrownExceptions, [{
    kind: 'trap',
    nodeId: summary.thrownExceptions[0].nodeId,
    thrownValueId: null,
  }]);
  assert.equal(summary.completeness, 'complete');
});

test('#7311 the decompiler renders the thrown operand for a language throw', () => {
  const lowered = lowerVMEffectsToSemanticIr(fixture([ACONST, ATHROW]));
  const decompiled = decompileManagedMethod(lowered);
  const text = JSON.stringify(decompiled);

  assert.ok(text.includes('throw ') && !text.includes('throw Exception();'),
    `the thrown operand must be rendered, got ${text}`);
});

test('#7311 the decompiler keeps the fabricated form for a runtime trap', () => {
  const lowered = lowerVMEffectsToSemanticIr(fixture([TRAP]));
  const decompiled = decompileManagedMethod(lowered);
  const text = JSON.stringify(decompiled);

  assert.ok(text.includes('throw Exception();'), 'a runtime trap keeps the generic rendering');
});

test('#7311 a DEX throw is likewise preserved and incomplete', () => {
  // DEX operands are register reads, not stack pops: the thrown exception
  // arrives as a locationRead, which must ride as the node input.
  const lowered = lowerVMEffectsToSemanticIr(fixture([
    {
      mnemonic: 'throw',
      locationReads: [{ kind: 'register', index: 0, type: { kind: 'address', widthBits: 32 } }],
      controlEffects: [{ kind: 'throw' }],
      completeness: 'exact',
    },
  ], { frontendId: 'dex' }));
  const node = lowered.semanticIr.nodes.find((n) => n.metadata?.exceptionThrow === true);

  assert.ok(node, 'the DEX throw must carry the language-throw marker');
  assert.equal(node.inputs.length, 1, 'the register operand rides as the thrown value');
  assert.equal(lowered.semanticIr.completeness, 'partial');
  const summary = buildManagedMethodSummary(lowered);
  assert.equal(summary.thrownExceptions[0].kind, 'throw');
  assert.equal(summary.thrownExceptions[0].thrownValueId, node.inputs[0]);
});
