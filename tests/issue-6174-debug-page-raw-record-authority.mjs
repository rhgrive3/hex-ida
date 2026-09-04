import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDebugIdentity,
  createDebugRecord,
  createDebugPage,
  createDebugProviderResult,
  applyDebugTypesToGraph,
  isDebugRecordAuthoritative,
} from '../js/analysis/debug/provider.js';

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

test('issue #6174: raw record lacking provider provenance cannot gain hard authority', () => {
  const result = makeResult();

  // Raw record missing providerId, providerVersion, buildIdentity
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

test('issue #6174: record from foreign provider cannot gain hard authority', () => {
  const result = makeResult();

  const foreignRecord = createDebugRecord({
    kind: 'type',
    entityId: 'entity:2',
    providerId: 'other-provider',
    providerVersion: '1.0.0',
    buildIdentity: 'build-1',
    evidenceIds: ['e:1'],
    descriptor: { layer: 'nominal', claim: { name: 'Foo' } },
  });

  assert.equal(isDebugRecordAuthoritative(result, foreignRecord), false, 'Record with foreign providerId must not be authoritative');
});

test('issue #6174: canonical record with matching provenance remains authoritative', () => {
  const result = makeResult();

  const validRecord = createDebugRecord({
    kind: 'type',
    entityId: 'entity:3',
    providerId: 'dwarf-provider',
    providerVersion: '1.0.0',
    buildIdentity: 'build-1',
    evidenceIds: ['dwarf:1'],
    descriptor: { layer: 'nominal', claim: { name: 'ValidType' } },
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

console.log('issue #6174 test file loaded.');
