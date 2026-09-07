// Regression for #7108: observation identity must be sensitive to payload
// TYPES. stableDigest canonicalizes 1n, '1' and new Date(1) to the same text,
// which let a type-swapped payload keep the original observationId and pass
// tamper detection.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createRuntimeAuthorityBinding,
  createRuntimeObservation,
  validateRuntimeObservation,
  RuntimeAuthorityTracker,
} from '../js/runtime/authority.js';

const binding = createRuntimeAuthorityBinding({
  providerIdentity: 'provider:p',
  providerProfileId: 'native:remote-debug-v1:qemu-lldb',
  providerVersion: '1',
  runtimeInstanceIdentity: 'runtime:r',
  targetIdentity: 'target:t',
  targetProfileId: 'arm64:a64',
  binaryIdentity: 'bin:b',
  buildIdentity: 'build:x',
  moduleIdentity: 'module:m',
  loadMappingIdentity: 'map:l',
  sessionIdentity: 'session:s',
  capabilityVersion: '1',
  commitSha: 'a'.repeat(40),
  treeSha: 'b'.repeat(40),
  epoch: 0,
});

const original = createRuntimeObservation({
  binding,
  sequence: 1,
  observedAt: '2026-09-08T00:00:00Z',
  kind: 'register',
  payload: { value: 1n },
});

test('#7108 the honest observation validates', () => {
  assert.equal(validateRuntimeObservation(binding, original).ok, true);
});

test('#7108 a bigint→string payload swap fails tamper detection', () => {
  const forged = { ...original, payload: { value: '1' } };
  assert.equal(validateRuntimeObservation(binding, forged).ok, false);
  const tracker = new RuntimeAuthorityTracker(binding);
  const verdict = tracker.accept(forged);
  assert.notEqual(verdict?.status, 'accepted');
});

test('#7108 a bigint→Date payload swap fails tamper detection too', () => {
  const forged = { ...original, payload: { value: new Date(1) } };
  assert.equal(validateRuntimeObservation(binding, forged).ok, false);
});

test('#7108 same-type payloads keep a stable observationId', () => {
  const twin = createRuntimeObservation({
    binding, sequence: 1, observedAt: '2026-09-08T00:00:00Z', kind: 'register', payload: { value: 1n },
  });
  assert.equal(twin.observationId, original.observationId);
});
