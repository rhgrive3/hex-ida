import assert from 'node:assert/strict';
import {
  createManagedMethodId,
  createVMOperationId,
  createVMEffectBundle,
  createVMEffectFunction,
  decompileManagedMethod,
  lowerVMEffectsToSemanticIr,
} from '../../../js/managed/index.js';

console.log('[phase11] running #4023 managed unary fail-closed regression...');

function unaryFunction(mnemonic, constant = 8, bits = 32) {
  const methodId = createManagedMethodId('wasm', 4023, mnemonic);
  const bundle = (offset, name, consumedValues = [], producedValues = []) => createVMEffectBundle({
    frontendId: 'wasm',
    methodId,
    operationId: createVMOperationId(methodId, offset),
    bytecodeOffset: offset,
    mnemonic: name,
    consumedValues,
    producedValues,
    completeness: 'exact',
  });
  return createVMEffectFunction({
    frontendId: 'wasm',
    methodId,
    bundles: [
      bundle(0, `${bits === 64 ? 'i64' : 'i32'}.const`, [], [{ bits, constant }]),
      bundle(1, mnemonic, [{ id: 'arg', bits }], [{ bits }]),
      createVMEffectBundle({
        frontendId: 'wasm',
        methodId,
        operationId: createVMOperationId(methodId, 2),
        bytecodeOffset: 2,
        mnemonic: 'return',
        consumedValues: [{ id: 'result', bits }],
        controlEffects: [{ kind: 'return' }],
        completeness: 'exact',
      }),
    ],
    aggregateCompleteness: 'exact',
  });
}

for (const [mnemonic, operator, value, bits] of [
  ['i32.clz', 'clz', 1, 32],
  ['i64.clz', 'clz', 1, 64],
  ['i32.ctz', 'ctz', 8, 32],
  ['i64.ctz', 'ctz', 8, 64],
  ['i32.popcnt', 'popcnt', 0xf0, 32],
  ['i64.popcnt', 'popcnt', 0xf0, 64],
]) {
  const fn = unaryFunction(mnemonic, value, bits);
  const lowered = lowerVMEffectsToSemanticIr(fn);
  const unaryNode = lowered.semanticIr.nodes.find((node) => node.metadata?.mnemonic === mnemonic);
  assert.equal(unaryNode?.kind, 'unary');
  assert.equal(unaryNode?.operator, null,
    `${mnemonic} has no canonical operator claim in the current VM-effect lowering contract`);

  const decompiled = decompileManagedMethod(fn);
  assert.match(decompiled.pseudocode, new RegExp(`\\b${operator}\\(`),
    `${mnemonic} must not be rendered as a truncation`);
  assert.doesNotMatch(decompiled.pseudocode, /\(uint(?:32|64)_t\)/,
    `${mnemonic} must not be laundered into a concrete truncation cast`);
}


// The issue's concrete counterexamples stay distinguishable from truncation.
// These reference values pin why substituting a width-preserving cast is unsound.
assert.equal(Math.clz32(1), 31);
const ctz32 = (value) => {
  const word = value >>> 0;
  return word === 0 ? 32 : 31 - Math.clz32((word & -word) >>> 0);
};
const popcnt32 = (value) => {
  let word = value >>> 0;
  let count = 0;
  while (word) { word &= word - 1; count++; }
  return count;
};
assert.equal(ctz32(8), 3);
assert.equal(popcnt32(0xf0), 4);

// A canonical Semantic IR operator is stronger authority than a mnemonic. If
// a producer has actually proven truncation, preserve it as a concrete cast.
{
  const lowered = lowerVMEffectsToSemanticIr(unaryFunction('i32.proven_conversion', 0x1234));
  const semanticIr = {
    ...lowered.semanticIr,
    nodes: lowered.semanticIr.nodes.map((node) => node.metadata?.mnemonic === 'i32.proven_conversion'
      ? { ...node, operator: 'trunc' }
      : node),
  };
  const decompiled = decompileManagedMethod({ ...lowered, semanticIr });
  assert.match(decompiled.pseudocode, /\(uint32_t\)0x1234|\(uint32_t\)4660/,
    'an explicitly proven canonical trunc operator must retain truncation semantics');
}

// Conflicting canonical/mnemonic evidence must not choose either concrete
// meaning. In particular, a stale `trunc` claim cannot override known clz.
{
  const lowered = lowerVMEffectsToSemanticIr(unaryFunction('i32.clz', 1));
  const semanticIr = {
    ...lowered.semanticIr,
    nodes: lowered.semanticIr.nodes.map((node) => node.metadata?.mnemonic === 'i32.clz'
      ? { ...node, operator: 'trunc' }
      : node),
  };
  const decompiled = decompileManagedMethod({ ...lowered, semanticIr });
  assert.match(decompiled.pseudocode, /i32\.clz\(1\)/,
    'conflicting unary authority must fail closed to an explicit intrinsic');
  assert.doesNotMatch(decompiled.pseudocode, /\(uint32_t\)/,
    'a conflicting trunc operator must not launder clz into a cast');
}

{
  const fn = unaryFunction('i32.future_unary', 7);
  const lowered = lowerVMEffectsToSemanticIr(fn);
  const unaryNode = lowered.semanticIr.nodes.find((node) => node.metadata?.mnemonic === 'i32.future_unary');
  assert.equal(unaryNode?.kind, 'unary');
  assert.equal(unaryNode?.operator, null, 'unknown unary semantics must not invent a canonical operator');

  const decompiled = decompileManagedMethod(fn);
  assert.match(decompiled.pseudocode, /i32\.future_unary\(7\)/,
    'unknown unary semantics must remain explicit as an intrinsic fallback');
  assert.doesNotMatch(decompiled.pseudocode, /\(uint32_t\)/,
    'unknown unary semantics must never default to trunc');
}

{
  const fn = unaryFunction('not', 7);
  const lowered = lowerVMEffectsToSemanticIr(fn);
  const unaryNode = lowered.semanticIr.nodes.find((node) => node.metadata?.mnemonic === 'not');
  assert.equal(unaryNode?.operator, null);
  assert.match(decompileManagedMethod(fn).pseudocode, /~7/,
    'existing proven not semantics must remain a concrete unary operation');
}

console.log('[phase11] #4023 managed unary fail-closed regression passed');
