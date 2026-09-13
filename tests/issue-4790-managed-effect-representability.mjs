import assert from 'node:assert/strict';

import { lowerVMEffectsToSemanticIr } from '../js/managed/shared/bridge-v2.js';
import { createVMEffectBundle, createVMEffectFunction } from '../js/managed/shared/vm-effects.js';

const REASON = 'managed-effect-shape-unrepresentable';
const methodId = 'managed-method:issue-4790';
const knownSummary = Object.freeze({ completeness: 'complete' });
const addressRead = Object.freeze({ kind: 'local', index: 1, bits: 32 });
const memRead = Object.freeze({ isWrite: false, space: 'memory', byteWidth: 4 });
const memWrite = Object.freeze({ isWrite: true, space: 'memory', byteWidth: 4 });
const callA = Object.freeze({ target: 'callee-A', dispatchKind: 'direct', effectSummary: knownSummary });
const callB = Object.freeze({ target: 'callee-B', dispatchKind: 'direct', effectSummary: knownSummary });

function bundle(over) {
  return createVMEffectBundle({
    frontendId: 'wasm',
    methodId,
    operationId: `vm-op:${over.bytecodeOffset ?? 0}`,
    bytecodeOffset: 0,
    mnemonic: 'synthetic',
    completeness: 'exact',
    ...over,
  });
}

function fn(bundles) {
  return createVMEffectFunction({ frontendId: 'wasm', methodId, aggregateCompleteness: 'exact', bundles });
}

const unknownsOf = (lowered) => lowered.semanticIr.unknowns ?? [];
const categoriesOf = (lowered, reason) => {
  const entry = unknownsOf(lowered).find((u) => u?.reason === reason);
  return entry ? [...(entry.categories ?? [])].sort() : null;
};
const kindsOf = (lowered) => lowered.semanticIr.nodes.map((node) => node.kind);

{
  const lowered = lowerVMEffectsToSemanticIr(fn([bundle({
    bytecodeOffset: 0,
    mnemonic: 'synthetic-multi-call',
    locationReads: [addressRead],
    callEffects: [callA, callB],
  })]));
  assert.notEqual(lowered.semanticIr.completeness, 'complete',
    '#4790 two callEffects must not silently collapse to one on an exact bundle');
  assert.ok(unknownsOf(lowered).some((u) => u?.reason === REASON),
    '#4790 the collapsed callEffects must leave an unknown reason');
  assert.ok(categoriesOf(lowered, REASON)?.includes('calls'),
    '#4790 the unknown must be attributed to the calls category');
  assert.ok(kindsOf(lowered).includes('call'), '#4790 the primary call effect must still be lowered');
}

{
  const lowered = lowerVMEffectsToSemanticIr(fn([
    bundle({ bytecodeOffset: 0, mnemonic: 'synthetic-multi-control', controlEffects: [{ kind: 'branch', targetOffset: 2 }, { kind: 'return' }] }),
    bundle({ bytecodeOffset: 2, mnemonic: 'synthetic-return', controlEffects: [{ kind: 'return' }] }),
  ]));
  assert.notEqual(lowered.semanticIr.completeness, 'complete',
    '#4790 two controlEffects must not silently collapse to one on an exact bundle');
  assert.ok(categoriesOf(lowered, REASON)?.includes('control'),
    '#4790 the collapsed controlEffects must be attributed to the control category');
}

{
  const lowered = lowerVMEffectsToSemanticIr(fn([bundle({
    bytecodeOffset: 0,
    mnemonic: 'synthetic-memory-plus-call',
    locationReads: [addressRead],
    memoryEffects: [memRead],
    callEffects: [callA],
  })]));
  assert.notEqual(lowered.semanticIr.completeness, 'complete',
    '#4790 a memory category must not silently win over a call category');
  const categories = categoriesOf(lowered, REASON) ?? [];
  assert.ok(categories.includes('memory') && categories.includes('calls'),
    `#4790 every present category must be recorded, got ${JSON.stringify(categories)}`);
  assert.ok(kindsOf(lowered).includes('load'), '#4790 the selected memory effect must still be lowered');
}

{
  const lowered = lowerVMEffectsToSemanticIr(fn([bundle({
    bytecodeOffset: 0,
    mnemonic: 'synthetic-control-plus-call',
    controlEffects: [{ kind: 'return' }],
    callEffects: [callA],
  })]));
  assert.notEqual(lowered.semanticIr.completeness, 'complete',
    '#4790 a control category must not silently win over a call category');
  const categories = categoriesOf(lowered, REASON) ?? [];
  assert.ok(categories.includes('control') && categories.includes('calls'),
    `#4790 every present category must be recorded, got ${JSON.stringify(categories)}`);
}

{
  const singleCall = lowerVMEffectsToSemanticIr(fn([bundle({ bytecodeOffset: 0, mnemonic: 'synthetic-call', locationReads: [addressRead], callEffects: [callA] })]));
  assert.equal(singleCall.semanticIr.completeness, 'complete', '#4790 a single call effect stays non-regressive');
  const singleMemory = lowerVMEffectsToSemanticIr(fn([bundle({ bytecodeOffset: 0, mnemonic: 'synthetic-load', locationReads: [addressRead], memoryEffects: [memRead] })]));
  assert.equal(singleMemory.semanticIr.completeness, 'complete', '#4790 a single memory effect stays non-regressive');
  const singleControl = lowerVMEffectsToSemanticIr(fn([bundle({ bytecodeOffset: 0, mnemonic: 'synthetic-return', controlEffects: [{ kind: 'return' }] })]));
  assert.equal(singleControl.semanticIr.completeness, 'complete', '#4790 a single control effect stays non-regressive');
}

{
  const multiMemory = lowerVMEffectsToSemanticIr(fn([bundle({
    bytecodeOffset: 0,
    mnemonic: 'synthetic-multi-memory',
    locationReads: [addressRead],
    memoryEffects: [memRead, memWrite],
  })]));
  assert.equal(multiMemory.semanticIr.completeness, 'complete',
    '#4790 multi memoryEffects share the #4731 representable policy and must not regress');
  assert.deepEqual(kindsOf(multiMemory).filter((kind) => kind === 'load' || kind === 'store'), ['load', 'store'],
    '#4790 every memory effect must still lower to its own node');
}

console.log('issue #4790 managed bridge multi-effect/multi-category representability: PASS');
