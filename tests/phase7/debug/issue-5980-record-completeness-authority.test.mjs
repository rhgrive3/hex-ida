import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDebugProviderResult,
  createDebugRecord,
  applyDebugTypesToGraph,
  debugFunctionEvidence,
  isDebugRecordAuthoritative,
} from '../../../js/analysis/debug/provider.js';

// A source-level identity match says the build is right; it does not say every
// record was fully interpreted. A parser that marked its own record
// `descriptor.complete:false` must not see that record promoted to a hard
// constraint or exact function evidence (#5980).

function matchedResult() {
  return createDebugProviderResult({
    ecosystem: 'dwarf',
    identity: {
      verdict: 'matched-authoritative',
      providerId: 'phase7.debug.dwarf',
      providerVersion: '1',
      method: 'build-id',
      expected: 'build-A',
      observed: 'build-A',
    },
    status: {
      snapshotId: 'snap-5980',
      analyzerId: 'phase7.debug.dwarf',
      analyzerVersion: '1',
      completeness: 'partial',
      stopReason: 'evidence-missing',
    },
  });
}

function typeRecord(complete) {
  return createDebugRecord({
    kind: 'type',
    entityId: complete ? 'type:complete' : 'type:incomplete',
    descriptor: { layer: 'nominal', claim: { name: complete ? 'Y' : 'X' }, complete },
    providerId: 'phase7.debug.dwarf',
    providerVersion: '1',
    buildIdentity: 'build-A',
    evidenceIds: [`e:${complete ? 'y' : 'x'}`],
  });
}

function symbolRecord(complete) {
  return createDebugRecord({
    kind: 'symbol',
    entityId: complete ? 'sym:complete' : 'sym:incomplete',
    name: complete ? 'g' : 'f',
    address: complete ? '0x2000' : '0x1000',
    sizeBytes: 16,
    descriptor: { isFunction: true, complete },
    providerId: 'phase7.debug.dwarf',
    providerVersion: '1',
    buildIdentity: 'build-A',
    evidenceIds: [`e:${complete ? 'g' : 'f'}`],
  });
}

test('#5980: an incomplete type becomes soft evidence, not a hard constraint', () => {
  const graph = { applied: null };
  const recordingGraph = {
    addHardConstraint(input) { (graph.applied ??= { hard: [], soft: [] }).hard.push(input); },
    addSoftEvidence(input) { (graph.applied ??= { hard: [], soft: [] }).soft.push(input); },
  };
  void graph;
  const applied = applyDebugTypesToGraph(recordingGraph, matchedResult(), { records: [typeRecord(false)] });
  assert.equal(applied.hard, 0);
  assert.equal(applied.soft, 1);
});

test('#5980: a complete type still becomes a hard constraint', () => {
  const graph = { hard: [], soft: [] };
  const recordingGraph = {
    addHardConstraint(input) { graph.hard.push(input); },
    addSoftEvidence(input) { graph.soft.push(input); },
  };
  const applied = applyDebugTypesToGraph(recordingGraph, matchedResult(), { records: [typeRecord(true)] });
  assert.equal(applied.hard, 1);
  assert.equal(applied.soft, 0);
});

test('#5980: an incomplete function symbol is heuristic, not exact', () => {
  const evidence = debugFunctionEvidence(matchedResult(), { records: [symbolRecord(false)] });
  assert.equal(evidence[0]?.confidence, 'heuristic');
  const complete = debugFunctionEvidence(matchedResult(), { records: [symbolRecord(true)] });
  assert.equal(complete[0]?.confidence, 'exact');
});

test('#5980: isDebugRecordAuthoritative refuses incomplete records on every verdict path', () => {
  const result = matchedResult();
  assert.equal(isDebugRecordAuthoritative(result, typeRecord(false)), false);
  assert.equal(isDebugRecordAuthoritative(result, symbolRecord(false)), false);
  assert.equal(isDebugRecordAuthoritative(result, typeRecord(true)), true);
  assert.equal(isDebugRecordAuthoritative(result, symbolRecord(true)), true);
  // Absence of the descriptor.complete field stays neutral for minimal
  // descriptors from providers that do not emit it.
  const neutral = createDebugRecord({
    kind: 'symbol', entityId: 'sym:legacy', name: 'h', address: '0x3000',
    descriptor: { isFunction: true },
    providerId: 'phase7.debug.dwarf', providerVersion: '1', buildIdentity: 'build-A',
    evidenceIds: ['e:h'],
  });
  assert.equal(isDebugRecordAuthoritative(result, neutral), true);
});

test('#5980: matched-partial authority requires coverage and record completeness', () => {
  const result = createDebugProviderResult({
    ecosystem: 'dwarf',
    identity: {
      verdict: 'matched-partial',
      providerId: 'phase7.debug.dwarf',
      providerVersion: '1',
      method: 'partial-id',
      expected: 'build-A',
      observed: 'build-A',
      coverage: { entityIds: ['type:complete', 'type:incomplete'] },
    },
    status: {
      snapshotId: 'snap-5980-partial',
      analyzerId: 'phase7.debug.dwarf',
      analyzerVersion: '1',
      completeness: 'partial',
      stopReason: 'evidence-missing',
    },
  });
  assert.equal(isDebugRecordAuthoritative(result, typeRecord(false)), false);
  assert.equal(isDebugRecordAuthoritative(result, typeRecord(true)), true);
  assert.equal(isDebugRecordAuthoritative(result, symbolRecord(true)), false);
});
