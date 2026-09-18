import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createManagedMethodId, createVMEffectBundle, createVMEffectFunction,
  createVMOperationId, lowerVMEffectsToSemanticIr,
} from '../../../js/managed/index.js';
import { createSemanticNode } from '../../../js/semantics/ir/nodes.js';
import { evalBinary } from '../../../js/decompiler/truth/integer.js';

function lowerBinary(frontendId, mnemonic, bits = 32) {
  const methodId = createManagedMethodId(`issue-8774-${frontendId}-${mnemonic}`, 'binary');
  const isDex = frontendId === 'dex';
  const bundle = (offset, input) => createVMEffectBundle({
    frontendId, methodId,
    operationId: createVMOperationId(methodId, offset), bytecodeOffset: offset,
    completeness: 'exact', ...input,
  });
  const opBundle = isDex
    ? {
        mnemonic,
        locationReads: [
          { kind: 'register', index: 1, type: { kind: 'bitvector', widthBits: bits } },
          { kind: 'register', index: 2, type: { kind: 'bitvector', widthBits: bits } },
        ],
        locationWrites: [{ kind: 'register', index: 0 }],
        producedValues: [{ bits }],
      }
    : {
        mnemonic,
        consumedValues: [{ id: 'rhs', bits }, { id: 'lhs', bits }],
        producedValues: [{ bits }],
      };
  const fn = createVMEffectFunction({
    frontendId, methodId, aggregateCompleteness: 'exact', resolutionCompleteness: 'complete',
    bundles: [
      bundle(0, isDex
        ? { mnemonic: 'const', locationWrites: [{ kind: 'register', index: 1 }], producedValues: [{ bits, constant: 10 }] }
        : { mnemonic: `${frontendId}-const`, producedValues: [{ bits, constant: 10 }] }
      ),
      bundle(1, isDex
        ? { mnemonic: 'const', locationWrites: [{ kind: 'register', index: 2 }], producedValues: [{ bits, constant: 2 }] }
        : { mnemonic: `${frontendId}-const`, producedValues: [{ bits, constant: 2 }] }
      ),
      bundle(2, opBundle),
      bundle(3, isDex
        ? { mnemonic: 'return', locationReads: [{ kind: 'register', index: 0 }], controlEffects: [{ kind: 'return' }] }
        : { mnemonic: 'return', consumedValues: [{ id: 'result', bits }], controlEffects: [{ kind: 'return' }] }
      ),
    ],
  });
  return lowerVMEffectsToSemanticIr(fn);
}

test('JVM integer div/rem canonicalization to sdiv and srem', () => {
  for (const [mn, expectedOp] of [
    ['idiv', 'sdiv'],
    ['ldiv', 'sdiv'],
    ['irem', 'srem'],
    ['lrem', 'srem'],
  ]) {
    const lowered = lowerBinary('jvm', mn);
    const node = lowered.semanticIr.nodes.find((n) => n.metadata?.mnemonic === mn);
    assert.ok(node, `node for ${mn} must exist`);
    assert.equal(node.kind, 'binary');
    assert.equal(node.operator, expectedOp);
    assert.equal(node.attributes?.signed, true);
    assert.equal(node.completeness, 'complete');
  }
});

test('DEX integer div/rem canonicalization to sdiv and srem', () => {
  for (const [mn, expectedOp] of [
    ['div-int', 'sdiv'],
    ['div-int/2addr', 'sdiv'],
    ['div-int/lit8', 'sdiv'],
    ['div-int/lit16', 'sdiv'],
    ['div-long', 'sdiv'],
    ['div-long/2addr', 'sdiv'],
    ['rem-int', 'srem'],
    ['rem-int/2addr', 'srem'],
    ['rem-int/lit8', 'srem'],
    ['rem-int/lit16', 'srem'],
    ['rem-long', 'srem'],
    ['rem-long/2addr', 'srem'],
  ]) {
    const lowered = lowerBinary('dex', mn);
    const node = lowered.semanticIr.nodes.find((n) => n.metadata?.mnemonic === mn);
    assert.ok(node, `node for ${mn} must exist`);
    assert.equal(node.kind, 'binary');
    assert.equal(node.operator, expectedOp);
    assert.equal(node.attributes?.signed, true);
    assert.equal(node.completeness, 'complete');
  }
});

