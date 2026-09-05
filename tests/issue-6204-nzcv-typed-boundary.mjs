import assert from 'node:assert/strict';
import {
  evaluateNZCVCondition,
  buildNZCVConditionExpression,
  renderNZCVCondition,
  isNZCVCondition,
} from '../js/decompiler/flag-semantics.js';
import { expr } from '../js/decompiler/ast/nodes.js';

console.log('Testing #6204: NZCV evaluator rejects structured coercion.');

// 1. Structured producer/condition/value/width never become definite conditions.
assert.equal(evaluateNZCVCondition(['sub'], ['eq'], ['1'], [1], ['32']), null);
assert.equal(evaluateNZCVCondition('sub', ['eq'], 1n, 1n, 32), null);
assert.equal(evaluateNZCVCondition(['sub'], 'eq', 1n, 1n, 32), null);
assert.equal(evaluateNZCVCondition('sub', 'eq', ['1'], 1n, 32), null);
assert.equal(evaluateNZCVCondition('sub', 'eq', 1n, [1], 32), null);
assert.equal(evaluateNZCVCondition('sub', 'eq', 1n, 1n, ['32']), null);
assert.equal(evaluateNZCVCondition('sub', 'eq', true, 1n, 64), null);
assert.equal(evaluateNZCVCondition('sub', 'eq', 1n, true, 64), null);
assert.equal(evaluateNZCVCondition({ toString: () => 'sub' }, 'eq', 1n, 1n, 64), null);
assert.equal(evaluateNZCVCondition('sub', { toString: () => 'eq' }, 1n, 1n, 64), null);

// 2. Structured width never promotes to canonical flag width.
assert.equal(evaluateNZCVCondition('sub', 'eq', 1n, 1n, '32'), null);
assert.equal(evaluateNZCVCondition('sub', 'eq', 1n, 1n, true), null);
assert.equal(evaluateNZCVCondition('sub', 'eq', 1n, 1n, 1.5), null);
assert.equal(evaluateNZCVCondition('sub', 'eq', 1n, 1n, 0), null);
assert.equal(evaluateNZCVCondition('sub', 'eq', 1n, 1n, 128), null);

// 3. Unknown producer/condition stay fail-closed.
assert.equal(evaluateNZCVCondition('rubbish', 'eq', 1n, 1n, 64), null);
assert.equal(evaluateNZCVCondition('sub', 'rubbish', 1n, 1n, 64), null);
assert.equal(isNZCVCondition(['eq']), false);
assert.equal(isNZCVCondition({ toString: () => 'eq' }), false);

// 4. Floating NZCV keeps its canonical number operand boundary.
assert.equal(evaluateNZCVCondition('fsub', 'eq', ['1'], [1], ['32']), null);
assert.equal(evaluateNZCVCondition('fsub', 'eq', true, 1, 64), null);
assert.equal(evaluateNZCVCondition('fsub', 'vs', NaN, 1, 64), true);
assert.equal(evaluateNZCVCondition('fsub', 'eq', 1, 1, 64), true);
assert.equal(evaluateNZCVCondition('fsub', 'lt', 1, 2, 64), true);

// 5. Canonical typed inputs keep existing results.
assert.equal(evaluateNZCVCondition('sub', 'eq', 1n, 1n, 32), true);
assert.equal(evaluateNZCVCondition('sub', 'ne', 1n, 1n, 32), false);
assert.equal(evaluateNZCVCondition('add', 'ge', 0x7fffffffn, 1n, 32), true);
assert.equal(evaluateNZCVCondition('and', 'mi', 0x80n, 0xffn, 8), true);
assert.equal(evaluateNZCVCondition('and', 'cs', 0x80n, 0xffn, 8), false);

// 6. Builder refuses structured metadata without producing definite AST.
const a32 = expr.variable('a', 32, null);
const b32 = expr.variable('b', 32, null);
assert.equal(buildNZCVConditionExpression(['sub'], 'eq', a32, b32, 32), null);
assert.equal(buildNZCVConditionExpression('sub', ['eq'], a32, b32, 32), null);
assert.equal(buildNZCVConditionExpression('sub', 'eq', a32, b32, ['32']), null);
assert.equal(buildNZCVConditionExpression('sub', 'eq', a32, b32, '32'), null);
assert.equal(buildNZCVConditionExpression('rubbish', 'eq', a32, b32, 32), null);
assert.equal(buildNZCVConditionExpression('sub', 'eq', a32, b32, 33), null);

// Canonical builder results still hold.
const addGe = buildNZCVConditionExpression('add', 'ge', a32, b32, 32);
assert.equal(addGe.kind, 'intrinsic');
const addEq = buildNZCVConditionExpression('add', 'eq', a32, b32, 32);
assert.equal(addEq.kind, 'compare');

// 7. Render helper shares the typed boundary.
assert.equal(renderNZCVCondition('sub', 'eq', ['a'], 'b', 32), null);
assert.equal(renderNZCVCondition('sub', 'eq', 'a', 'b', ['32']), null);
assert.equal(renderNZCVCondition(['sub'], 'eq', 'a', 'b', 32), null);
assert.equal(renderNZCVCondition('sub', 'eq', 'a', 'b', 32), '(uint32_t)a == (uint32_t)b');
assert.equal(renderNZCVCondition('sub', 'hs', 'a', 'b', 32), '(uint32_t)a >= (uint32_t)b');

console.log('#6204: All tests passed successfully.');
