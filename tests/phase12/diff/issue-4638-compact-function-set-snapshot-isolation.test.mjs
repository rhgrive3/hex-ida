import assert from 'node:assert/strict';
import test from 'node:test';
import {
  COMPACT_DIFF_FUNCTION_SET_SCHEMA,
  createCompactFunctionSet,
  materializeCompactFunctionSet,
} from '../../../js/diff/compact-function-set.js';

function sourceSymbols() {
  return {
    funcs: [0x1000n, 0x1100n],
    addrs: [0x1000n],
    names: ['first'],
    functionStartsComplete: true,
  };
}

test('#4638 function address column is a snapshot, not an alias of the caller array', () => {
  const symbols = sourceSymbols();
  const compact = createCompactFunctionSet(symbols, 'arm64');
  assert.notEqual(compact.functionAddresses, symbols.funcs, 'must not share the caller-owned array');
  assert.deepEqual([...compact.functionAddresses], [0x1000n, 0x1100n]);

  const before = materializeCompactFunctionSet(compact);
  symbols.funcs.push(0x1200n);

  assert.equal(compact.functionAddresses.length, 2, 'caller mutation must not grow the snapshot');
  assert.equal(compact.count, 2);
  assert.equal(compact.total, 2);
  assert.deepEqual(materializeCompactFunctionSet(compact), before,
    'materialize must stay reproducible after the caller mutates its own array');
  assert.equal(before[1].size, 0);
});

test('#4638 symbol identity columns are snapshots too', () => {
  const symbols = sourceSymbols();
  symbols.funcs = [0x1000n, 0x1100n, 0x1200n];
  symbols.addrs = [0x1000n, 0x1100n];
  symbols.names = ['first', 'second'];
  const compact = createCompactFunctionSet(symbols, 'arm64');
  assert.notEqual(compact.symbolAddresses, symbols.addrs);
  assert.notEqual(compact.symbolNames, symbols.names);

  const before = materializeCompactFunctionSet(compact);
  assert.deepEqual(before.map((row) => row.name), ['first', 'second', null]);

  symbols.addrs[1] = 0x1200n;
  symbols.names[1] = 'renamed';
  symbols.addrs.push(0x9999n);
  symbols.names.push('injected');

  const after = materializeCompactFunctionSet(compact);
  assert.deepEqual(after.map((row) => row.name), ['first', 'second', null],
    'post-creation symbol edits must not rebind names inside the snapshot');
});

test('#4638 snapshot columns are frozen and stay consistent with count/total', () => {
  const symbols = sourceSymbols();
  const compact = createCompactFunctionSet(symbols, 'arm64');
  assert.equal(compact.schema, COMPACT_DIFF_FUNCTION_SET_SCHEMA);
  assert.ok(Object.isFrozen(compact.functionAddresses), 'function column must be frozen');
  assert.ok(Object.isFrozen(compact.symbolAddresses), 'symbol address column must be frozen');
  assert.ok(Object.isFrozen(compact.symbolNames), 'symbol name column must be frozen');
  assert.equal(compact.functionAddresses.length, compact.total);
  assert.ok(compact.count <= compact.functionAddresses.length);
});

test('#4638 typed-array function starts are copied out of the caller buffer', () => {
  const funcs = new BigUint64Array([0x1000n, 0x1100n, 0x1300n]);
  const symbols = { funcs, addrs: [], names: [], functionStartsComplete: true };
  const compact = createCompactFunctionSet(symbols, 'arm64');
  const before = materializeCompactFunctionSet(compact);
  assert.deepEqual(before.map((row) => row.size), [0x100, 0x200, 0]);

  funcs[2] = 0x1108n;
  assert.deepEqual(materializeCompactFunctionSet(compact).map((row) => row.size), [0x100, 0x200, 0],
    'writes through the caller view must not change snapshotted function sizes');
});

test('#4638 budget truncation keeps using the snapshot for size derivation', () => {
  const symbols = sourceSymbols();
  symbols.funcs = [0x1000n, 0x1100n, 0x1400n];
  const compact = createCompactFunctionSet(symbols, 'arm64', 2);
  assert.equal(compact.count, 2);
  assert.equal(compact.total, 3);
  assert.equal(compact.complete, false);
  assert.equal(compact.truncationReason, 'function-budget');
  const rows = materializeCompactFunctionSet(compact);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.size), [0x100, 0x300]);
  symbols.funcs.push(0x1500n);
  assert.deepEqual(materializeCompactFunctionSet(compact).map((row) => row.size), [0x100, 0x300]);
});
