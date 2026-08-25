import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyDebugTypesToGraph,
  createDebugIdentity,
  createDebugPage,
  createDebugProviderResult,
  createDebugRecord,
  debugFunctionEvidence,
  isDebugRecordAuthoritative,
} from '../../../js/analysis/debug/provider.js';

function resultFor(identity) {
  return createDebugProviderResult({
    identity,
    ecosystem: 'pdb',
    status: {
      snapshotId: 'snapshot',
      analyzerId: 'debug',
      analyzerVersion: '1',
      completeness: 'complete',
    },
  });
}

function record(input = {}) {
  return createDebugRecord({
    kind: input.kind ?? 'type',
    entityId: input.entityId ?? 'entity-A',
    address: input.address ?? null,
    name: input.name ?? null,
    providerId: 'pdb',
    providerVersion: '1',
    buildIdentity: 'build-A-partial',
    descriptor: input.descriptor ?? { claim: { kind: 'int' } },
  });
}

test('matched-partial coverage outside the record fails closed to soft evidence', () => {
  const identity = createDebugIdentity({
    verdict: 'matched-partial',
    providerId: 'pdb',
    providerVersion: '1',
    expected: 'build-A',
    observed: 'build-A-partial',
    method: 'partial-id',
    coverage: { module: 'only-module-A' },
  });
  const result = resultFor(identity);
  const outside = record({ entityId: 'outside-coverage' });
  assert.equal(isDebugRecordAuthoritative(result, outside), false);

  const calls = [];
  const graph = {
    addHardConstraint(value) { calls.push(['hard', value]); },
    addSoftEvidence(value) { calls.push(['soft', value]); },
  };
  const applied = applyDebugTypesToGraph(graph, result, createDebugPage({ records: [outside] }));
  assert.deepEqual(applied, { hard: 0, soft: 1, skipped: 0 });
  assert.equal(calls[0][0], 'soft');
});

test('matched-partial record explicitly covered by entity id may be authoritative', () => {
  const identity = createDebugIdentity({
    verdict: 'matched-partial',
    providerId: 'pdb',
    providerVersion: '1',
    expected: 'build-A',
    observed: 'build-A-partial',
    method: 'partial-id',
    coverage: { entityIds: ['entity-A'] },
  });
  const result = resultFor(identity);
  const covered = record();
  assert.equal(isDebugRecordAuthoritative(result, covered), true);

  const calls = [];
  const graph = {
    addHardConstraint(value) { calls.push(['hard', value]); },
    addSoftEvidence(value) { calls.push(['soft', value]); },
  };
  const applied = applyDebugTypesToGraph(graph, result, createDebugPage({ records: [covered] }));
  assert.deepEqual(applied, { hard: 1, soft: 0, skipped: 0 });
  assert.equal(calls[0][0], 'hard');
});

test('matched-authoritative remains authoritative and symbol confidence is per-record', () => {
  const full = resultFor(createDebugIdentity({
    verdict: 'matched-authoritative',
    providerId: 'pdb',
    providerVersion: '1',
    expected: 'build-A',
    observed: 'build-A',
    method: 'guid-age',
  }));
  assert.equal(isDebugRecordAuthoritative(full, record()), true);

  const partial = resultFor(createDebugIdentity({
    verdict: 'matched-partial',
    providerId: 'pdb',
    providerVersion: '1',
    expected: 'build-A',
    observed: 'build-A-partial',
    method: 'partial-id',
    coverage: { entityIds: ['covered-symbol'] },
  }));
  const page = createDebugPage({ records: [
    record({ kind: 'symbol', entityId: 'covered-symbol', address: '0x1000', descriptor: { isFunction: true } }),
    record({ kind: 'symbol', entityId: 'outside-symbol', address: '0x2000', descriptor: { isFunction: true } }),
  ] });
  assert.deepEqual(debugFunctionEvidence(partial, page).map((item) => item.confidence), ['exact', 'heuristic']);
});
