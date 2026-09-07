// Regression for #7108: observation identity must be sensitive to payload
// TYPES and canonical values. Type swaps and special-number swaps must not
// retain an observationId, while semantic Map/Set insertion order is irrelevant.
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

function observation(payload) {
  return createRuntimeObservation({
    binding,
    sequence: 1,
    observedAt: '2026-09-08T00:00:00Z',
    kind: 'register',
    payload,
  });
}

const original = observation({ value: 1n });

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
  const twin = observation({ value: 1n });
  assert.equal(twin.observationId, original.observationId);
});

test('#7108 NaN, infinities, signed zero have distinct value witnesses', () => {
  const values = [NaN, Infinity, -Infinity, -0, 0];
  const ids = values.map((value) => observation({ value }).observationId);
  assert.equal(new Set(ids).size, values.length);

  const nan = observation({ value: NaN });
  const forged = { ...nan, payload: { value: Infinity } };
  assert.equal(validateRuntimeObservation(binding, forged).ok, false);
});

test('#7108 Map identity is independent of insertion order', () => {
  const first = observation({ value: new Map([['b', 2], ['a', 1]]) });
  const second = observation({ value: new Map([['a', 1], ['b', 2]]) });
  assert.equal(first.observationId, second.observationId);
});

test('#7108 Set identity is independent of insertion order', () => {
  const first = observation({ value: new Set(['b', 1n, 'a']) });
  const second = observation({ value: new Set(['a', 'b', 1n]) });
  assert.equal(first.observationId, second.observationId);
});