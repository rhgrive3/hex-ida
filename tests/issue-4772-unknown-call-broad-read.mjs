import assert from 'node:assert/strict';
import test from 'node:test';

import { createAnalysisStatus } from '../js/analysis/status.js';
import { createFunctionSummary } from '../js/analysis/summary/contract.js';
import { buildLocalFunctionSummary } from '../js/analysis/summary/local.js';
import { solveInterproceduralSummaries } from '../js/analysis/summary/interprocedural.js';

const SNAPSHOT = 'snapshot-4772';

const broadOf = (regions) => regions.some((effect) => effect.broad === true);

const localStatus = (completeness) => createAnalysisStatus({
  snapshotId: SNAPSHOT,
  analyzerId: 'phase7.summary.local',
  analyzerVersion: '1',
  completeness,
  stopReason: completeness === 'complete' ? null : 'evidence-missing',
});

function localCall(call) {
  const node = {
    id: 'call-1',
    kind: 'call',
    inputs: [],
    outputs: [],
    call: {
      completeness: 'complete',
      memoryRead: { scope: 'none' },
      memoryWrite: { scope: 'none' },
      noreturn: false,
      mayThrow: false,
      ...call,
    },
  };
  return buildLocalFunctionSummary({ functionId: 'caller', values: [], nodes: [node] }, {},
    { definitions: [], uses: [] }, null, { snapshotId: SNAPSHOT }).summary;
}

// Required regression #1: a non-exhaustive indirect call whose own memory scope
// is proven `none` must still keep a conservative broad READ next to the broad
// WRITE once its target universe is unresolved.
test('issue-4772: non-exhaustive indirect fallback keeps a broad read as well as a broad write', () => {
  const summary = localCall({ targetEntityIds: ['candidate-A'], targetValueIds: ['fp'], completeness: 'partial' });
  assert.equal(summary.unknownCallEffects.length, 1, 'the non-exhaustive indirect call stays an unknown boundary');
  assert.equal(summary.unknownCallEffects[0].reason, 'indirect-incomplete-target-set');
  assert.equal(summary.status.completeness, 'partial');
  assert.ok(broadOf(summary.memoryWriteRegions), 'the unknown-call fallback must contribute a broad write');
  assert.ok(broadOf(summary.memoryReadRegions),
    '#4772 the unknown-call fallback must contribute a broad read too, not only a broad write');
});

// Required regression #2: a direct call whose callee is not solved and not
// covered by a library model must fold in both broad dimensions during A3
// composition, matching the `unconverged` path.
test('issue-4772: interprocedural missing-callee fallback keeps a broad read as well as a broad write', () => {
  const local = createFunctionSummary({
    functionId: 'caller',
    directCalls: [{ callSiteId: 'call-ext', targetEntityIds: ['ext'], summaryId: null, effectSource: 'abi-rule' }],
    memoryReadRegions: [],
    memoryWriteRegions: [],
    unknownCallEffects: [],
    noreturn: false,
    mayThrow: false,
    status: localStatus('complete'),
  });
  const solved = solveInterproceduralSummaries({
    roots: ['caller'],
    localSummaries: new Map([['caller', local]]),
    snapshotId: SNAPSHOT,
  });
  const summary = solved.summaries.get('caller');
  assert.ok(summary.unknownCallEffects.length > 0, 'an unsolved external callee must remain an unknown boundary');
  assert.ok(broadOf(summary.memoryWriteRegions), 'the missing-callee fallback must contribute a broad write');
  assert.ok(broadOf(summary.memoryReadRegions),
    '#4772 the missing-callee fallback must contribute a broad read too, not only a broad write');
});

