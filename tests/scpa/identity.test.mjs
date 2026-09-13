import test from 'node:test';
import assert from 'node:assert/strict';
import { snapshotContractData, exactInteger, exactString, unsignedAddress, signedIntegerText, sha256Text } from '../../js/core/identity/structured.js';
import { createWorldScope, assertWorldScope, worldsEqual, worldContains, diffWorldScopes, createAssumptionSet, assertAssumptionSet } from '../../js/core/identity/world.js';
import { fixture, worldInput } from './helpers.mjs';

for (const [name, make] of Object.entries({
  undefined: () => undefined, symbol: () => Symbol('x'), function: () => () => 1,
  nan: () => NaN, infinity: () => Infinity, negativeInfinity: () => -Infinity, negativeZero: () => -0, unsafeInteger: () => Number.MAX_SAFE_INTEGER + 1,
  boxed: () => new Number(1), date: () => new Date(0), typedArray: () => new Uint8Array([1]),
  customPrototype: () => Object.create({}), sparse: () => Array(1), decorated: () => Object.assign([1], { extra: 2 }),
  hidden: () => Object.defineProperty({}, 'x', { value: 1 }), symbolField: () => ({ [Symbol('x')]: 1 }),
  cycle: () => { const v = {}; v.v = v; return v; }, bigint: () => 1n,
})) test(`strict DTO rejects ${name}`, () => assert.throws(() => snapshotContractData(make())));

