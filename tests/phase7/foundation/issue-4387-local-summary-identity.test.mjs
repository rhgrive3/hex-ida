import assert from 'node:assert/strict';
import test from 'node:test';

import { createPhase7ArtifactDescriptor, dependencyClassFor } from '../../../js/analysis/artifact-identity.js';
import { functionSummaryDigest } from '../../../js/analysis/summary/contract.js';
import {
  buildLocalFunctionSummary,
  LOCAL_SUMMARY_ANALYZER_ID,
  LOCAL_SUMMARY_ANALYZER_VERSION,
} from '../../../js/analysis/summary/local.js';
import { fixture } from '../helpers/fixtures.mjs';

const base = {
  kind: 'phase7.summary.local', binaryId: 'binary-A', functionId: 'caller', architectureId: 'arm64',
  snapshotId: 'snapshot-A', analyzerId: LOCAL_SUMMARY_ANALYZER_ID, analyzerVersion: LOCAL_SUMMARY_ANALYZER_VERSION,
  semanticSchemaVersion: '2', cfgVersion: '2', ssaVersion: '2', memorySsaVersion: '2', architectureSemanticVersion: '1',
};
const descriptor = (calleeSummaryIds, overrides = {}) => createPhase7ArtifactDescriptor({ ...base, calleeSummaryIds, ...overrides });
const id = (calleeSummaryIds, overrides = {}) => descriptor(calleeSummaryIds, overrides).artifactId;

function built(functionId, configure) {
  const f = fixture(functionId);
  f.block('entry');
  configure?.(f);
  f.ret('return');
  return f.build();
}

function localSummary(functionId, configure, options = {}) {
  const input = built(functionId, configure);
  return buildLocalFunctionSummary(input.ir, input.cfg, input.ssa, input.memorySsa, {
    snapshotId: base.snapshotId,
    resolveRegion: input.resolveRegion,
    ...options,
  });
}

test('local summaries declare the callee summary dependency', () => {
  assert.ok(dependencyClassFor(base.kind).includes('calleeSummaries'));
});

test('a changed, added or removed callee summary changes caller identity', () => {
  const before = id(['callee@1']);
  assert.notEqual(id(['callee@2']), before);
  assert.notEqual(id(['callee@1', 'other@1']), before);
  assert.notEqual(id([]), before);
});

test('ordering and duplicate references do not change dependency identity', () => {
  assert.equal(id(['B@1', 'A@1', 'A@1']), id(['A@1', 'B@1']));
});

test('malformed dependency identifiers fail closed', () => {
  for (const value of [[''], [['callee']], [true], 'callee']) {
    assert.throws(() => id(value), /phase7-artifact-invalid-callee-summary-id/);
  }
});

test('the local producer reports exactly the current callee summaries it folds for descriptor keying', () => {
  const calleeA = localSummary('callee-A');
  const calleeB = localSummary('callee-B');
  const staleB = localSummary('callee-B', null, { snapshotId: 'other-snapshot' });
  assert.ok(calleeA.summary);
  assert.ok(calleeB.summary);
  assert.ok(staleB.summary);

  const caller = localSummary('caller', (f) => {
    f.pureCall('call-a', { calleeId: 'callee-A' });
    f.pureCall('call-b', { calleeId: 'callee-B' });
    f.pureCall('call-a-again', { calleeId: 'callee-A' });
  }, {
    calleeSummaries: new Map([
      ['callee-A', calleeA.summary],
      // The stale summary is supplied but must not become an authority-bearing
      // dependency because the producer refuses to fold it.
      ['callee-B', staleB.summary],
    ]),
  });

  assert.deepEqual(caller.calleeSummaryIds, [functionSummaryDigest(calleeA.summary)]);
  const keyed = descriptor(caller.calleeSummaryIds);

  const callerWithCurrentB = localSummary('caller', (f) => {
    f.pureCall('call-a', { calleeId: 'callee-A' });
    f.pureCall('call-b', { calleeId: 'callee-B' });
  }, {
    calleeSummaries: new Map([
      ['callee-A', calleeA.summary],
      ['callee-B', calleeB.summary],
    ]),
  });
  assert.deepEqual(callerWithCurrentB.calleeSummaryIds.sort(), [
    functionSummaryDigest(calleeA.summary),
    functionSummaryDigest(calleeB.summary),
  ].sort());
  assert.notEqual(descriptor(callerWithCurrentB.calleeSummaryIds).artifactId, keyed.artifactId);
});

test('other dependency classes retain their existing key semantics', () => {
  assert.equal(id(['A@1'], { kind: 'phase7.alias.region' }), id(['A@2'], { kind: 'phase7.alias.region' }));
  assert.notEqual(id(['A@1'], { kind: 'phase7.summary.interprocedural' }), id(['A@2'], { kind: 'phase7.summary.interprocedural' }));
});
