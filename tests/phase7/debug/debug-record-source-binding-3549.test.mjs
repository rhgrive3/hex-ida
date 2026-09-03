import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DebugInfoProvider,
  createDebugPage,
  createDebugProviderResult,
  createDebugRecord,
  isDebugRecordAuthoritative,
} from '../../../js/analysis/debug/provider.js';

function result(verdict = 'matched-authoritative', coverage = null) {
  return createDebugProviderResult({
    ecosystem: 'dwarf',
    identity: {
      verdict,
      providerId: 'provider-A',
      providerVersion: '1',
      expected: 'build-A',
      observed: 'build-A',
      method: 'build-id',
      ...(coverage == null ? {} : { coverage }),
    },
  });
}

function record(overrides = {}) {
  return createDebugRecord({
    kind: 'type',
    entityId: 'entity-A',
    providerId: 'provider-A',
    providerVersion: '1',
    buildIdentity: 'build-A',
    ...overrides,
  });
}

test('#3549 matched-authoritative authority is bound to provider/version/build', () => {
  const matched = result();
  assert.equal(isDebugRecordAuthoritative(matched, record()), true);
  assert.equal(isDebugRecordAuthoritative(matched, record({ providerId: 'provider-B' })), false);
  assert.equal(isDebugRecordAuthoritative(matched, record({ providerVersion: '2' })), false);
  assert.equal(isDebugRecordAuthoritative(matched, record({ buildIdentity: 'build-B' })), false);

  // Existing records that predate per-record build identity remain compatible
  // when their provider and provider version still identify the matched source.
  assert.equal(isDebugRecordAuthoritative(matched, record({ buildIdentity: null })), true);
});

test('#3549 matched-partial coverage cannot bypass source binding', () => {
  const partial = result('matched-partial', { recordKinds: ['type'] });
  assert.equal(isDebugRecordAuthoritative(partial, record()), true);
  assert.equal(isDebugRecordAuthoritative(partial, record({ providerId: 'provider-B' })), false);
  assert.equal(isDebugRecordAuthoritative(partial, record({ providerVersion: '2' })), false);
  assert.equal(isDebugRecordAuthoritative(partial, record({ buildIdentity: 'build-B' })), false);
  assert.equal(isDebugRecordAuthoritative(partial, record({ buildIdentity: null })), true);
});

test('#3549 authoritativeRecords filters records from another matched source', () => {
  const records = [
    record({ entityId: 'same-source' }),
    record({ entityId: 'wrong-provider', providerId: 'provider-B', buildIdentity: 'build-B' }),
    record({ entityId: 'wrong-build', buildIdentity: 'build-B' }),
    record({ entityId: 'legacy-null-build', buildIdentity: null }),
  ];
  class FixtureProvider extends DebugInfoProvider {
    constructor() { super({ id: 'provider-A', version: '1', ecosystem: 'dwarf' }); }
    types() { return createDebugPage({ records }); }
  }

  const provider = new FixtureProvider();
  const page = provider.authoritativeRecords(result(), provider.types, null);
  assert.deepEqual(page.records.map((entry) => entry.entityId), ['same-source', 'legacy-null-build']);
});
