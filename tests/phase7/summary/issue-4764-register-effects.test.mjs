import assert from 'node:assert/strict';
import test from 'node:test';

import { createAnalysisStatus } from '../../../js/analysis/status.js';
import { createFunctionSummary } from '../../../js/analysis/summary/contract.js';
import { solveInterproceduralSummaries } from '../../../js/analysis/summary/interprocedural.js';
import { buildLocalFunctionSummary } from '../../../js/analysis/summary/local.js';
import { buildFixture } from '../corpus/fixtures.mjs';

const SNAPSHOT = 'snapshot-4764';

function completeStatus() {
  return createAnalysisStatus({
    snapshotId: SNAPSHOT,
    analyzerId: 'phase7.summary.local',
    analyzerVersion: '1.2.0',
    completeness: 'complete',
    stopReason: null,
  });
}

function summary(functionId, { registerEffects = [], directCalls = [], indirectCallSets = [] } = {}) {
  return createFunctionSummary({
    functionId,
    registerEffects,
    directCalls,
    indirectCallSets,
    noreturn: false,
    mayThrow: false,
    status: completeStatus(),
  });
}

function direct(callSiteId, target) {
  return { callSiteId, targetEntityIds: [target], effectSource: 'proven-summary' };
}

test('issue-4764: direct callee register effects propagate to the caller', () => {
  const caller = summary('caller', { directCalls: [direct('call-b', 'callee')] });
  const callee = summary('callee', { registerEffects: ['state:r0'] });
  const solved = solveInterproceduralSummaries({
    roots: ['caller'],
    localSummaries: new Map([['caller', caller], ['callee', callee]]),
    snapshotId: SNAPSHOT,
  });
  assert.deepEqual(solved.summaries.get('caller').registerEffects, ['state:r0']);
});

test('issue-4764: register effects propagate transitively through an acyclic chain', () => {
  const a = summary('a', { directCalls: [direct('a-b', 'b')] });
  const b = summary('b', { directCalls: [direct('b-c', 'c')] });
  const c = summary('c', { registerEffects: ['state:r2'] });
  const solved = solveInterproceduralSummaries({
    roots: ['a'],
    localSummaries: new Map([['a', a], ['b', b], ['c', c]]),
    snapshotId: SNAPSHOT,
  });
  assert.deepEqual(solved.summaries.get('b').registerEffects, ['state:r2']);
  assert.deepEqual(solved.summaries.get('a').registerEffects, ['state:r2']);
});

test('issue-4764: exhaustive indirect candidates union and canonicalize register effects', () => {
  const caller = summary('dispatch', {
    registerEffects: ['state:r3'],
    indirectCallSets: [{
      callSiteId: 'dispatch.multi',
      candidateEntityIds: ['left', 'right'],
      exhaustive: true,
    }],
  });
  const left = summary('left', { registerEffects: ['state:r1', 'state:r3'] });
  const right = summary('right', { registerEffects: ['state:r0', 'state:r1'] });
  const solved = solveInterproceduralSummaries({
    roots: ['dispatch'],
    localSummaries: new Map([['dispatch', caller], ['left', left], ['right', right]]),
    snapshotId: SNAPSHOT,
  });
  assert.deepEqual(solved.summaries.get('dispatch').registerEffects,
    ['state:r0', 'state:r1', 'state:r3']);
});

test('issue-4764: mutual recursion reaches a register-effect fixed point', () => {
  const a = summary('ra', { directCalls: [direct('ra-rb', 'rb')] });
  const b = summary('rb', {
    registerEffects: ['state:r7'],
    directCalls: [direct('rb-ra', 'ra')],
  });
  const solved = solveInterproceduralSummaries({
    roots: ['ra'],
    localSummaries: new Map([['ra', a], ['rb', b]]),
    snapshotId: SNAPSHOT,
  });
  assert.equal(solved.status.completeness, 'complete');
  assert.deepEqual(solved.summaries.get('ra').registerEffects, ['state:r7']);
  assert.deepEqual(solved.summaries.get('rb').registerEffects, ['state:r7']);
});

test('issue-4764: local resolved-callee folding includes register effects', () => {
  const built = buildFixture('pure-call-no-barrier');
  const callNode = built.ir.nodes.find((node) => node.kind === 'call');
  assert.ok(callNode);
  const calleeId = callNode.call.targetEntityIds[0];
  const callee = summary(calleeId, { registerEffects: ['state:r9'] });
  const result = buildLocalFunctionSummary(built.ir, built.cfg, built.ssa, built.memorySsa, {
    snapshotId: SNAPSHOT,
    resolveRegion: built.resolveRegion,
    calleeSummaries: new Map([[calleeId, callee]]),
  });
  assert.deepEqual(result.summary.registerEffects, ['state:r9']);
});


test('issue-4764: unresolved calls do not make empty registerEffects authoritative', () => {
  const caller = summary('unresolved-caller', {
    directCalls: [direct('call-missing', 'missing-callee')],
  });
  const solved = solveInterproceduralSummaries({
    roots: ['unresolved-caller'],
    localSummaries: new Map([['unresolved-caller', caller]]),
    snapshotId: SNAPSHOT,
  });
  const result = solved.summaries.get('unresolved-caller');
  assert.deepEqual(result.registerEffects, []);
  assert.notEqual(result.status.completeness, 'complete');
  assert.ok(result.unknownCallEffects.some((effect) => effect.callSiteId === 'call-missing'));
  assert.ok(result.memoryWriteRegions.some((effect) => effect.broad));
});
