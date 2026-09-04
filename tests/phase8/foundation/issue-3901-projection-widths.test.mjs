import assert from 'node:assert/strict';
import test from 'node:test';

import { applyPhase8Projection } from '../../../js/decompiler/phase8/projection.js';

function variable(bits) {
  return { kind:'var', name:'x', bits, signed:false, effect:'pure' };
}

function unary(op, arg, bits, signed = false) {
  return { kind:'unary', op, arg, bits, signed, effect:'pure' };
}

function project(expression) {
  const result = {
    semantic:{},
    semanticAst:{
      values:[{ expression }],
      stores:[],
      outputs:[],
      conditions:[],
    },
    cAst:{ body:[] },
    metrics:{},
  };
  const projected = applyPhase8Projection(result, new Map());
  return {
    projected,
    expression:projected.semanticAst.values[0].expression,
  };
}

function assertRefused(expression) {
  const { projected, expression:output } = project(expression);
  assert.equal(projected.phase8Projection.transformCount, 0);
  assert.deepEqual(projected.phase8Projection.transforms, []);
  assert.equal(output.phase8Proof, undefined);
  return output;
}

test('primitive numeric widths retain exact Phase 8 view collapses', () => {
  const nested = project(unary('trunc', unary('trunc', variable(32), 16), 8));
  assert.equal(nested.projected.phase8Projection.transformCount, 1);
  assert.equal(nested.expression.phase8Proof, 'nested-truncation');
  assert.equal(nested.expression.bits, 8);
  assert.equal(nested.expression.arg.name, 'x');

  const narrowedZeroExtension = project(unary('trunc', unary('zext', variable(8), 32), 16));
  assert.equal(narrowedZeroExtension.projected.phase8Projection.transformCount, 1);
  assert.equal(narrowedZeroExtension.expression.phase8Proof, 'narrowed-zero-extension');
  assert.equal(narrowedZeroExtension.expression.op, 'zext');
  assert.equal(narrowedZeroExtension.expression.bits, 16);

  const repeatedSignExtension = project(unary('sext', unary('sext', variable(8), 16, true), 32, true));
  assert.equal(repeatedSignExtension.projected.phase8Projection.transformCount, 1);
  assert.equal(repeatedSignExtension.expression.phase8Proof, 'repeated-sext');
  assert.equal(repeatedSignExtension.expression.bits, 32);
});

test('structured and coercible widths cannot authorize exact projection proofs', () => {
  const valueOfWidth = { valueOf() { return 32; } };
  const toPrimitiveWidth = { [Symbol.toPrimitive]() { return 64; } };

  const nested = assertRefused(unary('trunc', unary('trunc', variable(valueOfWidth), [16]), '8'));
  assert.equal(nested.bits, '8');
  assert.deepEqual(nested.arg.bits, [16]);
  assert.equal(nested.arg.arg.bits, valueOfWidth);

  const hiddenExtension = assertRefused(unary('trunc', unary('zext', variable(8), [32]), '16'));
  assert.equal(hiddenExtension.op, 'trunc');
  assert.equal(hiddenExtension.arg.op, 'zext');

  const repeatedExtension = assertRefused(unary('zext', unary('zext', variable(8), 16), toPrimitiveWidth));
  assert.equal(repeatedExtension.op, 'zext');
  assert.equal(repeatedExtension.arg.op, 'zext');
  assert.equal(repeatedExtension.bits, toPrimitiveWidth);

  assertRefused(unary('trunc', unary('trunc', variable(16), 8), true));
});

test('noncanonical primitive numbers remain outside exact width authority', () => {
  for (const bits of [NaN, Infinity, 7.5, 0, -1]) {
    const output = assertRefused(unary('trunc', unary('trunc', variable(32), 16), bits));
    assert.ok(Object.is(output.bits, bits));
  }
});
