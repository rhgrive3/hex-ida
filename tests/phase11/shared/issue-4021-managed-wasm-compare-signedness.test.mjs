import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createManagedMethodId,
  createVMEffectBundle,
  createVMEffectFunction,
  createVMOperationId,
  decompileManagedMethod,
  lowerVMEffectsToSemanticIr,
} from '../../../js/managed/index.js';

const RELATIONS = ['lt', 'le', 'gt', 'ge'];
const CANONICAL = {
  lt: { signed: 'slt', unsigned: 'ult' },
  le: { signed: 'sle', unsigned: 'ule' },
  gt: { signed: 'sgt', unsigned: 'ugt' },
  ge: { signed: 'sge', unsigned: 'uge' },
};

function compareFunction({ relation, signedness, bits = 32, branch = false }) {
  const suffix = signedness === 'signed' ? 's' : 'u';
  const mnemonic = `i${bits}.${relation}_${suffix}`;
  const methodId = createManagedMethodId(`issue-4021-${mnemonic}-${branch ? 'branch' : 'return'}`, 'compare');
  const bundle = (offset, input) => createVMEffectBundle({
    frontendId: 'wasm',
    methodId,
    operationId: createVMOperationId(methodId, offset),
    bytecodeOffset: offset,
    completeness: 'exact',
    ...input,
  });
  const high = bits === 64 ? 0xffffffffffffffffn : 0xffffffff;
  const bundles = [
    bundle(0, { mnemonic: `i${bits}.const`, producedValues: [{ bits, constant: high }] }),
    bundle(1, { mnemonic: `i${bits}.const`, producedValues: [{ bits, constant: 0 }] }),
    bundle(2, {
      mnemonic,
      compare: { predicate: relation, signedness, operandBits: bits, arity: 2 },
      consumedValues: [{ id: 'rhs', bits }, { id: 'lhs', bits }],
      producedValues: [{ bits: 32 }],
    }),
  ];
  if (branch) {
    bundles.push(
      bundle(3, {
        mnemonic: 'br_if',
        consumedValues: [{ id: 'condition', bits: 32 }],
        controlEffects: [{ kind: 'conditional-branch', targetOffset: 5, falseTargetOffset: 4 }],
      }),
      bundle(4, { mnemonic: 'return', controlEffects: [{ kind: 'return' }] }),
      bundle(5, { mnemonic: 'return', controlEffects: [{ kind: 'return' }] }),
    );
  } else {
    bundles.push(bundle(3, {
      mnemonic: 'return',
      consumedValues: [{ id: 'result', bits: 32 }],
      controlEffects: [{ kind: 'return' }],
    }));
  }
  return createVMEffectFunction({
    frontendId: 'wasm',
    methodId,
    bundles,
    aggregateCompleteness: 'exact',
    resolutionCompleteness: 'complete',
  });
}

function compareNode(lowered, mnemonic) {
  const node = lowered.semanticIr.nodes.find((candidate) => candidate.metadata?.mnemonic === mnemonic);
  assert.ok(node, `missing Semantic IR compare node for ${mnemonic}`);
  assert.equal(node.kind, 'compare', mnemonic);
  return node;
}

for (const bits of [32, 64]) {
  test(`WASM i${bits} relational compare signedness survives VMEffects -> Semantic IR -> decompiler`, () => {
    for (const relation of RELATIONS) {
      const signedMnemonic = `i${bits}.${relation}_s`;
      const unsignedMnemonic = `i${bits}.${relation}_u`;
      const signedLowered = lowerVMEffectsToSemanticIr(compareFunction({ relation, signedness: 'signed', bits }));
      const unsignedLowered = lowerVMEffectsToSemanticIr(compareFunction({ relation, signedness: 'unsigned', bits }));

      assert.equal(compareNode(signedLowered, signedMnemonic).operator, CANONICAL[relation].signed);
      assert.equal(compareNode(unsignedLowered, unsignedMnemonic).operator, CANONICAL[relation].unsigned);

      const signedText = decompileManagedMethod(signedLowered).pseudocode;
      const unsignedText = decompileManagedMethod(unsignedLowered).pseudocode;
      assert.match(signedText, new RegExp(`-1 [<>=]+ 0`), `${signedMnemonic} must use the signed high-bit view`);
      assert.match(unsignedText, new RegExp(`${bits === 64 ? '0xFFFFFFFFFFFFFFFF' : '0xFFFFFFFF'} [<>=]+ 0`), `${unsignedMnemonic} must use the unsigned high-bit view`);
      assert.notEqual(signedText, unsignedText, `${signedMnemonic}/${unsignedMnemonic} must not collapse to the same decompiler semantics`);
    }
  });
}

