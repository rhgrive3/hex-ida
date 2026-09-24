import assert from 'node:assert/strict';
import test from 'node:test';

import { createProjectionIrObserver } from '../js/core/identity/live-data.js';

test('projection observer reuses validated entry lists for frozen certified data', () => {
  const tracked = [];
  let value = Object.freeze({ leaf: 1 });
  tracked.push(value);
  for (let index = 0; index < 64; index += 1) {
    value = Object.freeze({ index, next: value });
    tracked.push(value);
  }
  const trackedSet = new WeakSet(tracked);
  const expectedFields = 1 + 64 * 2;

  const original = Object.getOwnPropertyDescriptor;
  let reads = 0;
  Object.getOwnPropertyDescriptor = function counted(owner, key) {
    if (trackedSet.has(owner)) reads += 1;
    return original(owner, key);
  };
  let observation;
  try {
    const observer = createProjectionIrObserver();
    observation = observer.captureCertifiedData([value]);
  } finally {
    Object.getOwnPropertyDescriptor = original;
  }

  assert.equal(observation.matches(), true);
  // Eligibility and certification both need the same exact descriptor values.
  // The observer should validate them once and reuse that frozen entry list,
  // rather than reading the full chain twice.
  assert.ok(reads <= expectedFields + 8,
    `frozen descriptor list was rescanned: ${reads} reads for ${expectedFields} fields`);
});
