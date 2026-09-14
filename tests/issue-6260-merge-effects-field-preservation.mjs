import assert from 'node:assert/strict';
import test from 'node:test';

import { createAnalysisStatus } from '../js/analysis/status.js';
import { createFunctionSummary, createMemoryEffect } from '../js/analysis/summary/contract.js';
import { solveInterproceduralSummaries } from '../js/analysis/summary/interprocedural.js';

const SNAPSHOT = 'snapshot_6260';

const leafStatus = () => createAnalysisStatus({
  snapshotId: SNAPSHOT,
  analyzerId: 'phase7.summary.local',
  analyzerVersion: '1.1.0',
  completeness: 'complete',
});

function leafSummary(functionId, writes, reads = []) {
  return createFunctionSummary({
    functionId,
    memoryWriteRegions: writes,
    memoryReadRegions: reads,
    noreturn: false,
    mayThrow: false,
    status: leafStatus(),
  });
}

function solveRoot(functionId, writes, reads = []) {
  return solveInterproceduralSummaries({
    roots: [functionId],
    localSummaries: new Map([[functionId, leafSummary(functionId, writes, reads)]]),
    snapshotId: SNAPSHOT,
  }).summaries.get(functionId);
}

test('issue-6260: distinct address spaces on one region both survive the merge', () => {
  const summary = solveRoot('fn_a', [
    createMemoryEffect({ regionId: 'region_r', regionKind: 'global', broad: false, addressSpaces: ['memory'], source: 'proven-summary', evidenceIds: ['i1'] }),
    createMemoryEffect({ regionId: 'region_r', regionKind: 'global', broad: false, addressSpaces: ['io'], source: 'proven-summary', evidenceIds: ['i2'] }),
  ]);
  const merged = summary.memoryWriteRegions.filter((effect) => effect.regionId === 'region_r');
  assert.equal(merged.length, 1, 'same region/kind must collapse to one effect');
  assert.deepEqual(merged[0].addressSpaces, ['io', 'memory']);
});

test('issue-6260: evidence from every access to one region is preserved', () => {
  const summary = solveRoot('fn_a', [
    createMemoryEffect({ regionId: 'region_r', regionKind: 'global', broad: false, addressSpaces: ['memory'], source: 'proven-summary', evidenceIds: ['store-1'] }),
    createMemoryEffect({ regionId: 'region_r', regionKind: 'global', broad: false, addressSpaces: ['memory'], source: 'proven-summary', evidenceIds: ['store-2'] }),
  ]);
  const merged = summary.memoryWriteRegions.find((effect) => effect.regionId === 'region_r');
  assert.deepEqual(merged.evidenceIds, ['store-1', 'store-2']);
});

test('issue-6260: authority does not depend on input order', () => {
  const strongerFirst = solveRoot('fn_a', [
    createMemoryEffect({ regionId: 'region_r', regionKind: 'global', broad: false, addressSpaces: ['memory'], source: 'proven-summary', evidenceIds: ['i1'] }),
    createMemoryEffect({ regionId: 'region_r', regionKind: 'global', broad: false, addressSpaces: ['memory'], source: 'library-model', evidenceIds: ['i2'] }),
  ]);
  const strongerLast = solveRoot('fn_b', [
    createMemoryEffect({ regionId: 'region_r', regionKind: 'global', broad: false, addressSpaces: ['memory'], source: 'library-model', evidenceIds: ['i2'] }),
    createMemoryEffect({ regionId: 'region_r', regionKind: 'global', broad: false, addressSpaces: ['memory'], source: 'proven-summary', evidenceIds: ['i1'] }),
  ]);
  const first = strongerFirst.memoryWriteRegions.find((effect) => effect.regionId === 'region_r');
  const last = strongerLast.memoryWriteRegions.find((effect) => effect.regionId === 'region_r');
  assert.equal(first.source, 'proven-summary');
  assert.equal(last.source, 'proven-summary');
  assert.deepEqual(first.evidenceIds, last.evidenceIds);
  assert.deepEqual(first.addressSpaces, last.addressSpaces);
});

test('issue-6260: reversing the input effects keeps the merged meaning', () => {
  const effects = [
    createMemoryEffect({ regionId: 'region_r', regionKind: 'global', broad: false, addressSpaces: ['memory'], source: 'proven-summary', evidenceIds: ['i1'] }),
    createMemoryEffect({ regionId: 'region_r', regionKind: 'global', broad: false, addressSpaces: ['io'], source: 'library-model', evidenceIds: ['i2'] }),
    createMemoryEffect({ regionId: 'region_s', regionKind: 'stack-fixed', broad: false, addressSpaces: ['memory'], source: 'proven-summary', evidenceIds: ['i3'] }),
  ];
  const forward = solveRoot('fn_a', effects);
  const backward = solveRoot('fn_b', [...effects].reverse());
  const normalize = (summary) => summary.memoryWriteRegions.map((effect) => ({
    regionId: effect.regionId,
    regionKind: effect.regionKind,
    addressSpaces: effect.addressSpaces,
    source: effect.source,
    evidenceIds: effect.evidenceIds,
  })).sort((left, right) => left.regionId.localeCompare(right.regionId));
  assert.deepEqual(normalize(forward), normalize(backward));
});

test('issue-6260: fully identical specific effects still dedupe to one', () => {
  const effect = () => createMemoryEffect({ regionId: 'region_r', regionKind: 'global', broad: false, addressSpaces: ['memory'], source: 'proven-summary', evidenceIds: ['i1'] });
  const summary = solveRoot('fn_a', [effect(), effect(), effect()]);
  const merged = summary.memoryWriteRegions.filter((entry) => entry.regionId === 'region_r');
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].evidenceIds, ['i1']);
});

test('issue-6260: distinct regions remain separate effects', () => {
  const summary = solveRoot('fn_a', [
    createMemoryEffect({ regionId: 'region_r', regionKind: 'global', broad: false, addressSpaces: ['memory'], source: 'proven-summary', evidenceIds: ['i1'] }),
    createMemoryEffect({ regionId: 'region_s', regionKind: 'global', broad: false, addressSpaces: ['memory'], source: 'proven-summary', evidenceIds: ['i2'] }),
  ]);
  assert.equal(summary.memoryWriteRegions.length, 2);
});

test('issue-6260: reads merge the same way', () => {
  const summary = solveRoot('fn_a', [], [
    createMemoryEffect({ regionId: 'region_r', regionKind: 'global', broad: false, addressSpaces: ['memory'], source: 'proven-summary', evidenceIds: ['load-1'] }),
    createMemoryEffect({ regionId: 'region_r', regionKind: 'global', broad: false, addressSpaces: ['memory'], source: 'abi-rule', evidenceIds: ['load-2'] }),
  ]);
  const merged = summary.memoryReadRegions.find((effect) => effect.regionId === 'region_r');
  assert.deepEqual(merged.evidenceIds, ['load-1', 'load-2']);
  assert.equal(merged.source, 'proven-summary');
});
