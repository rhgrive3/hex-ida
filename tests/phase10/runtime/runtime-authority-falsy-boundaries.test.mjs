import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RuntimeAuthorityTracker,
  createRuntimeAuthorityBinding,
  createRuntimeObservation,
} from '../../../js/runtime/authority.js';

const OBSERVED_AT = '2026-09-02T00:00:00Z';
const ISSUED_AT = '2026-09-02T00:00:00Z';

function createBinding() {
  return createRuntimeAuthorityBinding({
    providerIdentity: 'provider-local',
    runtimeInstanceIdentity: 'runtime-local-1',
    targetIdentity: 'target-local-1',
    binaryIdentity: 'binary-local-1',
    moduleIdentity: 'module-local-1',
    loadMappingIdentity: 'mapping-local-1',
    sessionIdentity: 'session-local-1',
    capabilityVersion: 'runtime-capabilities/v1',
    epoch: 0,
  });
}

function observationInput(binding, overrides = {}) {
  return {
    binding,
    sequence: 0,
    observedAt: OBSERVED_AT,
    ...overrides,
  };
}

function mutationInput(overrides = {}) {
  return {
    explicitApproval: true,
    actorIdentity: 'local-user',
    operation: 'write-memory',
    issuedAt: ISSUED_AT,
    ...overrides,
  };
}

test('P10 runtime observation kind defaults only for nullish input', () => {
  const binding = createBinding();

  assert.equal(createRuntimeObservation(observationInput(binding)).kind, 'observation');
  assert.equal(createRuntimeObservation(observationInput(binding, { kind: null })).kind, 'observation');
  assert.equal(createRuntimeObservation(observationInput(binding, { kind: 'trace-marker' })).kind, 'trace-marker');

  for (const kind of [false, 0, '']) {
    assert.throws(
      () => createRuntimeObservation(observationInput(binding, { kind })),
      /runtime-observation-kind-required/,
    );
  }
});

test('P10 runtime mutation scope rejects explicit malformed falsy values', () => {
  const binding = createBinding();

  for (const scope of [false, 0, '', []]) {
    const tracker = new RuntimeAuthorityTracker(binding);
    assert.throws(
      () => tracker.authorizeMutation(mutationInput({ scope })),
      /runtime-mutation-scope-invalid/,
    );
  }
});

test('P10 runtime mutation scope preserves object input and nullish defaults', () => {
  const binding = createBinding();
  const scope = { address: '0x1000', length: 4 };
  const tracker = new RuntimeAuthorityTracker(binding);
  const authorized = tracker.authorizeMutation(mutationInput({ scope }));

  assert.equal(authorized.status, 'authorized');
  assert.deepEqual(authorized.token.scope, scope);
  assert.notEqual(authorized.token.scope, scope);

  const omitted = new RuntimeAuthorityTracker(binding).authorizeMutation(mutationInput());
  const explicitNull = new RuntimeAuthorityTracker(binding).authorizeMutation(mutationInput({ scope: null }));
  assert.deepEqual(omitted.token.scope, {});
  assert.deepEqual(explicitNull.token.scope, {});
  assert.equal(omitted.token.tokenId, explicitNull.token.tokenId);
});
