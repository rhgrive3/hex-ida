import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDebugIdentity,
  createDebugRecord,
  createDebugPage,
  createDebugProviderResult,
  applyDebugTypesToGraph,
  isDebugRecordAuthoritative,
} from '../../../js/analysis/debug/provider.js';

function makeResult(overrides = {}) {
  return createDebugProviderResult({
    ecosystem: 'dwarf',
    identity: createDebugIdentity({
      verdict: 'matched-authoritative',
      providerId: 'dwarf-provider',
      providerVersion: '1.0.0',
      expected: 'build-1',
      observed: 'build-1',
      method: 'build-id',
      ...overrides,
    }),
    status: {
      snapshotId: 'snap-1',
      analyzerId: 'debug',
      analyzerVersion: '1',
      completeness: 'complete',
    },
  });
}

function canonicalRecord(overrides = {}) {
  return createDebugRecord({
    kind: 'type',
    entityId: 'entity:record',
    providerId: 'dwarf-provider',
    providerVersion: '1.0.0',
    buildIdentity: 'build-1',
    evidenceIds: ['dwarf:record'],
    descriptor: { layer: 'nominal', claim: { name: 'ValidType' } },
    ...overrides,
  });
}

test('issue #6174: raw record lacking provider provenance cannot gain hard authority', () => {
  const result = makeResult();
  const rawRecord = {
    kind: 'type',
    entityId: 'entity:1',
    descriptor: { layer: 'nominal', claim: { kind: 'struct', name: 'Wrong' } },
    evidenceIds: [],
  };

  assert.equal(isDebugRecordAuthoritative(result, rawRecord), false, 'Raw record lacking providerId must not be authoritative');

  const page = createDebugPage({ records: [rawRecord] });
  const hard = [];
  const soft = [];
  const graph = {
    addHardConstraint(value) { hard.push(value); },
    addSoftEvidence(value) { soft.push(value); },
  };

  const applied = applyDebugTypesToGraph(graph, result, page);
  assert.equal(applied.hard, 0, 'Must not create hard constraints from raw unvalidated records');
  assert.equal(hard.length, 0);
});

test('issue #6174: provider id, version, and observed build must all match authority', () => {
  const result = makeResult();

  assert.equal(isDebugRecordAuthoritative(result, canonicalRecord({ providerId: 'other-provider' })), false);
  assert.equal(isDebugRecordAuthoritative(result, canonicalRecord({ providerVersion: '2.0.0' })), false);
  assert.equal(isDebugRecordAuthoritative(result, canonicalRecord({ buildIdentity: 'build-2' })), false);
  assert.equal(isDebugRecordAuthoritative(result, canonicalRecord({ buildIdentity: null })), false);
});

test('issue #6174: constructor-invalid raw records cannot reach hard authority', () => {
  const result = makeResult();
  const valid = canonicalRecord();
  const malformed = [
    { label: 'undefined descriptor', record: { ...valid, descriptor: undefined } },
    { label: 'object evidence id', record: { ...valid, evidenceIds: [{}] } },
    { label: 'blank evidence id', record: { ...valid, evidenceIds: [''] } },
    { label: 'structured address', record: { ...valid, address: ['0x1000'] } },
    { label: 'structured size', record: { ...valid, sizeBytes: { value: 8 } } },
  ];

  for (const { label, record } of malformed) {
    assert.equal(isDebugRecordAuthoritative(result, record), false, `${label} must not be authoritative`);
    const hard = [];
    const graph = {
      addHardConstraint(value) { hard.push(value); },
      addSoftEvidence() {},
    };
    const applied = applyDebugTypesToGraph(graph, result, createDebugPage({ records: [record] }));
    assert.equal(applied.hard, 0, `${label} must not create hard constraints`);
    assert.equal(hard.length, 0, `${label} must not reach the hard-constraint sink`);
  }
});

test('issue #6174: coercible but non-canonical record fields are not authority', () => {
  const result = makeResult();
  const valid = canonicalRecord();

  assert.equal(isDebugRecordAuthoritative(result, { ...valid, sizeBytes: '8' }), false);
  assert.equal(isDebugRecordAuthoritative(result, { ...valid, address: ' 0x1000 ' }), false);
  assert.equal(isDebugRecordAuthoritative(result, { ...valid, evidenceIds: [' dwarf:record '] }), false);
});

test('issue #6174: canonical record with matching provenance remains authoritative', () => {
  const result = makeResult();
  const validRecord = canonicalRecord({
    entityId: 'entity:3',
    evidenceIds: ['dwarf:1'],
  });

  assert.equal(isDebugRecordAuthoritative(result, validRecord), true);

  const hard = [];
  const graph = {
    addHardConstraint(value) { hard.push(value); },
    addSoftEvidence() {},
  };

  const applied = applyDebugTypesToGraph(graph, result, createDebugPage({ records: [validRecord] }));
  assert.equal(applied.hard, 1);
  assert.equal(hard.length, 1);
  assert.equal(hard[0].providerVersion, '1.0.0');
  assert.equal(hard[0].buildIdentity, 'build-1');
});
