/**
 * Regression for #8767 — bridge-v2 must normalize frontend right-shift
 * signedness at the VMEffects -> canonical Semantic IR boundary (lshr/ashr),
 * never publish an ambiguous complete `shr`, and fail closed on unknown
 * shift spellings.
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

function lower(frontendId, mnemonic, bits = 32, lhs) {
  const methodId = createManagedMethodId(`repro-8767-${frontendId}-${mnemonic}`, 'shift');
  const bundle = (offset, input) => createVMEffectBundle({
    frontendId,
    methodId,
    operationId: createVMOperationId(methodId, offset),
    bytecodeOffset: offset,
    completeness: 'exact',
    ...input,
  });
  const bundles = frontendId === 'dex'
    ? [
        bundle(0, {
          mnemonic,
          locationReads: [
            { kind: 'register', index: 1, bits },
            { kind: 'register', index: 2, bits },
          ],
          locationWrites: [{ kind: 'register', index: 0, bits }],
          producedValues: [{ bits }],
        }),
        bundle(2, { mnemonic: 'return-void', controlEffects: [{ kind: 'return' }] }),
      ]
    : [
        bundle(0, { mnemonic: `${frontendId}.const.lhs`, producedValues: [{ bits, constant: lhs ?? 0x80000000 }] }),
        bundle(1, { mnemonic: `${frontendId}.const.rhs`, producedValues: [{ bits, constant: 1 }] }),
        bundle(2, {
          mnemonic,
          consumedValues: [{ id: 'rhs', bits }, { id: 'lhs', bits }],
          producedValues: [{ bits }],
        }),
        bundle(3, { mnemonic: 'return', consumedValues: [{ id: 'result', bits }], controlEffects: [{ kind: 'return' }] }),
      ];
  const fn = createVMEffectFunction({
    frontendId,
    methodId,
    bundles,
    aggregateCompleteness: 'exact',
    resolutionCompleteness: 'complete',
  });
  return lowerVMEffectsToSemanticIr(fn);
}

function shiftNode(result) {
  const node = result.semanticIr.nodes.find((entry) => entry.kind === 'binary');
  assert.ok(node, 'binary node present');
  return node;
}

test('#8767 JVM logical/arithmetic right shifts normalize at the bridge boundary', () => {
  for (const [mnemonic, operator] of [['iushr', 'lshr'], ['lushr', 'lshr'], ['ishr', 'ashr'], ['lshr', 'ashr']]) {
    const bits = mnemonic.startsWith('l') ? 64 : 32;
    const result = lower('jvm', mnemonic, bits);
    const node = shiftNode(result);
    assert.equal(node.operator, operator, `jvm ${mnemonic}`);
    assert.equal(node.completeness, 'complete', `jvm ${mnemonic} stays complete`);
    assert.equal(result.semanticIr.completeness, 'complete');
  }
});

test('#8767 DEX right shifts keep ushr/shr signedness', () => {
  for (const [mnemonic, operator, bits] of [
    ['ushr-int', 'lshr', 32],
    ['ushr-int/2addr', 'lshr', 32],
    ['ushr-long', 'lshr', 64],
    ['shr-int', 'ashr', 32],
    ['shr-int/lit8', 'ashr', 32],
    ['shr-long/2addr', 'ashr', 64],
  ]) {
    const result = lower('dex', mnemonic, bits);
    const node = shiftNode(result);
    assert.equal(node.operator, operator, `dex ${mnemonic}`);
    assert.equal(node.completeness, 'complete', `dex ${mnemonic} stays complete`);
    assert.equal(result.semanticIr.completeness, 'complete');
  }
});

test('#8767 CIL shr is arithmetic, shr.un is logical', () => {
  const plain = lower('cil', 'shr');
  assert.equal(shiftNode(plain).operator, 'ashr');
  assert.equal(plain.semanticIr.completeness, 'complete');
  const unsigned = lower('cil', 'shr.un');
  assert.equal(shiftNode(unsigned).operator, 'lshr');
  assert.equal(unsigned.semanticIr.completeness, 'complete');
});

test('#8767 WASM suffix normalization is preserved', () => {
  assert.equal(shiftNode(lower('wasm', 'i32.shr_u')).operator, 'lshr');
  assert.equal(shiftNode(lower('wasm', 'i32.shr_s')).operator, 'ashr');
});

test('#8767 unknown shift spellings fail closed instead of complete shr', () => {
  const result = lower('jvm', 'xshr');
  const node = shiftNode(result);
  assert.notEqual(node.operator, 'shr', 'ambiguous shr must not be published');
  assert.equal(node.completeness, 'partial', `unknown spelling ${node.operator} must not be complete`);
  assert.ok(node.unknown);
  assert.equal(result.semanticIr.completeness, 'partial');
});

test('#8767 canonical shifts evaluate through the v2->v1 compatibility path', () => {
  const logical = lower('jvm', 'iushr', 32, 0x80000000);
  const arithmetic = lower('jvm', 'ishr', 32, 0x80000000);
  for (const [result, sub, expected] of [[logical, 'lshr', 0x40000000], [arithmetic, 'ashr', 0xc0000000]]) {
    const projected = projectSemanticIrV2ToLegacyV1(result.semanticIr, {
      ssa: result.ssa,
      cfg: result.cfg,
    });
    const fn = projected.functions?.[0] ?? projected;
    const instructions = fn.instructions ?? [];
    assert.ok(!instructions.some((entry) => entry.op === 'bin' && entry.sub === 'shr'), 'no ambiguous shr reaches v1');
    const shift = instructions.find((entry) => entry.op === 'bin' && entry.sub === sub);
    assert.ok(shift, `${sub} instruction present`);
    assert.notEqual(shift.dst?.const, null, `${sub} must constant-fold`);
    assert.equal(Number(shift.dst.const), expected, `${sub} folds to ${expected.toString(16)}`);
  }
});