test('WASM equality comparisons remain signedness-independent', () => {
  for (const predicate of ['eq', 'ne']) {
    const methodId = createManagedMethodId(`issue-4021-i32-${predicate}`, 'compare');
    const bundle = (offset, input) => createVMEffectBundle({
      frontendId: 'wasm', methodId, operationId: createVMOperationId(methodId, offset),
      bytecodeOffset: offset, completeness: 'exact', ...input,
    });
    const fn = createVMEffectFunction({
      frontendId: 'wasm', methodId, aggregateCompleteness: 'exact', resolutionCompleteness: 'complete',
      bundles: [
        bundle(0, { mnemonic: 'i32.const', producedValues: [{ bits: 32, constant: 1 }] }),
        bundle(1, { mnemonic: 'i32.const', producedValues: [{ bits: 32, constant: 0 }] }),
        bundle(2, {
          mnemonic: `i32.${predicate}`,
          compare: { predicate, signedness: null, operandBits: 32, arity: 2 },
          consumedValues: [{ id: 'rhs', bits: 32 }, { id: 'lhs', bits: 32 }],
          producedValues: [{ bits: 32 }],
        }),
        bundle(3, { mnemonic: 'return', consumedValues: [{ id: 'result', bits: 32 }], controlEffects: [{ kind: 'return' }] }),
      ],
    });
    const lowered = lowerVMEffectsToSemanticIr(fn);
    assert.equal(compareNode(lowered, `i32.${predicate}`).operator, predicate);
    assert.match(decompileManagedMethod(lowered).pseudocode, predicate === 'eq' ? /1 == 0/ : /1 != 0/);
  }
});

test('high-bit concrete comparison truth differs between unsigned and signed domains', () => {
  for (const bits of [32, 64]) {
    const high = bits === 64 ? 0xffffffffffffffffn : 0xffffffffn;
    const unsigned = BigInt.asUintN(bits, high);
    const signed = BigInt.asIntN(bits, high);
    assert.equal(unsigned < 0n, false);
    assert.equal(signed < 0n, true);
    assert.equal(unsigned > 0n, true);
    assert.equal(signed > 0n, false);
  }
});

test('WASM compare signedness is preserved when the compare feeds a branch condition', () => {
  const signed = decompileManagedMethod(compareFunction({ relation: 'lt', signedness: 'signed', bits: 32, branch: true })).pseudocode;
  const unsigned = decompileManagedMethod(compareFunction({ relation: 'lt', signedness: 'unsigned', bits: 32, branch: true })).pseudocode;
  assert.match(signed, /if \(-1 < 0\)/);
  assert.match(unsigned, /if \(0xFFFFFFFF < 0\)/);
  assert.notEqual(signed, unsigned);
});

test('contradictory canonical compare authority fails closed instead of trusting mnemonic text', () => {
  const lowered = structuredClone(lowerVMEffectsToSemanticIr(compareFunction({ relation: 'lt', signedness: 'unsigned', bits: 32 })));
  const node = lowered.semanticIr.nodes.find((candidate) => candidate.metadata?.mnemonic === 'i32.lt_u');
  node.operator = 'slt';
  const text = decompileManagedMethod(lowered).pseudocode;
  assert.match(text, /i32_lt_u\(/);
  assert.doesNotMatch(text, / [<>]=? /);
});
