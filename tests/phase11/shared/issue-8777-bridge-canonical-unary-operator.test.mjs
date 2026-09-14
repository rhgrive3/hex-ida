/**
 * Regression for #8777 — the canonical VMEffects -> Semantic IR boundary must
 * publish proven unary operators (clz/ctz/popcnt/neg/not) and fail closed to
 * partial on unrecognized unary spellings instead of complete operator:null.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createManagedMethodId,
  createVMEffectBundle,
  createVMEffectFunction,
  createVMOperationId,
  lowerVMEffectsToSemanticIr,
} from '../../../js/managed/index.js';
import { projectSemanticIrV2ToLegacyV1 } from '../../../js/semantics/compat/index.js';
import { evalUnary } from '../../../js/decompiler/truth/integer.js';

function unaryFunction(frontendId, mnemonic, bits = 32, constant = 8) {
  const methodId = createManagedMethodId(`issue-8777-${frontendId}-${mnemonic}`, 'unary');
  const bundle = (offset, input) => createVMEffectBundle({
    frontendId,
    methodId,
    operationId: createVMOperationId(methodId, offset),
    bytecodeOffset: offset,
    completeness: 'exact',
    ...input,
  });
  return createVMEffectFunction({
    frontendId,
    methodId,
    bundles: [
      bundle(0, { mnemonic: `${frontendId}.const`, producedValues: [{ bits, constant }] }),
      bundle(1, { mnemonic, consumedValues: [{ id: 'arg', bits }], producedValues: [{ bits }] }),
      bundle(2, { mnemonic: 'return', consumedValues: [{ id: 'result', bits }], controlEffects: [{ kind: 'return' }] }),
    ],
    aggregateCompleteness: 'exact',
    resolutionCompleteness: 'complete',
  });
}

function unaryNodeOf(result, mnemonic) {
  const node = result.semanticIr.nodes.find((entry) => entry.metadata?.mnemonic === mnemonic);
  assert.ok(node, `${mnemonic} node present`);
  return node;
}

test('#8777 WASM clz/ctz/popcnt publish canonical operators', () => {
  for (const [mnemonic, operator] of [
    ['i32.clz', 'clz'], ['i64.clz', 'clz'],
    ['i32.ctz', 'ctz'], ['i64.ctz', 'ctz'],
    ['i32.popcnt', 'popcnt'], ['i64.popcnt', 'popcnt'],
  ]) {
    const bits = mnemonic.startsWith('i64') ? 64 : 32;
    const result = lowerVMEffectsToSemanticIr(unaryFunction('wasm', mnemonic, bits));
    const node = unaryNodeOf(result, mnemonic);
    assert.equal(node.kind, 'unary');
    assert.equal(node.operator, operator, `${mnemonic} canonical operator`);
    assert.equal(node.completeness, 'complete', `${mnemonic} proven semantics stay complete`);
    assert.equal(result.semanticIr.completeness, 'complete', `${mnemonic} keeps function authority`);
  }
});

test('#8777 neg/not spellings map to canonical operators per frontend', () => {
  for (const [frontendId, mnemonic] of [
    ['cil', 'neg'], ['jvm', 'ineg'], ['jvm', 'lneg'],
    ['dex', 'neg-int'], ['dex', 'neg-long/2addr'],
    ['cil', 'not'], ['dex', 'not-int'], ['dex', 'not-long/2addr'],
  ]) {
    const bits = mnemonic.includes('long') ? 64 : 32;
    const result = lowerVMEffectsToSemanticIr(unaryFunction(frontendId, mnemonic, bits));
    const node = unaryNodeOf(result, mnemonic);
    assert.equal(node.operator, mnemonic.startsWith('not') || mnemonic.includes('not-') ? 'not' : 'neg');
    assert.equal(node.completeness, 'complete');
    assert.equal(result.semanticIr.completeness, 'complete');
  }
});

test('#8777 canonical unary operators survive the v2->v1 projection and evaluate', () => {
  const ctz = (value, bits) => value === 0n ? BigInt(bits) : (() => { let n = 0n; while (((value >> n) & 1n) === 0n) n++; return n; })();
  const popcnt = (value, bits) => { let x = value, c = 0n; while (x) { x &= x - 1n; c++; } return c; };
  const reference = { clz: (value, bits) => evalUnary('clz', value, bits), ctz, popcnt };
  const cases = [['i32.clz', 'clz', 1, 31n], ['i32.ctz', 'ctz', 8, 3n], ['i32.popcnt', 'popcnt', 0xf0, 4n]];
  for (const [mnemonic, operator, value, expected] of cases) {
    const result = lowerVMEffectsToSemanticIr(unaryFunction('wasm', mnemonic, 32, value));
    const projected = projectSemanticIrV2ToLegacyV1(result.semanticIr, { ssa: result.ssa, cfg: result.cfg });
    const fn = projected.functions?.[0] ?? projected;
    const inst = (fn.instructions ?? []).find((entry) => entry.op === 'un' && entry.sub === operator);
    assert.ok(inst, `${mnemonic}: projected sub:${operator} present, not 'unknown'`);
    assert.equal(reference[operator](BigInt(value), 32), expected, `${operator}(${value})`);
  }
});

test('#8777 unrecognized unary spellings fail closed instead of complete operator:null', () => {
  const result = lowerVMEffectsToSemanticIr(unaryFunction('wasm', 'i32.quantum_frobnicate'));
  const node = unaryNodeOf(result, 'i32.quantum_frobnicate');
  assert.equal(node.operator, null, 'no operator may be invented');
  assert.notEqual(node.completeness, 'complete', 'unknown unary must not publish complete semantics');
  assert.equal(node.completeness, 'partial');
  assert.equal(node.unknown?.reason, 'managed-unary-operator-unresolved');
  assert.equal(result.semanticIr.completeness, 'partial');
  assert.ok(result.semanticIr.unknowns.some((entry) => entry.reason === 'managed-unary-operator-unresolved'));
});

test('#8777 constant-producing loads are lowered as const nodes, not unknown unary', () => {
  for (const [frontendId, mnemonic, bits] of [
    ['cil', 'ldnull', 32], ['jvm', 'aconst_null', 32], ['jvm', 'ldc2_w', 64], ['cil', 'ldc.i4', 32],
  ]) {
    const methodId = createManagedMethodId(`issue-8777-const-${frontendId}-${mnemonic}`, 'load');
    const bundle = (offset, input) => createVMEffectBundle({
      frontendId,
      methodId,
      operationId: createVMOperationId(methodId, offset),
      bytecodeOffset: offset,
      completeness: 'exact',
      ...input,
    });
    const fn = createVMEffectFunction({
      frontendId,
      methodId,
      bundles: [
        bundle(0, { mnemonic, producedValues: [{ bits, constant: 1 }] }),
        bundle(1, { mnemonic: 'return', consumedValues: [{ id: 'result', bits }], controlEffects: [{ kind: 'return' }] }),
      ],
      aggregateCompleteness: 'exact',
      resolutionCompleteness: 'complete',
    });
    const result = lowerVMEffectsToSemanticIr(fn);
    const node = unaryNodeOf(result, mnemonic);
    assert.equal(node.kind, 'const', `${mnemonic} is a constant load`);
    assert.equal(node.completeness, 'complete', `${mnemonic} proven load stays complete`);
  }
});
