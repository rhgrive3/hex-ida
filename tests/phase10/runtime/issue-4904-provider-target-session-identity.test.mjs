import assert from 'node:assert/strict';
import test from 'node:test';

import { RuntimeProviderSession } from '../../../js/runtime/provider.js';

function provider() {
  return {
    descriptor() {
      return { id: 'provider-4904', version: '1', kind: 'debugger', facets: [] };
    },
  };
}

function session({ request = {}, target = {} } = {}) {
  return new RuntimeProviderSession({
    provider: provider(),
    request: {
      binaryId: 'binary-A',
      sliceId: 'slice-A',
      sessionNonce: 'nonce-4904',
      ...request,
    },
    target,
  });
}

function identityMismatch(error, field) {
  return error?.code === 'runtime-target-identity-mismatch'
    && error?.details?.field === field;
}

test('P10 #4904 rejects provider target binary identity that contradicts the session request', () => {
  assert.throws(
    () => session({ target: { primaryBinaryId: 'binary-B' } }),
    (error) => identityMismatch(error, 'primaryBinaryId'),
  );
});

test('P10 #4904 rejects provider target slice identity that contradicts the session request', () => {
  assert.throws(
    () => session({ target: { primarySliceId: 'slice-B' } }),
    (error) => identityMismatch(error, 'primarySliceId'),
  );
});

test('P10 #4904 keeps canonical matching request and target identities', () => {
  const value = session({
    request: { binaryId: ' binary-A ', sliceId: ' slice-A ' },
    target: { primaryBinaryId: 'binary-A', primarySliceId: 'slice-A' },
  });
  assert.equal(value.target.primaryBinaryId, 'binary-A');
  assert.equal(value.target.primarySliceId, 'slice-A');
});

test('P10 #4904 request identity remains authoritative when target identity is omitted or nullish', () => {
  const omitted = session();
  assert.equal(omitted.target.primaryBinaryId, 'binary-A');
  assert.equal(omitted.target.primarySliceId, 'slice-A');

  const nullish = session({ target: { primaryBinaryId: null, primarySliceId: null } });
  assert.equal(nullish.target.primaryBinaryId, 'binary-A');
  assert.equal(nullish.target.primarySliceId, 'slice-A');
});

test('P10 #4904 legacy target identity aliases cannot contradict request identity', () => {
  assert.throws(
    () => session({ target: { binaryId: 'binary-B' } }),
    (error) => identityMismatch(error, 'primaryBinaryId'),
  );
  assert.throws(
    () => session({ target: { sliceId: 'slice-B' } }),
    (error) => identityMismatch(error, 'primarySliceId'),
  );
});

test('P10 #4904 snapshots request and provider target identity getters once', () => {
  let requestBinaryReads = 0;
  let requestSliceReads = 0;
  let targetBinaryReads = 0;
  let targetSliceReads = 0;
  const request = {
    get binaryId() {
      requestBinaryReads++;
      return requestBinaryReads === 1 ? 'binary-A' : 'binary-B';
    },
    get sliceId() {
      requestSliceReads++;
      return requestSliceReads === 1 ? 'slice-A' : 'slice-B';
    },
    sessionNonce: 'nonce-stateful-4904',
  };
  const target = {
    get primaryBinaryId() {
      targetBinaryReads++;
      return targetBinaryReads === 1 ? 'binary-A' : 'binary-B';
    },
    get primarySliceId() {
      targetSliceReads++;
      return targetSliceReads === 1 ? 'slice-A' : 'slice-B';
    },
  };

  const value = new RuntimeProviderSession({ provider: provider(), request, target });
  assert.equal(value.target.primaryBinaryId, 'binary-A');
  assert.equal(value.target.primarySliceId, 'slice-A');
  assert.equal(requestBinaryReads, 1);
  assert.equal(requestSliceReads, 1);
  assert.equal(targetBinaryReads, 1);
  assert.equal(targetSliceReads, 1);
});

test('P10 #4904 permits provider slice authority when the request does not bind a slice', () => {
  const value = session({
    request: { sliceId: undefined },
    target: { primarySliceId: 'slice-provider' },
  });
  assert.equal(value.target.primaryBinaryId, 'binary-A');
  assert.equal(value.target.primarySliceId, 'slice-provider');
});

test('P10 #4904 applies the same binary invariant to the request binaryHash alias', () => {
  const request = { binaryId: undefined, binaryHash: ' hash-A ', sliceId: undefined };
  const matching = session({ request, target: { primaryBinaryId: 'hash-A' } });
  assert.equal(matching.target.primaryBinaryId, 'hash-A');
  assert.throws(
    () => session({ request, target: { primaryBinaryId: 'hash-B' } }),
    (error) => identityMismatch(error, 'primaryBinaryId'),
  );
});
