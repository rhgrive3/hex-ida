import assert from 'node:assert/strict';
import test from 'node:test';

import { createAnalysisStatus } from '../js/analysis/status.js';
import {
  createFunctionSummary,
  createMemoryEffect,
} from '../js/analysis/summary/contract.js';
import { solveInterproceduralSummaries } from '../js/analysis/summary/interprocedural.js';

// Issue #6208: solveInterproceduralSummaries trusted the localSummaries map
// key alone. A canonical summary for `g` stored under key `f` was consumed as
// `f`'s local facts, and A3 republished g's memory effects / return
// provenance under f's identity as a complete summary. Identity laundering of
// cache/index key collisions instead of a fail-closed verdict.

const localStatus = () => createAnalysisStatus({
  snapshotId: 'S',
  analyzerId: 'phase7.summary.local',
  analyzerVersion: '1.0.0',
  completeness: 'complete',
});

const summaryWithWrite = (functionId, regionId) => createFunctionSummary({
  functionId,
  memoryWriteRegions: [createMemoryEffect({
    regionId,
    regionKind: 'global',
    broad: false,
    addressSpaces: ['memory'],
    source: 'proven-summary',
    evidenceIds: [`${functionId}-write`],
  })],
  status: localStatus(),
});

const callingSummary = (functionId, targets) => createFunctionSummary({
  functionId,
  directCalls: targets.map((target) => ({
    callSiteId: `call_${functionId}_${target}`,
    targetEntityIds: [target],
    effectSource: 'abi-rule',
  })),
  status: localStatus(),
});

test('issue-6208: a local summary whose functionId contradicts its key is rejected', () => {
  // Map ['f' -> summary(functionId:'g')]: f must never publish as complete.
  assert.throws(
    () => solveInterproceduralSummaries({
      roots: ['f'],
      localSummaries: new Map([['f', summaryWithWrite('g', 'global:G')]]),
      snapshotId: 'S',
    }),
    /interprocedural-local-summary-identity-mismatch/,
  );
});

test('issue-6208: the object-entry form of localSummaries is validated identically', () => {
  assert.throws(
    () => solveInterproceduralSummaries({
      roots: ['f'],
      localSummaries: { f: summaryWithWrite('g', 'global:G') },
      snapshotId: 'S',
    }),
    /interprocedural-local-summary-identity-mismatch/,
  );
});

test('issue-6208: wrong facts do not leak through a transitive call edge', () => {
  // f -> c -> x, where key 'x' holds g's summary. The mismatch is reached
  // through composition, not at the root, and must still fail closed rather
  // than flowing g's write into f's solved summary.
  assert.throws(
    () => solveInterproceduralSummaries({
      roots: ['f'],
      localSummaries: new Map([
        ['f', callingSummary('f', ['c'])],
        ['c', callingSummary('c', ['x'])],
        ['x', summaryWithWrite('g', 'global:G')],
      ]),
      snapshotId: 'S',
    }),
    /interprocedural-local-summary-identity-mismatch/,
  );
});

test('issue-6208: consistent keys still solve end to end', () => {
  const solved = solveInterproceduralSummaries({
    roots: ['f'],
    localSummaries: new Map([
      ['f', callingSummary('f', ['c'])],
      ['c', summaryWithWrite('c', 'global:C')],
    ]),
    snapshotId: 'S',
  });
  const solvedF = solved.summaries.get('f');
  assert.equal(solvedF.functionId, 'f');
  assert.equal(solved.status.completeness, 'complete');
  assert.ok(solvedF.memoryWriteRegions.some((effect) => effect.regionId === 'global:C'),
    'a correctly keyed callee effect must still propagate');
});

test('issue-6208: unreachable mismatched entries stay inert (demand-driven solve)', () => {
  // Identity is enforced when a summary is consumed, not by eagerly walking
  // the whole map: solving only the reachable component must not be affected
  // by entries the solve never touches (P7-INV-009).
  const solved = solveInterproceduralSummaries({
    roots: ['f'],
    localSummaries: new Map([
      ['f', summaryWithWrite('f', 'global:F')],
      ['unrelated', summaryWithWrite('g', 'global:G')],
    ]),
    snapshotId: 'S',
  });
  assert.ok(solved.summaries.has('f'));
  assert.ok(!solved.summaries.has('unrelated'));
});
