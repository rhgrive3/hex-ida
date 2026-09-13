// Regression for #5076: js/phase12/package-envelope.js countEntries() charged a
// container's entry count into state.entries but only tested `> maxEntries` AFTER
// recursing through every child, so a container whose size alone already blew the
// entry budget still walked all of its children (invoking caller getters and
// descending subtrees) before failing. maxEntries did not bound traversal *work*,
// only the final accept/reject decision. The fix must check the budget immediately
// after charging each container, before descending into children, while keeping the
// entries === maxEntries acceptance and the depth/byte/string/token budgets intact.
import assert from 'node:assert/strict';

import {
  PackageValidationError,
  createPackageEnvelope,
  parseBoundedPackageInput,
  validatePackageEnvelope,
} from '../js/phase12/package-envelope.js';

// A structurally valid envelope whose provenance binding checks pass, so
// validateEnvelopeShape() reaches countEntries(payload) — the production path the
// issue names for payload validation. The content-identity check runs AFTER
// countEntries, so an over-budget payload fails closed on the entry code here.
const seedEnvelope = createPackageEnvelope({ kind: 'knowledge', payload: { seed: 1 } });

function envelopeWithPayload(payload) {
  return { ...seedEnvelope, payload };
}

function budgetResult(payload, options) {
  return validatePackageEnvelope(envelopeWithPayload(payload), options);
}

// 1. root Array whose length alone exceeds maxEntries must stop before iterating
//    a single child: a getter at index 0 is never touched by the fixed traversal.
let arrayChildReads = 0;
const wideArray = new Array(100);
Object.defineProperty(wideArray, 0, {
  enumerable: true,
  get() {
    arrayChildReads += 1;
    return 0;
  },
});
const arrayResult = budgetResult(wideArray, { maxEntries: 1 });
assert.equal(arrayResult.ok, false, 'oversized root array must be rejected');
assert.equal(arrayResult.code, 'package-entry-budget-exceeded', 'root array must hit the entry budget code');
assert.equal(arrayChildReads, 0, 'fail-fast must not iterate any child element once the root length exceeds the budget');

// 2. object whose own key count exceeds maxEntries must stop before reading any
//    property value (no getter/child traversal).
let objectChildReads = 0;
const wideObject = {};
Object.defineProperty(wideObject, 'x', {
  enumerable: true,
  get() {
    objectChildReads += 1;
    return 1;
  },
});
wideObject.y = 2;
wideObject.z = 3;
const objectResult = budgetResult(wideObject, { maxEntries: 1 });
assert.equal(objectResult.ok, false, 'oversized object key set must be rejected');
assert.equal(objectResult.code, 'package-entry-budget-exceeded', 'object keys must hit the entry budget code');
assert.equal(objectChildReads, 0, 'fail-fast must not read a property value once the key count exceeds the budget');

// 3. nested container: the running total crossing maxEntries inside a child must
//    stop before that child descends into its own children.
let nestedChildReads = 0;
const nested = { a: {}, b: 1 };
Object.defineProperty(nested.a, 'c', {
  enumerable: true,
  get() {
    nestedChildReads += 1;
    return 1;
  },
});
Object.defineProperty(nested.a, 'd', {
  enumerable: true,
  get() {
    nestedChildReads += 1;
    return 2;
  },
});
const nestedResult = budgetResult(nested, { maxEntries: 2 });
assert.equal(nestedResult.ok, false, 'cumulative nested entries crossing the budget must be rejected');
assert.equal(nestedResult.code, 'package-entry-budget-exceeded', 'nested container must hit the entry budget code');
assert.equal(nestedChildReads, 0, 'fail-fast must not descend into a child container that pushes the running total past the budget');

// 4. entries === maxEntries stays accepted (budget is exclusive, not off-by-one).
const exactly = createPackageEnvelope({ kind: 'knowledge', payload: { a: 1, b: 2, c: 3 } });
assert.equal(validatePackageEnvelope(exactly, { maxEntries: 3 }).ok, true, 'entries equal to maxEntries must remain valid');
assert.equal(
  validatePackageEnvelope(exactly, { maxEntries: 2 }).code,
  'package-entry-budget-exceeded',
  'entries one over maxEntries must be rejected',
);

// 5. cumulative accounting across many small containers is still enforced: the
//    moving total must trip even when no single container exceeds maxEntries.
const chain = { k1: { k2: { k3: { k4: 1 } } } };
const cumulativeResult = budgetResult(chain, { maxEntries: 3 });
assert.equal(cumulativeResult.ok, false, 'accumulated entries across nested containers must still be rejected');
assert.equal(cumulativeResult.code, 'package-entry-budget-exceeded', 'cumulative traversal must trip the entry budget');

// 6. the maxDepth budget is untouched by the fix: an over-nested graph still
//    fails with the nesting code, not the entry code.
let deep = { leaf: 1 };
for (let i = 0; i < 70; i++) deep = { next: deep };
const depthResult = budgetResult(deep, { maxDepth: 64, maxEntries: 1_000_000 });
assert.equal(depthResult.ok, false, 'over-nested payload must still be rejected');
assert.equal(depthResult.code, 'package-nesting-budget-exceeded', 'nesting budget semantics must be unchanged');

// 7. the bounded string import path (parseBoundedPackageInput -> countEntries)
//    keeps enforcing the entry budget after JSON.parse, both ways.
assert.throws(
  () => parseBoundedPackageInput('{"a":1,"b":2,"c":3,"d":4}', { maxEntries: 2 }),
  (error) => error instanceof PackageValidationError && error.code === 'package-entry-budget-exceeded',
  'over-budget parsed input must still be rejected with the typed entry error',
);
const parsedWithin = parseBoundedPackageInput('{"a":1,"b":2,"c":3}', { maxEntries: 3 });
assert.deepEqual(parsedWithin.value, { a: 1, b: 2, c: 3 }, 'a within-budget parsed input must pass the entry budget');

console.log('issue-5076: package entry budget fail-fast regressions green');
