import assert from 'node:assert/strict';
import test from 'node:test';
import { createCompactFunctionSet, materializeCompactFunctionSet } from '../../../js/diff/compact-function-set.js';

const symbols = {
  funcs: new BigUint64Array([0x1000n, 0x1010n, 0x1030n]),
  addrs: [0x1000n, 0x1010n], names: ['first', 'second'], functionStartsComplete: true,
};

for (const [limit, expected] of [[1.5, 1], [0.5, 0], [2.99, 2], [3.5, 3], ['1.5', 1]]) {
  test(`fractional producer limit ${limit} yields an integer count and matching completeness`, () => {
    const compact = createCompactFunctionSet(symbols, 'arm64', limit);
    assert.equal(compact.count, expected);
    assert.equal(Number.isSafeInteger(compact.count), true);
    assert.equal(compact.total, 3, 'do not shrink the discovery denominator');
    assert.equal(compact.complete, expected === 3);
    assert.equal(compact.truncationReason, expected === 3 ? null : 'function-budget');
    const rows = materializeCompactFunctionSet(compact);
    assert.equal(rows.length, expected);
    if (expected > 0) assert.equal(rows[0].name, 'first');
  });
}

test('serialized counts are normalized independently of the producer', () => {
  const compact = createCompactFunctionSet(symbols, 'arm64');
  for (const [count, expected] of [[1.5, 1], [-1, 0], [-Infinity, 0], [NaN, 0], ['invalid', 0], [undefined, 0], [null, 0], [Infinity, 3], [1e20, 3], ['2.9', 2]]) {
    const rows = materializeCompactFunctionSet({ ...compact, count });
    assert.equal(rows.length, expected, `serialized count ${String(count)}`);
  }
});

test('zero, integer, default and empty producer behavior remain usable', () => {
  for (const [limit, count] of [[0, 0], [1, 1], [3, 3], [4, 3], [undefined, 3], [Infinity, 3], [NaN, 0], [-1, 0]]) {
    const compact = createCompactFunctionSet(symbols, 'arm64', limit);
    assert.equal(compact.count, count);
    assert.equal(materializeCompactFunctionSet(compact).length, count);
  }
  const empty = createCompactFunctionSet({ funcs: [], functionStartsComplete: true }, 'arm64', 1.5);
  assert.equal(empty.count, 0);
  assert.equal(empty.complete, true);
  assert.deepEqual(materializeCompactFunctionSet(empty), []);
});

test('incomplete discovery and ordinary row fields retain their contracts', () => {
  const compact = createCompactFunctionSet({ ...symbols, functionStartsComplete: false }, 'arm64', 3.5);
  assert.equal(compact.complete, false);
  assert.equal(compact.truncationReason, 'function-discovery-incomplete');
  const rows = materializeCompactFunctionSet(compact);
  assert.deepEqual(rows.map((row) => row.address), [...symbols.funcs]);
  assert.deepEqual(rows.map((row) => row.size), [0x10, 0x20, 0]);
  const original = [{ address: 1n }];
  assert.equal(materializeCompactFunctionSet(original), original);
});