test('strict DTO does not execute accessors or custom coercions', () => {
  let called = 0; const v = Object.defineProperty({}, 'x', { enumerable: true, get() { called++; return 1; } });
  assert.throws(() => snapshotContractData(v)); assert.equal(called, 0);
  assert.throws(() => exactInteger({ valueOf() { called++; return 1; } })); assert.equal(called, 0);
});
test('strict DTO preserves own __proto__, detaches and deeply freezes data', () => {
  const v = JSON.parse('{"__proto__":{"polluted":1},"x":[1,{"y":2}]}'); const copy = snapshotContractData(v);
  assert.equal(Object.getPrototypeOf(copy), Object.prototype); assert.equal({}.polluted, undefined);
  assert.ok(Object.hasOwn(copy, '__proto__')); assert.ok(Object.isFrozen(copy.x[1])); v.x[1].y = 4; assert.equal(copy.x[1].y, 2);
});
test('strict DTO alias mode preserves mirrors without exempting expanded traversal from budget', () => {
  const item = { x: 1 }; const data = { a: item, b: item }; const copy = snapshotContractData(data, { preserveAliases: true });
  assert.equal(copy.a, copy.b); assert.notEqual(copy.a, item); const unaliased = snapshotContractData(data); assert.notEqual(unaliased.a, unaliased.b);
  let dag = { x: 1 }; for (let i = 0; i < 12; i++) dag = { a: dag, b: dag };
  assert.throws(() => snapshotContractData(dag, { preserveAliases: true, maxNodes: 100 }), /node-budget/);
});
for (const [limit, value, code] of [['maxNodes', { x: 1 }, 'node'], ['maxDepth', { x: {} }, 'depth'], ['maxProperties', { x: 1 }, 'property'], ['maxBytes', 1, 'byte'], ['maxStringLength', 'x', 'string']]) {
  test(`strict DTO enforces ${limit}`, () => assert.throws(() => snapshotContractData(value, { [limit]: 0 }), new RegExp(code + '-budget')));
}
test('bigint/undefined escape hatches are explicit and bounded', () => {
  assert.equal(snapshotContractData(3n, { allowBigInt: true }), 3n);
  assert.equal(snapshotContractData(undefined, { allowUndefined: true }), undefined);
  assert.throws(() => snapshotContractData(1n << 256n, { allowBigInt: true }), /bigint-out-of-range/);
  assert.throws(() => snapshotContractData(null, { allowUndefined: 1 }), /clone-mode/);
});
for (const invalid of ['', ' x', 'x\n', '\0', 1, null]) test(`exact string rejects ${JSON.stringify(invalid)}`, () => assert.throws(() => exactString(invalid)));
test('numeric/address validators preserve 64-bit endpoints and signed extrema', () => {
  assert.equal(unsignedAddress((1n << 64n) - 1n), '0xffffffffffffffff');
  assert.equal(unsignedAddress(1n << 64n, { allowEnd: true }), '0x10000000000000000');
  assert.throws(() => unsignedAddress(1n << 64n)); assert.throws(() => unsignedAddress(-1n));
  assert.equal(signedIntegerText(-(1n << 127n)), (-(1n << 127n)).toString());
  for (const v of ['-0', '01', '-01', 1n << 127n, -0]) assert.throws(() => signedIntegerText(v));
  assert.equal(sha256Text('ab'.repeat(32)), 'ab'.repeat(32)); assert.throws(() => sha256Text('AB'.repeat(32)));
});
test('world canonical identity is deterministic, immutable, and non-forgeable by JSON', () => {
  const a = fixture().world, b = createWorldScope(worldInput()); assert.ok(worldsEqual(a, b));
  assert.throws(() => assertWorldScope(JSON.parse(JSON.stringify(a))), /noncanonical/);
  assert.equal(worldContains(a, 'binary-scpa-test', 'slice-arm64'), true); assert.equal(worldContains(a, 'binary-scpa-test', 'other-slice'), false);
});
for (const key of ['abi', 'abiRevision', 'exceptionModel', 'memoryModel', 'osModel', 'isaRevision']) test(`world identity binds profile ${key}`, () => {
  const a = fixture().world, b = fixture(d => { d.profile[key] += '-changed'; }).world;
  assert.notEqual(a.id, b.id); assert.ok(diffWorldScopes(a, b).profileChanged);
});
test('world identity binds generation, source generation, loading and coverage independently', () => {
  const a = fixture().world;
  for (const mutate of [d => { d.generation += '-2'; }, d => { d.coverage += '-2'; }, d => { d.environment.dynamicLoading = 'sealed'; }, d => { d.binarySet[0].sourceIdentity = { kind: 'local-immutable', sourceInstance: 'source-a', generation: 'g1' }; }]) assert.notEqual(a.id, fixture(mutate).world.id);
});
test('world binary set ordering is canonical, duplicate slices and supplied false ID are rejected', () => {
  const d = worldInput(); d.binarySet.push({ ...d.binarySet[0], sliceId: 'slice-b' });
  const a = createWorldScope(d); d.binarySet.reverse(); assert.equal(createWorldScope(d).id, a.id);
  d.binarySet.push(d.binarySet[0]); assert.throws(() => createWorldScope(d), /duplicate/);
  assert.throws(() => createWorldScope({ ...worldInput(), id: 'forged' }), /id-mismatch/);
});
test('world delta identifies added, changed and removed slices', () => {
  const a = fixture().world; const d = worldInput(); d.binarySet[0].loadMapHash = 'new-map'; d.binarySet.push({ ...d.binarySet[0], sliceId: 'slice-b' }); const b = createWorldScope(d);
  const delta = diffWorldScopes(a, b); assert.equal(delta.changed.length, 1); assert.equal(delta.added.length, 1); assert.equal(diffWorldScopes(b, a).removed.length, 1);
});
test('assumptions are world-bound, ordered, and declared SAT requires source evidence', () => {
  const { world } = fixture(); const a = createAssumptionSet({ predicates: ['b', 'a', 'a'] }, world);
  assert.deepEqual(a.predicates, ['a', 'b']); assert.throws(() => assertAssumptionSet({ ...a }), /noncanonical/);
  assert.throws(() => assertAssumptionSet(a, fixture(d => { d.generation = 'new'; }).world), /world-mismatch/);
  assert.throws(() => createAssumptionSet({ satisfiability: 'checked-sat' }, world), /evidence-required/);
});
