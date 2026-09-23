// Regression tests for Issue #9487:
// key(addr) in js/names.js must parse negative hex strings like "-0x10" without throwing SyntaxError.
import assert from 'node:assert/strict';
import { NoteStore } from '../js/names.js';

const store = new NoteStore('test-issue-9487');

// Setting name with decimal negative address
store.setName('-16', 'valNeg16');
assert.equal(store.nameOf('-16'), 'valNeg16');
assert.equal(store.nameOf(-16n), 'valNeg16');
assert.equal(store.nameOf('-0x10'), 'valNeg16');
assert.equal(store.nameOf('-0X10'), 'valNeg16');

// Overwriting or setting with negative hex string
store.setName('-0x10', 'valNegHex');
assert.equal(store.nameOf('-16'), 'valNegHex');
assert.equal(store.nameOf(-16n), 'valNegHex');
assert.equal(store.nameOf('-0x10'), 'valNegHex');
assert.equal(store.nameOf('-0X10'), 'valNegHex');

// Test comments
store.setComment('-0x20', 'commentNeg32');
assert.equal(store.comment('-32'), 'commentNeg32');
assert.equal(store.comment(-32n), 'commentNeg32');
assert.equal(store.comment('-0x20'), 'commentNeg32');

console.log('issue #9487 regression passed');
