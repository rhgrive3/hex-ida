import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDebugIdentity,
  createDebugProviderResult,
  createDebugRecord,
  isDebugRecordAuthoritative,
} from '../../../js/analysis/debug/provider.js';
import { DEBUG_PROTOCOL_VERSION } from '../../../js/debug/adapter.js';
import { validateRemotePacket } from '../../../js/debug/remote-protocol.js';

function partialResult() {
  return createDebugProviderResult({
    ecosystem: 'dwarf',
    identity: createDebugIdentity({
      verdict: 'matched-partial',
      providerId: 'dwarf',
      providerVersion: '1',
      expected: 'binary-A:module-A:generation-1',
      observed: 'binary-A:module-A:generation-1',
      method: 'build-id',
      coverage: { addresses: ['0x1000'], modules: ['module-A'] },
    }),
    status: {
      snapshotId: 'snapshot-A',
      analyzerId: 't054-debug-authority',
      analyzerVersion: '1',
      completeness: 'complete',
    },
  });
}

function record(overrides = {}) {
  return createDebugRecord({
    kind: 'symbol',
    entityId: 'function-A',
    address: '0x1000',
    providerId: 'dwarf',
    providerVersion: '1',
    buildIdentity: 'binary-A:module-A:generation-1',
    descriptor: { module: 'module-A', isFunction: true },
    ...overrides,
  });
}

test('partial debug authority requires the exact build, module, and generation identity', () => {
  const result = partialResult();
  assert.equal(isDebugRecordAuthoritative(result, record()), true);
  assert.equal(isDebugRecordAuthoritative(result, record({
    buildIdentity: 'binary-A:module-A:generation-2',
  })), false);
  assert.equal(isDebugRecordAuthoritative(result, record({
    buildIdentity: 'binary-A:module-B:generation-1',
    descriptor: { module: 'module-B', isFunction: true },
  })), false);
});

test('malformed remote responses are classified by stable error code', () => {
  assert.throws(
    () => validateRemotePacket({
      version: DEBUG_PROTOCOL_VERSION,
      type: 'response',
      id: 1,
      epoch: 0,
    }),
    (error) => {
      assert.equal(error.code, 'malformed-packet');
      assert.equal(typeof error.message, 'string');
      return true;
    },
  );
});
