import assert from 'node:assert/strict';
import test from 'node:test';

import { createPhase7AliasSolver } from '../../../js/analysis/alias/solver.js';
import { analyzeLocalPointsTo } from '../../../js/analysis/pointsto/local.js';
import { FunctionFixture, memoryAccessOf, regionOf } from '../helpers/fixtures.mjs';

function buildLoopConstantFixture({ valueConstant, nodeConstant, nodeMetadataConstant, constantOnLeft = false } = {}) {
  const f = new FunctionFixture('function_issue_4274');
  f.block('entry', ['loop']);
  const sp = f.stateRead('sp', 'state:sp');
  const c0 = f.constant('c0', 0);
  const p0 = f.binary('p0', 'add', sp, c0);
  f.stateWrite('w0', 'state:x3', p0);
  f.branch('b0', ['loop']);

  f.block('loop', ['loop', 'exit']);
  const cur = f.stateRead('cur', 'state:x3', { blockId: 'loop' });
  const c8 = f.constant('c8', 8, { blockId: 'loop' });
  const next = constantOnLeft
    ? f.binary('next', 'add', c8, cur, { blockId: 'loop' })
    : f.binary('next', 'add', cur, c8, { blockId: 'loop' });
  f.store('st_cur', cur, null, { widthBits: 32, blockId: 'loop' });
  f.store('st_next', next, null, { widthBits: 32, blockId: 'loop' });
  f.stateWrite('w1', 'state:x3', next, { blockId: 'loop' });
  f.branch('b1', ['loop', 'exit'], { blockId: 'loop', conditional: true });

  f.block('exit', []);
  f.ret('r', { blockId: 'exit' });

  const value = f.values.find((item) => item.id === 'c8');
  const node = f.nodes.find((item) => item.id === 'node_c8');
  if (valueConstant === undefined) delete value.metadata.constant;
  else value.metadata.constant = valueConstant;
  if (nodeConstant === undefined) delete node.attributes.constant;
  else node.attributes.constant = nodeConstant;
  if (nodeMetadataConstant !== undefined) node.metadata = { constant: nodeMetadataConstant };

  return f.build();
}

function solve(options) {
  const built = buildLoopConstantFixture(options);
  return analyzeLocalPointsTo(built.ir, built.cfg, built.ssa, {
    budget: { maxIterations: 2, widenAfterIterations: 99 },
  });
}

function assertConflictFailsClosed(options) {
  const result = solve(options);
  const next = result.pointsTo.get('next');
  assert.ok(next, 'the loop-carried result must have a published points-to answer');
  assert.equal(next.top, true, 'conflicting constant evidence must not mint an exact finite offset');
  assert.ok(next.lossReasons.includes('non-linear-arithmetic'),
    'the conflict must remain visible as lost arithmetic precision');
}

test('conflicting value=0 and node=8 constants fail closed instead of choosing the first source', () => {
  assertConflictFailsClosed({
    valueConstant: { value: '0', widthBits: 64 },
    nodeConstant: { value: '8', widthBits: 64 },
  });
});

test('conflicting value=8 and node=0 constants are source-order independent', () => {
  assertConflictFailsClosed({
    valueConstant: { value: '8', widthBits: 64 },
    nodeConstant: { value: '0', widthBits: 64 },
  });
});

test('a conflicting third constant source also prevents an exact shift', () => {
  assertConflictFailsClosed({
    valueConstant: { value: '8', widthBits: 64 },
    nodeConstant: { value: '8', widthBits: 64 },
    nodeMetadataConstant: { value: '9', widthBits: 64 },
  });
});

test('a conflicting left-hand add constant cannot take the symmetric exact-shift path', () => {
  assertConflictFailsClosed({
    valueConstant: { value: '0', widthBits: 64 },
    nodeConstant: { value: '8', widthBits: 64 },
    constantOnLeft: true,
  });
});

test('conflicting constant evidence cannot reach a downstream strong alias verdict', () => {
  const built = buildLoopConstantFixture({
    valueConstant: { value: '0', widthBits: 64 },
    nodeConstant: { value: '8', widthBits: 64 },
  });
  const solver = createPhase7AliasSolver({ ir: built.ir, cfg: built.cfg, ssa: built.ssa });
  const result = solver.alias(regionOf(built, 'node_st_cur'), regionOf(built, 'node_st_next'), {
    leftAccess: memoryAccessOf(built, 'node_st_cur'),
    rightAccess: memoryAccessOf(built, 'node_st_next'),
  });
  assert.equal(result.relation, 'may', 'conflicting constant evidence must not produce MustAlias or NoAlias');
});

test('equivalent parseable representations agree on the same finite shift', () => {
  const result = solve({
    valueConstant: { value: '0x8', widthBits: 64 },
    nodeConstant: { value: '8', widthBits: 64 },
  });
  const next = result.pointsTo.get('next');
  assert.equal(next.top, false);
  assert.equal(next.targets.length, 1);
  assert.equal(next.targets[0].offsetRange.exact, true);
  assert.equal(next.targets[0].offsetRange.min, 8n);
});

test('one valid constant source still preserves the existing finite-shift precision', () => {
  const result = solve({
    valueConstant: undefined,
    nodeConstant: { value: '8', widthBits: 64 },
  });
  const next = result.pointsTo.get('next');
  assert.equal(next.top, false);
  assert.equal(next.targets[0].offsetRange.exact, true);
  assert.equal(next.targets[0].offsetRange.min, 8n);
});

test('an unparseable source does not veto a single valid constant source', () => {
  const result = solve({
    valueConstant: { value: 'not-an-integer', widthBits: 64 },
    nodeConstant: { value: '8', widthBits: 64 },
  });
  const next = result.pointsTo.get('next');
  assert.equal(next.top, false);
  assert.equal(next.targets[0].offsetRange.exact, true);
  assert.equal(next.targets[0].offsetRange.min, 8n);
});
