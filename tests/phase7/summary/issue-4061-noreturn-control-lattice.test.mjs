import assert from 'node:assert/strict';
import test from 'node:test';

import { createAnalysisStatus } from '../../../js/analysis/status.js';
import { createFunctionSummary } from '../../../js/analysis/summary/contract.js';
import { solveInterproceduralSummaries } from '../../../js/analysis/summary/interprocedural.js';

const complete = () => createAnalysisStatus({
  snapshotId: 'snapshot-issue-4061',
  analyzerId: 'phase7.summary.local',
  analyzerVersion: '1.0.0',
  completeness: 'complete',
});

function terminator(functionId, overrides = {}) {
  return createFunctionSummary({
    functionId,
    noreturn: true,
    mayThrow: false,
    status: complete(),
    ...overrides,
  });
}

function caller(calleeId, overrides = {}) {
  return createFunctionSummary({
    functionId: 'caller',
    noreturn: false,
    mayThrow: false,
    directCalls: [{
      callSiteId: 'caller.call.callee',
      targetEntityIds: [calleeId],
      summaryId: calleeId,
      effectSource: 'proven-summary',
    }],
    status: complete(),
    ...overrides,
  });
}

function solvedWith(callee, callerSummary) {
  const solved = solveInterproceduralSummaries({
    roots: ['caller'],
    localSummaries: new Map([['caller', callerSummary], ['callee', callee]]),
    snapshotId: 'snapshot-issue-4061',
  });
  return solved.summaries.get('caller');
}

test('a proven normal-return caller is not strengthened to noreturn by one diverging callee', () => {
  const summary = solvedWith(terminator('callee'), caller('callee'));
  assert.equal(summary.noreturn, 'unknown');
});

test('noreturn control lattice publishes true only when every side proves divergence', () => {
  assert.equal(solvedWith(terminator('callee'), caller('callee', { noreturn: true })).noreturn, true);
  assert.equal(solvedWith(terminator('callee'), caller('callee')).noreturn, 'unknown');
  assert.equal(
    solvedWith(terminator('callee', { noreturn: false }), caller('callee')).noreturn,
    false,
    'a callee that proves it returns must not publish the caller as noreturn',
  );
  assert.equal(
    solvedWith(terminator('callee', { noreturn: false }), caller('callee', { noreturn: true })).noreturn,
    'unknown',
    'a caller whose only divergence proof is a returning callee loses that proof',
  );
});

test('unknown on either side of the noreturn join stays explicit', () => {
  assert.equal(solvedWith(terminator('callee', { noreturn: 'unknown' }), caller('callee')).noreturn, 'unknown');
  assert.equal(
    solvedWith(terminator('callee'), caller('callee', { noreturn: 'unknown' })).noreturn,
    'unknown',
  );
  assert.equal(
    solvedWith(terminator('callee', { noreturn: 'unknown' }), caller('callee', { noreturn: 'unknown' })).noreturn,
    'unknown',
  );
});

test('mayThrow keeps its may-union semantics on the same edge set', () => {
  const summary = solvedWith(terminator('callee', { noreturn: true, mayThrow: true }), caller('callee'));
  assert.equal(summary.mayThrow, true);
  assert.equal(summary.noreturn, 'unknown');
  const quiet = solvedWith(terminator('callee', { noreturn: true, mayThrow: false }), caller('callee'));
  assert.equal(quiet.mayThrow, false);
});

test('exhaustive indirect candidates use the same control lattice as direct calls', () => {
  const indirectCaller = createFunctionSummary({
    functionId: 'caller',
    noreturn: false,
    mayThrow: false,
    indirectCallSets: [{
      callSiteId: 'caller.dispatch',
      candidateEntityIds: ['callee'],
      exhaustive: true,
    }],
    status: complete(),
  });
  const solved = solveInterproceduralSummaries({
    roots: ['caller'],
    localSummaries: new Map([['caller', indirectCaller], ['callee', terminator('callee')]]),
    snapshotId: 'snapshot-issue-4061',
  });
  const indirect = solved.summaries.get('caller');
  const direct = solvedWith(terminator('callee'), caller('callee'));
  assert.equal(indirect.noreturn, 'unknown');
  assert.equal(indirect.noreturn, direct.noreturn);
});
