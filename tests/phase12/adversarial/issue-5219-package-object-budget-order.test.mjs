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

// 5. nested binary leaves expand to one canonical entry per byte (jsonSafe
//    Array.from materialization), so an oversized nested view is rejected by
//    the entry budget BEFORE canonicalization work. Main imported an oversized
//    nested DataView whole: countEntries() cannot see DataView contents
//    (no integer-indexed own properties), so the expansion happened during
//    stableStringify ahead of every budget.
const oversizedView = new DataView(new ArrayBuffer(1_100_000));
const mintedOversizedView = createPackageEnvelope({ kind: 'knowledge', payload: { blob: oversizedView } });
assert.throws(
  () => importPhase12Package(mintedOversizedView),
  (error) => error instanceof PackageValidationError && error.code === 'package-entry-budget-exceeded',
  'oversized nested binary view must be rejected before canonicalization',
);
const oversizedTypedArray = new Uint8Array(1_100_000);
const mintedOversizedTypedArray = createPackageEnvelope({ kind: 'knowledge', payload: { blob: oversizedTypedArray } });
assert.throws(
  () => importPhase12Package(mintedOversizedTypedArray),
  (error) => error instanceof PackageValidationError && error.code === 'package-entry-budget-exceeded',
  'oversized nested typed array must hit the entry budget',
);
const smallView = new Uint8Array([1, 2, 3, 4]);
const mintedSmallView = createPackageEnvelope({ kind: 'knowledge', payload: { blob: smallView } });
const viaSmallView = importPhase12Package(mintedSmallView);
assert.equal(viaSmallView.contentHash, mintedSmallView.contentHash);
const smallDataView = new DataView(new ArrayBuffer(8));
const mintedSmallDataView = createPackageEnvelope({ kind: 'knowledge', payload: { blob: smallDataView } });
const viaSmallDataView = importPhase12Package(mintedSmallDataView);
assert.equal(viaSmallDataView.contentHash, mintedSmallDataView.contentHash);

// 6. the conservative canonical-byte preflight bound is never weaker than
//    maxBytes: a stricter byte limit below the independent default entry cap
//    rejects BEFORE canonicalization. Pre-fix (entry charge only) the scan
//    passed (~500k entries < 1M) and stableStringify expanded the half-megabyte
//    blob before the post-stringify byte check ran; pairing the oversized blob
//    with a cyclic reference makes that ordering observable: pre-fix leaked the
//    canonicalizer's TypeError, the preflight now rejects with the byte code.
const byteBoundPayload = { blob: new Uint8Array(500_000) };
byteBoundPayload.next = byteBoundPayload;
assert.throws(
  () => importPhase12Package(makeEnvelope(byteBoundPayload), { maxBytes: 1024 }),
  (error) => error instanceof PackageValidationError && error.code === 'package-input-too-large',
  'a byte limit below the entry cap must reject before canonicalization',
);
const plainByteBound = { blob: new Uint8Array(500_000) };
assert.throws(
  () => importPhase12Package(makeEnvelope(plainByteBound), { maxBytes: 1024 }),
  (error) => error instanceof PackageValidationError && error.code === 'package-input-too-large',
  'oversized object against a strict byte limit still fails the byte code',
);
const smallWithinBytes = createPackageEnvelope({ kind: 'knowledge', payload: { rules: [1, 2, 3] } });
assert.equal(importPhase12Package(smallWithinBytes, { maxBytes: 8192 }).contentHash, smallWithinBytes.contentHash);

// 7. Map key/value ancestry is path-local: a shared (non-cyclic) reference
//    between a Map key and its value, or across siblings, is valid canonical
//    input and must not be misclassified as cyclic by the bounded preflight.
const shared = { id: 'shared' };
const sharedMapEnvelope = createPackageEnvelope({
  kind: 'knowledge',
  payload: { mapping: new Map([[shared, shared]]), alias: shared },
});
const viaSharedMap = importPhase12Package(sharedMapEnvelope);
assert.equal(viaSharedMap.contentHash, sharedMapEnvelope.contentHash);
const selfReferencingValue = new Map([[shared, { back: shared }]]);
const sharedSubtreeEnvelope = createPackageEnvelope({ kind: 'knowledge', payload: { mapping: selfReferencingValue } });
assert.equal(importPhase12Package(sharedSubtreeEnvelope).contentHash, sharedSubtreeEnvelope.contentHash);

// 8. existing string/bytes budget semantics are unchanged.
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

// 9. valid package import keeps its content identity: object import and the
//    equivalent bounded string import agree on the contentHash.
const minted = createPackageEnvelope({ kind: 'knowledge', payload: { rules: [1, 2, 3] } });
const viaObject = importPhase12Package(minted);
const viaString = importPhase12Package(JSON.stringify({ ...minted, dependencies: [...minted.dependencies] }));
assert.equal(viaObject.contentHash, minted.contentHash);
assert.equal(viaString.contentHash, minted.contentHash);
assert.deepEqual(viaObject.payload, viaString.payload);

console.log('issue-5219: package object budget-order regressions green');
