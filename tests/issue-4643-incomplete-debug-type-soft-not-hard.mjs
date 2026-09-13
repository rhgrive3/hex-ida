import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createDebugProviderResult,
  createDebugRecord,
  applyDebugTypesToGraph,
  isDebugRecordAuthoritative,
} from '../js/analysis/debug/provider.js';
import { TypeConstraintGraph, certainConclusions } from '../js/analysis/types/graph.js';

// Issue #4643: identity match and record completeness are separate conditions.
// A DWARF/PDB record whose descriptor explicitly marks it unresolved
// (`complete:false`, e.g. `referencedType()` failed and `describeType()` fell
// back to `{ name:'unknown', complete:false }`) must not become a
// `debug-matched` hard constraint just because the build identity matched.

function matchedResult() {
  return createDebugProviderResult({
    ecosystem: 'dwarf',
    identity: {
      verdict: 'matched-authoritative',
      providerId: 'p',
      providerVersion: '1',
      expected: 'build-A',
      observed: 'build-A',
      method: 'build-id',
    },
    status: {
      snapshotId: 's',
      analyzerId: 'p',
      analyzerVersion: '1',
      completeness: 'partial',
      stopReason: 'evidence-missing',
    },
  });
}

function unresolvedTypeRecord() {
  return createDebugRecord({
    kind: 'type',
    entityId: 'v',
    providerId: 'p',
    providerVersion: '1',
    buildIdentity: 'build-A',
    evidenceIds: ['e:v'],
    descriptor: {
      layer: 'nominal',
      claim: { name: 'unknown', aliases: [] },
      complete: false,
    },
  });
}

test('#4643 incomplete descriptor keeps the record out of hard authority', () => {
  const result = matchedResult();
  const record = unresolvedTypeRecord();
  assert.equal(isDebugRecordAuthoritative(result, record), false);

  const graph = new TypeConstraintGraph({ snapshotId: 's' });
  const applied = applyDebugTypesToGraph(graph, result, { records: [record] });
  assert.equal(applied.hard, 0, 'an unresolved type must not become a debug-matched hard constraint');
  assert.equal(applied.soft, 1, 'it stays visible as weak evidence');
  assert.equal(applied.skipped, 0);
});

test('#4643 unresolved synthetic unknown never reaches certain via the real graph', () => {
  const graph = new TypeConstraintGraph({ snapshotId: 's' });
  applyDebugTypesToGraph(graph, matchedResult(), { records: [unresolvedTypeRecord()] });
  const solved = graph.solveEntity('v');
  const layer = solved.layers?.nominal;
  if (layer && layer.hardConstraints?.length) {
    assert.notEqual(layer.confidence, 'certain');
  }
  assert.deepEqual(certainConclusions(solved), [], 'synthetic unknown must not be published as certain');
});

test('#4643 complete descriptors keep their existing hard authority', () => {
  const result = matchedResult();
  const complete = createDebugRecord({
    kind: 'type',
    entityId: 'v',
    providerId: 'p',
    providerVersion: '1',
    buildIdentity: 'build-A',
    evidenceIds: ['e:v'],
    descriptor: {
      layer: 'nominal',
      claim: { name: 'struct Point *', aliases: [] },
      complete: true,
    },
  });
  assert.equal(isDebugRecordAuthoritative(result, complete), true);

  const graph = new TypeConstraintGraph({ snapshotId: 's' });
  const applied = applyDebugTypesToGraph(graph, result, { records: [complete] });
  assert.equal(applied.hard, 1);
  assert.equal(applied.soft, 0);
});
