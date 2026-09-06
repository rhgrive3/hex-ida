import test from 'node:test';
import assert from 'node:assert/strict';
import { createAnalysisStatus } from '../../../js/analysis/status.js';
import { createFunctionSummary } from '../../../js/analysis/summary/contract.js';
import { solveInterproceduralSummaries } from '../../../js/analysis/summary/interprocedural.js';

const completeStatus = () => createAnalysisStatus({
  snapshotId: 's6074',
  analyzerId: 'phase7.summary.local',
  analyzerVersion: '1.1.0',
  completeness: 'complete',
  stopReason: null,
});

function caller() {
  return createFunctionSummary({
    functionId: 'caller',
    directCalls: [{ callSiteId: 'call-1', targetEntityIds: ['ext'] }],
    status: completeStatus(),
  });
}

function solvedWith(model) {
  const run = solveInterproceduralSummaries({
    roots: ['caller'],
    localSummaries: new Map([['caller', caller()]]),
    libraryModels: new Map([['ext', model]]),
    snapshotId: 's6074',
  });
  return run.summaries.get('caller');
}

test('6074: empty object model does not cancel the unknown-call fallback', () => {
  const summary = solvedWith({});
  assert.ok(
    summary.memoryWriteRegions.some((region) => region?.source === 'unknown-call-fallback'),
    'expected a broad unknown-call-fallback write',
  );
  assert.ok(
    summary.unknownCallEffects.some((effect) => effect.reason === 'library-model-missing'),
    'expected a library-model-missing unknown effect',
  );
});

test('6074: malformed-shape model does not cancel the fallback', () => {
  const summary = solvedWith({ memoryWriteRegions: 'all', noreturn: 'yes' });
  assert.ok(
    summary.unknownCallEffects.some((effect) => effect.reason === 'library-model-missing'),
    'expected a library-model-missing unknown effect',
  );
});

test('6074: evidenced model still applies', () => {
  const summary = solvedWith({
    memoryWriteRegions: [{ regionId: 'model-region', regionKind: 'global-absolute', source: 'library-model' }],
    noreturn: false,
    mayThrow: false,
  });
  assert.ok(
    summary.memoryWriteRegions.some((region) => region?.regionId === 'model-region'),
    'expected the verified model region to apply',
  );
  assert.ok(
    !summary.unknownCallEffects.some((effect) => effect.reason === 'library-model-missing'),
    'verified model must not raise library-model-missing',
  );
});

test('6074: knowledge-only model keeps the fallback', () => {
  // Bare control booleans are not effect evidence: without an evidenced
  // effect dimension the broad unknown-call fallback must stay.
  const summary = solvedWith({ noreturn: false, mayThrow: true });
  assert.ok(
    summary.unknownCallEffects.some((effect) => effect.reason === 'library-model-missing'),
    'control booleans alone must not cancel the fallback',
  );
});

test('6074: escape-only model applies and propagates escapes', () => {
  const summary = solvedWith({
    escapes: [{ kind: 'return-escape', target: 'ext:ret' }],
  });
  assert.ok(
    !summary.unknownCallEffects.some((effect) => effect.reason === 'library-model-missing'),
    'evidenced escape model must not raise library-model-missing',
  );
  assert.ok(
    summary.escapes.some((escape) => escape?.target === 'ext:ret'),
    'model escapes must propagate to the caller summary',
  );
});
