import assert from 'node:assert/strict';
import test from 'node:test';

import { expr } from '../../../js/decompiler/ast/nodes.js';

test('#4150 extra metadata cannot rewrite the AST node kind', () => {
  const forged = expr.variable('x', 64, null, null, { kind: 'forged' });
  assert.equal(forged.kind, 'var', `kind is constructor-owned: got ${forged.kind}`);
  assert.equal(forged.name, 'x');
  const bin = expr.binary('add', expr.variable('a'), expr.variable('b'), 32, false, null, { kind: 'call' });
  assert.equal(bin.kind, 'binary');
});

test('#4150 extra metadata cannot rewrite effect semantics', () => {
  const pure = expr.variable('x', 64, null, null, { effect: 'call' });
  assert.equal(pure.effect, 'pure', `a variable cannot be made effectful via extra: ${pure.effect}`);
  const bin = expr.binary('add', expr.variable('a'), expr.variable('b'), 32, false, null, { effect: 'unknown' });
  assert.equal(bin.effect, 'pure', 'a binary over pure operands stays pure');
  const call = expr.call('f', [], 64, null, { effect: 'pure' });
  assert.equal(call.effect, 'call', 'a call cannot be laundered into pure');
  const volatileLoad = expr.load({ key: 'k' }, 32, null, { volatile: true });
  assert.equal(volatileLoad.effect, 'volatile');
  const plainLoad = expr.load({ key: 'k' }, 32, null, { effect: 'write' });
  assert.equal(plainLoad.effect, 'read', 'load effect stays derived from volatility');
});

test('#4150 extra metadata cannot rewrite signedness or operand structure', () => {
  const signed = expr.variable('x', 64, null, null, { signed: true });
  assert.equal(signed.signed, null, 'signedness is an explicit constructor argument');
  const bin = expr.binary('add', expr.variable('a'), expr.variable('b'), 32, false, null, { left: expr.variable('forged') });
  assert.equal(bin.left.name, 'a');
  assert.equal(bin.right.name, 'b');
});

test('#4150 legitimate metadata extras keep flowing through', () => {
  const phi = expr.variable('local_phi_1', 64, null, null, { phi: true, incoming: [1, 2] });
  assert.equal(phi.kind, 'var');
  assert.equal(phi.phi, true);
  assert.deepEqual(phi.incoming, [1, 2]);
  const nzcv = expr.intrinsic('__arm64_nzcv_sub_eq_32', [], 1, false, null, { nzcv: { producer: 'sub' } });
  assert.equal(nzcv.kind, 'intrinsic');
  assert.deepEqual(nzcv.nzcv, { producer: 'sub' });
});
