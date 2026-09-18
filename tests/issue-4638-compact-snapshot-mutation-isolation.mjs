import assert from 'node:assert/strict';
import {
  createCompactFunctionSet,
  materializeCompactFunctionSet,
} from '../js/diff/compact-function-set.js';

const funcs = [0x1000n, 0x1100n];
const addrs = [0x1000n, 0x1100n];
const names = ['alpha', 'beta'];
const symbols = { funcs, addrs, names, functionStartsComplete: true };

const compact = createCompactFunctionSet(symbols, 'arm64');

assert.ok(Object.isFrozen(compact));
assert.equal(compact.count, 2);
assert.equal(compact.total, 2);
assert.equal(compact.complete, true);
assert.notEqual(compact.functionAddresses, funcs);
assert.notEqual(compact.symbolAddresses, addrs);
assert.notEqual(compact.symbolNames, names);
assert.deepEqual(compact.functionAddresses, funcs);
assert.deepEqual(compact.symbolAddresses, addrs);
assert.deepEqual(compact.symbolNames, names);

const before = materializeCompactFunctionSet(compact);
assert.equal(before.length, 2);
assert.deepEqual(before.map((row) => row.size), [0x100, 0]);
assert.deepEqual(before.map((row) => row.name), ['alpha', 'beta']);

assert.ok(Object.isFrozen(compact.functionAddresses));
assert.ok(Object.isFrozen(compact.symbolAddresses));
assert.ok(Object.isFrozen(compact.symbolNames));

assert.throws(() => compact.functionAddresses.push(0x1200n), TypeError);
assert.throws(() => { compact.functionAddresses[0] = 0x9999n; }, TypeError);
assert.throws(() => compact.symbolAddresses.push(0x9000n), TypeError);
assert.throws(() => { compact.symbolNames[1] = 'renamed'; }, TypeError);

// The snapshot is isolated in both directions: freezing the published copy
// must not freeze or otherwise alter the caller's input columns.
funcs.push(0x1200n);
addrs.push(0x9000n);
names[1] = 'renamed';

assert.equal(compact.functionAddresses.length, 2);
assert.equal(compact.count, 2);
assert.equal(compact.total, 2);

const after = materializeCompactFunctionSet(compact);
assert.deepEqual(after, before);
assert.equal(after[1].size, 0);
assert.deepEqual(after.map((row) => row.name), ['alpha', 'beta']);

const recreated = createCompactFunctionSet({
  funcs: [0x1000n, 0x1100n],
  addrs: [0x1000n, 0x1100n],
  names: ['alpha', 'beta'],
  functionStartsComplete: true,
}, 'arm64');
assert.equal(recreated.count, 2);
assert.deepEqual(materializeCompactFunctionSet(recreated), before);

const sanitized = createCompactFunctionSet({
  funcs: [0x1000n, 0x2000n],
  addrs: [['4096'], 0x2000n],
  names: ['forged', 'second'],
  functionStartsComplete: true,
}, 'arm64');
assert.ok(Object.isFrozen(sanitized.functionAddresses));
assert.ok(Object.isFrozen(sanitized.symbolAddresses));
assert.ok(Object.isFrozen(sanitized.symbolNames));
assert.deepEqual(materializeCompactFunctionSet(sanitized).map((row) => row.name), [null, 'second']);

const typed = new BigUint64Array([0x1000n, 0x1100n]);
const typedCompact = createCompactFunctionSet({ funcs: typed, addrs: [], names: [], functionStartsComplete: true }, 'arm64');
typed[1] = 0x7000n;
assert.deepEqual(materializeCompactFunctionSet(typedCompact).map((row) => row.size), [0x100, 0]);

const truncated = createCompactFunctionSet({ funcs: [0x1000n, 0x1100n, 0x1200n], addrs: [], names: [], functionStartsComplete: true }, 'arm64', 2);
assert.equal(truncated.count, 2);
assert.equal(truncated.total, 3);
assert.deepEqual(materializeCompactFunctionSet(truncated).map((row) => row.size), [0x100, 0x100]);

console.log('issue-4638 compact snapshot mutation isolation: ok');
