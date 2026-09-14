import assert from 'node:assert/strict';
import test from 'node:test';

import { createAnalysisStatus } from '../../../js/analysis/status.js';
import { createFunctionSummary, createMemoryEffect } from '../../../js/analysis/summary/contract.js';
import { solveInterproceduralSummaries } from '../../../js/analysis/summary/interprocedural.js';

const status = createAnalysisStatus({
  snapshotId: 'snapshot-4365',
  analyzerId: 'phase7.summary.local',
  analyzerVersion: '1.0.0',
  completeness: 'complete',
});

function solve(writes, budget = {}) {
  const local = createFunctionSummary({ functionId: 'fn_4365', memoryWriteRegions: writes, status });
  return solveInterproceduralSummaries({
    roots: ['fn_4365'],
    localSummaries: new Map([['fn_4365', local]]),
    budget,
  }).summaries.get('fn_4365');
}

function broad(addressSpaces, source, evidenceIds) {
  return createMemoryEffect({
    regionKind: 'unknown',
    broad: true,
    addressSpaces,
    source,
    evidenceIds,
  });
}

function publicEffects(summary) {
  return summary.memoryWriteRegions.map((effect) => ({
    broad: effect.broad,
    addressSpaces: effect.addressSpaces,
    source: effect.source,
    evidenceIds: effect.evidenceIds,
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

test('#4365 keeps broad authority and evidence bound to its address space', () => {
  const library = broad(['io'], 'library-model', ['ev-B']);
  const proven = broad(['memory'], 'proven-summary', ['ev-C']);
  const forward = solve([library, proven]);
  const reverse = solve([proven, library]);

  assert.deepEqual(publicEffects(forward), [
    { broad: true, addressSpaces: ['io'], source: 'library-model', evidenceIds: ['ev-B'] },
    { broad: true, addressSpaces: ['memory'], source: 'proven-summary', evidenceIds: ['ev-C'] },
  ].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))));
  assert.deepEqual(publicEffects(forward), publicEffects(reverse));
});

test('#4365 dedupes same-source broad effects while retaining all evidence', () => {
  const summary = solve([
    broad(['memory'], 'proven-summary', ['ev-1']),
    broad(['memory'], 'proven-summary', ['ev-2']),
  ]);
  assert.equal(summary.memoryWriteRegions.length, 1);
  assert.equal(summary.memoryWriteRegions[0].source, 'proven-summary');
  assert.deepEqual(summary.memoryWriteRegions[0].addressSpaces, ['memory']);
  assert.deepEqual(summary.memoryWriteRegions[0].evidenceIds, ['ev-1', 'ev-2']);
});

test('#4365 cap collapse uses the weakest authority and unions evidence', () => {
  const summary = solve([
    broad(['memory'], 'proven-summary', ['ev-proven']),
    broad(['io'], 'unknown-call-fallback', ['ev-unknown']),
  ], { maxEffectsPerSummary: 1 });
  assert.equal(summary.memoryWriteRegions.length, 1);
  const effect = summary.memoryWriteRegions[0];
  assert.equal(effect.source, 'unknown-call-fallback');
  assert.deepEqual(effect.addressSpaces, ['io', 'memory']);
  assert.deepEqual(effect.evidenceIds, ['ev-proven', 'ev-unknown']);
});

test('#4365 cap collapse of a specific effect cannot preserve broad proven authority', () => {
  const summary = solve([
    broad(['memory'], 'proven-summary', ['ev-broad']),
    createMemoryEffect({
      regionId: 'io:port',
      regionKind: 'io',
      broad: false,
      addressSpaces: ['io'],
      source: 'proven-summary',
      evidenceIds: ['ev-specific'],
    }),
  ], { maxEffectsPerSummary: 1 });
  assert.equal(summary.memoryWriteRegions.length, 1);
  assert.equal(summary.memoryWriteRegions[0].source, 'unknown-call-fallback');
  assert.deepEqual(summary.memoryWriteRegions[0].addressSpaces, ['io', 'memory']);
  assert.deepEqual(summary.memoryWriteRegions[0].evidenceIds, ['ev-broad', 'ev-specific']);
});

console.log('issue #4365 broad effect authority: PASS');