// Required regression #3: the recursion-unconverged path already kept both
// dimensions; the fix must not regress it.
test('issue-4772: recursion-unconverged path keeps broad read and broad write', () => {
  const local = createFunctionSummary({
    functionId: 'fn_self',
    directCalls: [{ callSiteId: 'call-self', targetEntityIds: ['fn_self'], summaryId: null, effectSource: 'abi-rule' }],
    memoryReadRegions: [],
    memoryWriteRegions: [],
    unknownCallEffects: [],
    noreturn: false,
    mayThrow: false,
    status: localStatus('complete'),
  });
  const solved = solveInterproceduralSummaries({
    roots: ['fn_self'],
    localSummaries: new Map([['fn_self', local]]),
    snapshotId: SNAPSHOT,
    budget: { maxIterationsPerComponent: 1 },
  });
  const summary = solved.summaries.get('fn_self');
  assert.equal(summary.status.completeness, 'truncated');
  assert.ok(summary.unknownCallEffects.some((unknown) => unknown.reason === 'recursion-unconverged'),
    'the unconverged member must carry the recursion-unconverged effect');
  assert.ok(broadOf(summary.memoryWriteRegions), 'an unconverged summary must clobber broadly on writes');
  assert.ok(broadOf(summary.memoryReadRegions), 'an unconverged summary must clobber broadly on reads');
});

// Required regression #4: a fully resolved, proven no-read/no-write callee must
// not be forced into a spurious broad read by the fix.
test('issue-4772: a proven pure resolved callee gains no unnecessary broad read', () => {
  const callee = createFunctionSummary({
    functionId: 'A',
    noreturn: false,
    mayThrow: false,
    status: createAnalysisStatus({ snapshotId: SNAPSHOT, analyzerId: 'test', analyzerVersion: '1', completeness: 'complete' }),
  });
  const summary = buildLocalFunctionSummary({
    functionId: 'caller',
    values: [],
    nodes: [{
      id: 'call-a',
      kind: 'call',
      inputs: [],
      outputs: [],
      call: {
        targetEntityIds: ['A'],
        completeness: 'complete',
        memoryRead: { scope: 'none' },
        memoryWrite: { scope: 'none' },
        noreturn: false,
        mayThrow: false,
      },
    }],
  }, {}, { definitions: [], uses: [] }, null, {
    snapshotId: SNAPSHOT,
    calleeSummaries: new Map([['A', callee]]),
  }).summary;
  assert.equal(summary.unknownCallEffects.length, 0, 'a resolved pure callee must not stay an unknown boundary');
  assert.equal(summary.status.completeness, 'complete');
  assert.equal(broadOf(summary.memoryReadRegions), false, 'a proven no-read callee must not gain a broad read');
  assert.equal(broadOf(summary.memoryWriteRegions), false, 'a proven no-write callee must not gain a broad write');
});

// Required regression #5: the canonical constructor refuses an unknown-call
// summary that carries a broad write but omits the broad read.
test('issue-4772: canonical contract rejects unknown-call effects without a broad read', () => {
  assert.throws(() => createFunctionSummary({
    functionId: 'caller',
    memoryWriteRegions: [{ regionKind: 'unknown', broad: true, addressSpaces: ['memory'], source: 'unknown-call-fallback' }],
    memoryReadRegions: [],
    unknownCallEffects: [{ callSiteId: 'call-1', reason: 'unresolved-target', targetEntityIds: [] }],
    noreturn: 'unknown',
    mayThrow: 'unknown',
    status: localStatus('partial'),
  }), (error) => error instanceof TypeError
    && error.message === 'function-summary-unknown-call-requires-broad-read-effect',
  '#4772 an unknown-call summary without a broad read must not be constructed');

  const accepted = createFunctionSummary({
    functionId: 'caller',
    memoryWriteRegions: [{ regionKind: 'unknown', broad: true, addressSpaces: ['memory'], source: 'unknown-call-fallback' }],
    memoryReadRegions: [{ regionKind: 'unknown', broad: true, addressSpaces: ['memory'], source: 'unknown-call-fallback' }],
    unknownCallEffects: [{ callSiteId: 'call-1', reason: 'unresolved-target', targetEntityIds: [] }],
    noreturn: 'unknown',
    mayThrow: 'unknown',
    status: localStatus('partial'),
  });
  assert.equal(accepted.unknownCallEffects.length, 1, 'a symmetric broad read/write unknown summary stays valid');
});
