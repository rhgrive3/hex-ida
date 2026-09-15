import assert from 'node:assert/strict';
import { proveClampSelect, canonicalThresholdComparison } from '../js/semantic.js';

// #4113: Semantic IR conditions are authority tokens. String() coercion made
// String(['gt']) === 'gt' mint a FACT.CLAMP min/max proof and
// String(['lt']) === 'lt' mint a FACT.THRESHOLD operator from schema-external
// conditions, so a malformed condition promoted to a definite semantic fact.

const lhs = { id: 'a', bits: 64 };
const rhs = { id: 'b', bits: 64 };
const cmp = { op: 'cmp', sub: 'sub', args: [{ value: lhs }, { value: rhs }] };
const flags = { def: cmp };
const selWith = (cond) => ({ op: 'sel', sub: 'sel', args: [{ value: lhs }, { value: rhs }, { value: flags }], cond });

// Malformed CSEL conditions must not prove a clamp.
for (const badCond of [['gt'], ['lt'], { toString: () => 'gt' }, 1, true]) {
  assert.equal(proveClampSelect(selWith(badCond)), null,
    `structured cond ${JSON.stringify(badCond)} must not prove a clamp`);
}

// Primitive string conditions keep min/max semantics.
assert.equal(proveClampSelect(selWith('gt')).kind, 'max');
assert.equal(proveClampSelect(selWith('lt')).kind, 'min');
assert.equal(proveClampSelect(selWith('GT')).kind, 'max');

// Malformed comparison conditions must not canonicalize to a threshold operator.
const subject = { id: 'x', bits: 64 };
const threshold = { const: 100n, bits: 64 };
const cmpWith = (cond) => ({ value: subject, other: threshold, cond });
for (const badCond of [['lt'], ['gt'], { toString: () => 'lt' }, 1, true]) {
  assert.equal(canonicalThresholdComparison(cmpWith(badCond)), null,
    `structured cond ${JSON.stringify(badCond)} must not canonicalize a threshold`);
}

// Primitive string conditions keep operator semantics.
const lt = canonicalThresholdComparison(cmpWith('lt'));
assert.equal(lt.operator, '<');
assert.equal(lt.condition, 'lt');
const hi = canonicalThresholdComparison({ value: threshold, other: subject, cond: 'hi' });
assert.equal(hi.swapped, true);
assert.equal(hi.operator, '<');

console.log('issue-4113 semantic condition primitive-string contract: ok');
