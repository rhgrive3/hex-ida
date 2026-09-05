import assert from 'node:assert/strict';
import test from 'node:test';

import { RuntimeAuthorityTracker } from '../../../js/runtime/authority.js';

function validBinding(overrides = {}) {
  return {
    providerIdentity: 'provider-1',
    runtimeInstanceIdentity: 'runtime-1',
    targetIdentity: 'target-1',
    binaryIdentity: 'binary-1',
    moduleIdentity: 'module-1',
    loadMappingIdentity: 'mapping-1',
    sessionIdentity: 'session-1',
    capabilityVersion: 'cap-v1',
    epoch: 7,
    ...overrides,
  };
}

test('P10 runtime nextEpoch inherits only nullish session identity overrides (#3580)', () => {
  for (const override of [{}, { sessionIdentity: null }, { sessionIdentity: undefined }]) {
    const tracker = new RuntimeAuthorityTracker(validBinding());
    const next = tracker.nextEpoch(override);
    assert.equal(next.sessionIdentity, 'session-1');
    assert.equal(next.epoch, 8);
    assert.equal(tracker.closed, true);
  }
});

test('P10 runtime nextEpoch accepts a valid session identity override (#3580)', () => {
  const tracker = new RuntimeAuthorityTracker(validBinding());
  const next = tracker.nextEpoch({ sessionIdentity: 'session-2' });
  assert.equal(next.sessionIdentity, 'session-2');
  assert.equal(next.epoch, 8);
  assert.equal(tracker.closed, true);
});

test('P10 runtime nextEpoch rejects explicit malformed session identities before close (#3580)', () => {
  for (const sessionIdentity of [false, 0, '', {}, []]) {
    const tracker = new RuntimeAuthorityTracker(validBinding());
    assert.throws(
      () => tracker.nextEpoch({ sessionIdentity }),
      /runtime-session-identity-required/,
    );
    assert.equal(tracker.closed, false);
    assert.equal(tracker.binding.sessionIdentity, 'session-1');
    assert.equal(tracker.binding.epoch, 7);
  }
});
