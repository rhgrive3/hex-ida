/* #4365: merging broad memory effects must not transcribe the last effect's
 * source/evidenceIds across the whole address-space union; authority may not
 * depend on call/effect order. */
import assert from 'node:assert/strict';
import { createAnalysisStatus } from '../js/analysis/status.js';
import { createFunctionSummary } from '../js/analysis/summary/contract.js';
import { solveInterproceduralSummaries } from '../js/analysis/summary/interprocedural.js';

const SNAPSHOT = 'snapshot_4365';

const solvedStatus = () => createAnalysisStatus({
  snapshotId: SNAPSHOT,
  analyzerId: 'phase7.summary.interprocedural',
  analyzerVersion: '1.3.2',
  completeness: 'complete',
});

const libraryCallee = createFunctionSummary({
  functionId: 'fn_b',
  memoryWriteRegions: [{
    regionId: null,
    regionKind: 'unknown',
    broad: true,
    addressSpaces: ['io'],
    source: 'library-model',
    evidenceIds: ['ev-B'],
  }],
  noreturn: false,
  mayThrow: false,
  status: solvedStatus(),
});

const provenCallee = createFunctionSummary({
  functionId: 'fn_c',
  memoryWriteRegions: [{
    regionId: null,
    regionKind: 'unknown',
    broad: true,
    addressSpaces: ['memory'],
    source: 'proven-summary',
    evidenceIds: ['ev-C'],
  }],
  noreturn: false,
  mayThrow: false,
  status: solvedStatus(),
});

function solve(calleeIds) {
  return solveInterproceduralSummaries({
    roots: ['fn_a'],
    localSummaries: new Map([
      ['fn_a', createFunctionSummary({
        functionId: 'fn_a',
        directCalls: calleeIds.map((id, index) => ({
          callSiteId: `call_${index}`,
          targetEntityIds: [id],
          summaryId: id,
          effectSource: 'proven-summary',
        })),
        noreturn: 'unknown',
        mayThrow: 'unknown',
        status: solvedStatus(),
      })],
      ['fn_b', libraryCallee],
      ['fn_c', provenCallee],
    ]),
    snapshotId: SNAPSHOT,
  });
}

const forward = solve(['fn_b', 'fn_c']).summaries.get('fn_a');
const backward = solve(['fn_c', 'fn_b']).summaries.get('fn_a');

const writes = (summary) => JSON.stringify([...summary.memoryWriteRegions].sort((l, r) => (
  JSON.stringify(l) < JSON.stringify(r) ? -1 : 1
)));

assert.ok(forward.memoryWriteRegions.length >= 1, 'caller must carry the callee broad writes');
for (const summary of [forward, backward]) {
  const io = summary.memoryWriteRegions.filter((effect) => effect.addressSpaces.includes('io'));
  const memory = summary.memoryWriteRegions.filter((effect) => effect.addressSpaces.includes('memory'));
  assert.ok(io.length >= 1 && memory.length >= 1, 'both spaces stay covered');
  assert.ok(
    io.every((effect) => effect.source !== 'proven-summary'),
    `io coverage must not gain proven-summary authority (${io.map((e) => e.source).join(',')})`,
  );
  assert.ok(
    io.every((effect) => effect.evidenceIds.includes('ev-B')),
    'io effects must keep the library-model evidence',
  );
  assert.ok(
    memory.every((effect) => effect.source !== 'library-model'),
    'memory coverage keeps its own proven authority',
  );
  const allEvidence = summary.memoryWriteRegions.flatMap((effect) => effect.evidenceIds);
  assert.ok(allEvidence.includes('ev-B') && allEvidence.includes('ev-C'), 'no evidence is dropped');
}
assert.equal(writes(forward), writes(backward), 'authority/union must be call-order independent');

process.stdout.write('issue-4365: all assertions passed\n');
