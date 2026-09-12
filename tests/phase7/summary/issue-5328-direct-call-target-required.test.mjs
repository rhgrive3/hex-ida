import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDirectCall,
  createFunctionSummary,
  summaryIsPure,
  FUNCTION_SUMMARY_CONTRACT_VERSION,
} from '../../../js/analysis/summary/contract.js';
import * as core from '../../../js/analysis/summary/contract-core.js';
import { buildLocalFunctionSummary } from '../../../js/analysis/summary/local.js';

function summaryInput(directCalls) {
  return {
    functionId: 'f',
    inputs: [],
    returnValues: [],
    returnProvenance: [],
    registerEffects: [],
    memoryReadRegions: [],
    memoryWriteRegions: [],
    escapes: [],
    allocations: [],
    frees: [],
    directCalls,
    indirectCallSets: [],
    unknownCallEffects: [],
    noreturn: false,
    mayThrow: false,
    stackDelta: null,
    semanticFacts: [],
    status: {
      snapshotId: 's', analyzerId: 'test', analyzerVersion: '1',
      completeness: 'complete', stopReason: null,
    },
  };
}

test('#5328 a single resolved target keeps the direct-call record valid', () => {
  const call = createDirectCall({
    callSiteId: 'call-1',
    targetEntityIds: ['callee-1'],
    summaryId: null,
    effectSource: 'unknown-call-fallback',
  });
  assert.deepEqual(call.targetEntityIds, ['callee-1']);

  const summary = createFunctionSummary(summaryInput([call]));
  assert.equal(summary.status.completeness, 'complete');
  assert.equal(summary.directCalls.length, 1);
  assert.equal(summaryIsPure(summary), true);
});

test('#5328 a zero-target direct call is rejected at both contract layers', () => {
  for (const build of [createDirectCall, core.createDirectCall]) {
    assert.throws(
      () => build({
        callSiteId: 'call-1',
        targetEntityIds: [],
        summaryId: null,
        effectSource: 'unknown-call-fallback',
      }),
      (error) => error?.message === 'function-summary-direct-call-target-required'
        || error?.code === 'function-summary-direct-call-target-required',
    );
  }
  assert.throws(
    () => createDirectCall({ callSiteId: 'call-1' }),
    (error) => error?.message === 'function-summary-direct-call-target-required'
      || error?.code === 'function-summary-direct-call-target-required',
  );
});

test('#5328 createFunctionSummary rejects the issue repro before it can claim completeness', () => {
  assert.throws(
    () => createFunctionSummary(summaryInput([{
      callSiteId: 'call-1',
      targetEntityIds: [],
      summaryId: null,
      effectSource: 'unknown-call-fallback',
    }])),
    (error) => error?.message === 'function-summary-direct-call-target-required'
      || error?.code === 'function-summary-direct-call-target-required',
  );
});

test('#5328 a forged zero-target direct call can never validate as pure', () => {
  const forged = {
    ...summaryInput([]),
    schemaVersion: core.FUNCTION_SUMMARY_SCHEMA_VERSION,
    contractVersion: FUNCTION_SUMMARY_CONTRACT_VERSION,
    directCalls: [{
      callSiteId: 'call-1',
      targetEntityIds: [],
      summaryId: null,
      effectSource: 'unknown-call-fallback',
    }],
  };
  assert.equal(summaryIsPure(forged), false);
});

test('#5328 an unresolved call producer keeps the unknown-call boundary, not a direct record', () => {
  const { summary } = buildLocalFunctionSummary(
    {
      functionId: 'fn_caller',
      values: [],
      nodes: [{
        id: 'call_0',
        kind: 'call',
        inputs: [],
        outputs: [],
        call: {
          targetValueIds: [],
          targetEntityIds: [],
          memoryRead: { scope: 'none' },
          memoryWrite: { scope: 'none' },
          completeness: 'complete',
          mayThrow: false,
          noreturn: false,
        },
        origin: { instructionIds: ['instruction_call_0'] },
      }],
    },
    {},
    { definitions: [], uses: [] },
    {},
    { snapshotId: 'snapshot-5328' },
  );

  assert.equal(summary.status.completeness, 'partial');
  assert.equal(summary.unknownCallEffects.length, 1);
  assert.equal(summary.unknownCallEffects[0].reason, 'unresolved-target');
  assert.equal(summary.directCalls.length, 0);
  assert.ok(summary.memoryWriteRegions.some((effect) => effect.broad));
  assert.equal(summaryIsPure(summary), false);
});