test('CIL div/rem canonicalization with signedness suffix to sdiv/udiv/srem/urem', () => {
  for (const [mn, expectedOp, expectedSigned] of [
    ['div', 'sdiv', true],
    ['div.un', 'udiv', false],
    ['rem', 'srem', true],
    ['rem.un', 'urem', false],
  ]) {
    const lowered = lowerBinary('cil', mn);
    const node = lowered.semanticIr.nodes.find((n) => n.metadata?.mnemonic === mn);
    assert.ok(node, `node for ${mn} must exist`);
    assert.equal(node.kind, 'binary');
    assert.equal(node.operator, expectedOp);
    assert.equal(node.attributes?.signed, expectedSigned);
    assert.equal(node.completeness, 'complete');
  }
});

test('WASM div/rem canonicalization to sdiv/udiv/srem/urem', () => {
  for (const [mn, expectedOp, expectedSigned] of [
    ['i32.div_s', 'sdiv', true],
    ['i32.div_u', 'udiv', false],
    ['i32.rem_s', 'srem', true],
    ['i32.rem_u', 'urem', false],
    ['i64.div_s', 'sdiv', true],
    ['i64.div_u', 'udiv', false],
    ['i64.rem_s', 'srem', true],
    ['i64.rem_u', 'urem', false],
  ]) {
    const lowered = lowerBinary('wasm', mn);
    const node = lowered.semanticIr.nodes.find((n) => n.metadata?.mnemonic === mn);
    assert.ok(node, `node for ${mn} must exist`);
    assert.equal(node.kind, 'binary');
    assert.equal(node.operator, expectedOp);
    assert.equal(node.attributes?.signed, expectedSigned);
    assert.equal(node.completeness, 'complete');
  }
});

test('high-bit concrete truth distinguishes signed from unsigned remainder', () => {
  // -1 (0xffffffff) % 2: signed gives -1 (0xffffffff), unsigned gives 1
  assert.equal(evalBinary('srem', 0xffffffffn, 2n, 32), 0xffffffffn);
  assert.equal(evalBinary('urem', 0xffffffffn, 2n, 32), 1n);
  assert.equal(evalBinary('smod', 0xffffffffn, 2n, 32), 0xffffffffn);
  assert.equal(evalBinary('umod', 0xffffffffn, 2n, 32), 1n);

  assert.equal(evalBinary('srem', 0xffffffffffffffffn, 2n, 64), 0xffffffffffffffffn);
  assert.equal(evalBinary('urem', 0xffffffffffffffffn, 2n, 64), 1n);
});

test('Semantic IR node contract rejects non-canonical div/rem on complete binary node', () => {
  const origin = { instructionIds: ['inst-0'] };
  for (const nonCanonicalOp of ['div', 'rem', 'smod', 'umod']) {
    assert.throws(() => createSemanticNode({
      id: 'node_test',
      kind: 'binary',
      blockId: 'bb_0',
      inputs: ['v0', 'v1'],
      outputs: ['v2'],
      operator: nonCanonicalOp,
      completeness: 'complete',
      origin,
    }), /semantic-ir-invalid-operator/, `should reject ${nonCanonicalOp} on complete binary node`);

    // But allowed on partial node with unknown detail
    assert.doesNotThrow(() => createSemanticNode({
      id: 'node_test_partial',
      kind: 'binary',
      blockId: 'bb_0',
      inputs: ['v0', 'v1'],
      outputs: ['v2'],
      operator: nonCanonicalOp,
      completeness: 'partial',
      unknown: { reason: 'test-partial', categories: ['other'] },
      origin,
    }), `should allow ${nonCanonicalOp} on partial binary node`);
  }
});

test('unknown div/rem mnemonic fails closed to partial in lowerVMEffectsToSemanticIr', () => {
  const lowered = lowerBinary('wasm', 'i32.div_unknown');
  const node = lowered.semanticIr.nodes.find((n) => n.metadata?.mnemonic === 'i32.div_unknown');
  assert.ok(node);
  assert.equal(node.completeness, 'partial');
  assert.equal(node.unknown?.reason, 'managed-binary-operator-unresolved');
  assert.equal(lowered.semanticIr.completeness, 'partial');
});
