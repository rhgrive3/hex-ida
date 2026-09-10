import assert from 'node:assert/strict';
import {
  PackageValidationError,
  createPackageEnvelope,
  importPhase12Package,
} from '../../../js/phase12/package-envelope.js';

// #5219: the object input path of importPhase12Package() canonicalized through
// stableStringify() BEFORE any depth/entry budget applied, so a hostile deep
// or cyclic object graph reached the core canonicalizer's recursion (and the
// JS stack) ahead of the resource guards. The object path must apply the same
// bounded-resource discipline as the string/bytes path: budgets first,
// canonicalization after.

function makeEnvelope(payload) {
  return {
    format: 'hex-phase12-package-envelope-v1',
    manifestVersion: 1,
    packageId: 'deep',
    packageVersion: '1',
    kind: 'knowledge',
    provenance: { source: 'local' },
    contentHash: 'placeholder',
    payload,
  };
}

// 1. depth 65 with maxDepth 64 is a typed nesting error, not a pass-through.
let d65 = { leaf: 1 };
for (let i = 0; i < 64; i++) d65 = { next: d65 };
assert.throws(
  () => importPhase12Package(makeEnvelope(d65), { maxDepth: 64 }),
  (error) => error instanceof PackageValidationError && error.code === 'package-nesting-budget-exceeded',
  'depth 65 object must be rejected with the typed nesting budget error',
);

// 2. depth 50,000 must not reach unbounded canonicalizer recursion
//    (main regressed here with RangeError: Maximum call stack size exceeded).
let deep = { leaf: 1 };
for (let i = 0; i < 50_000; i++) deep = { next: deep };
assert.throws(
  () => importPhase12Package(makeEnvelope(deep), { maxDepth: 64 }),
  (error) => error instanceof PackageValidationError && error.code === 'package-nesting-budget-exceeded',
  'deep object must hit the bounded traversal, not the JS stack',
);

// 3. cyclic object input is a typed fail-closed rejection
//    (main leaked a bare TypeError: identity-cyclic-value).
const cyclic = { a: 1 };
cyclic.self = cyclic;
assert.throws(
  () => importPhase12Package(makeEnvelope(cyclic), { maxDepth: 64 }),
  (error) => error instanceof PackageValidationError && error.code === 'package-input-structure-invalid',
  'cyclic object must be rejected with the typed structure error',
);

// 4. entry budget is enforced before canonicalization work.
const wide = {};
for (let i = 0; i < 12; i++) wide[`k${i}`] = i;
assert.throws(
  () => importPhase12Package(makeEnvelope(wide), { maxEntries: 8 }),
  (error) => error instanceof PackageValidationError && error.code === 'package-entry-budget-exceeded',
  'object entry budget must be enforced before canonicalization',
);

// 5. existing string/bytes budget semantics are unchanged.
assert.throws(
  () => importPhase12Package('{"format":"x"}'.repeat(3_000_000)),
  (error) => error instanceof PackageValidationError && error.code === 'package-input-too-large',
  'oversized string input still fails its pre-parse byte budget',
);
const nestedJson = `[${'['.repeat(80)}]${']'.repeat(80)}`;
assert.throws(
  () => importPhase12Package(nestedJson),
  (error) => error instanceof PackageValidationError && error.code === 'package-nesting-budget-exceeded',
  'deep JSON string input still fails the nesting budget',
);
assert.throws(
  () => importPhase12Package(new Uint8Array(33 * 1024 * 1024)),
  (error) => error instanceof PackageValidationError && error.code === 'package-input-too-large',
  'oversized binary input still fails its byte budget',
);

// 6. valid package import keeps its content identity: object import and the
//    equivalent bounded string import agree on the contentHash.
const minted = createPackageEnvelope({ kind: 'knowledge', payload: { rules: [1, 2, 3] } });
const viaObject = importPhase12Package(minted);
const viaString = importPhase12Package(JSON.stringify({ ...minted, dependencies: [...minted.dependencies] }));
assert.equal(viaObject.contentHash, minted.contentHash);
assert.equal(viaString.contentHash, minted.contentHash);
assert.deepEqual(viaObject.payload, viaString.payload);

console.log('issue-5219: package object budget-order regressions green');
