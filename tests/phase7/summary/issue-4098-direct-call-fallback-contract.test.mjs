import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDirectCall,
  createFunctionSummary,
  createMemoryEffect,
  createUnknownCallEffect,
  summaryIsPure,
  summaryMayWriteRegion,
} from '../../../js/analysis/summary/contract.js';
import { buildLocalFunctionSummary } from '../../../js/analysis/summary/local.js';
import { solveInterproceduralSummaries } from '../../../js/analysis/summary/interprocedural.js';

const snapshotId = 'snapshot-4098';

function status(completeness = 'complete') {
  return {
    snapshotId,
    analyzerId: 'issue-4098-test',
    analyzerVersion: '1',
    completeness,
    stopReason: completeness === 'complete' ? null : 'evidence-missing',
  };
}

function broadFallbackWrite() {
  return createMemoryEffect({
    regionKind: 'unknown',
    broad: true,
    addressSpaces: ['memory'],
    source: 'unknown-call-fallback',
  });
}

function baseSummary(overrides = {}) {
  return {
    functionId: 'caller',
    inputs: [],
    returnValues: [],
    returnProvenance: [],
    registerEffects: [],
    memoryReadRegions: [],
    memoryWriteRegions: [],
    escapes: [],
    allocations: [],
    frees: [],
    directCalls: [],
    indirectCallSets: [],
    unknownCallEffects: [],
    noreturn: false,
    mayThrow: false,
    stackDelta: null,
    semanticFacts: [],
    status: status(),
    ...overrides,
  };
}

function fallbackCall(overrides = {}) {
  return createDirectCall({
    callSiteId: 'call-1',
    targetEntityIds: ['callee'],
    summaryId: null,
    effectSource: 'unknown-call-fallback',
    ...overrides,
  });
}

function matchingUnknown(overrides = {}) {
  return createUnknownCallEffect({
    callSiteId: 'call-1',
    reason: 'summary-missing',
    targetEntityIds: ['callee'],
    ...overrides,
  });
}

test('#4098 explicit fallback cannot publish complete/pure without an unknown boundary', () => {
  assert.throws(
    () => createFunctionSummary(baseSummary({ directCalls: [fallbackCall()] })),
    (error) => error?.message === 'function-summary-direct-call-fallback-requires-unknown-effect',
  );
});

test('#4098 omitted effectSource remains conservative rather than laundering to purity', () => {
  const call = createDirectCall({ callSiteId: 'call-1', targetEntityIds: ['callee'] });
  assert.equal(call.effectSource, 'unknown-call-fallback');
  assert.throws(
    () => createFunctionSummary(baseSummary({ directCalls: [call] })),
    (error) => error?.message === 'function-summary-direct-call-fallback-requires-unknown-effect',
  );
});

test('#4098 an unrelated unknown cannot discharge a direct fallback call', () => {
  assert.throws(
    () => createFunctionSummary(baseSummary({
      directCalls: [fallbackCall()],
      memoryWriteRegions: [broadFallbackWrite()],
      unknownCallEffects: [createUnknownCallEffect({ callSiteId: 'other', reason: 'unresolved-target' })],
      noreturn: 'unknown',
      mayThrow: 'unknown',
      status: status('partial'),
    })),
    (error) => error?.message === 'function-summary-direct-call-fallback-requires-unknown-effect',
  );
});

test('#4098 a fallback call requires fallback-authority broad memory coverage', () => {
  const unrelatedBroad = createMemoryEffect({
    regionKind: 'unknown',
    broad: true,
    addressSpaces: ['memory'],
    source: 'proven-summary',
  });
  assert.throws(
    () => createFunctionSummary(baseSummary({
      directCalls: [fallbackCall()],
      memoryWriteRegions: [unrelatedBroad],
      unknownCallEffects: [matchingUnknown()],
      noreturn: 'unknown',
      mayThrow: 'unknown',
      status: status('partial'),
    })),
    (error) => error?.message === 'function-summary-direct-call-fallback-requires-broad-write-effect',
  );
});

test('#4098 matching unknown + broad fallback stays a valid conservative summary', () => {
  const summary = createFunctionSummary(baseSummary({
    directCalls: [fallbackCall()],
    memoryWriteRegions: [broadFallbackWrite()],
    unknownCallEffects: [matchingUnknown()],
    noreturn: 'unknown',
    mayThrow: 'unknown',
    status: status('partial'),
  }));
  assert.equal(summary.status.completeness, 'partial');
  assert.equal(summaryIsPure(summary), false);
  assert.equal(summaryMayWriteRegion(summary, 'any'), true);
});

test('#4098 resolved authority sources remain valid complete summaries', () => {
  for (const effectSource of ['proven-summary', 'library-model', 'abi-rule']) {
    const summary = createFunctionSummary(baseSummary({
      directCalls: [createDirectCall({
        callSiteId: `call-${effectSource}`,
        targetEntityIds: ['callee'],
        summaryId: effectSource === 'proven-summary' ? 'callee' : null,
        effectSource,
      })],
    }));
    assert.equal(summary.status.completeness, 'complete');
    assert.equal(summaryIsPure(summary), true);
  }
});

test('#4098 forged fallback metadata cannot fool public purity/write consumers', () => {
  const canonical = createFunctionSummary(baseSummary({
    directCalls: [createDirectCall({
      callSiteId: 'call-1',
      targetEntityIds: ['callee'],
      effectSource: 'abi-rule',
    })],
  }));
  const forged = {
    ...canonical,
    directCalls: [{ ...canonical.directCalls[0], effectSource: 'unknown-call-fallback' }],
  };
  assert.equal(summaryIsPure(forged), false);
  assert.equal(summaryMayWriteRegion(forged, 'any'), true);
});

test('#4098 interprocedural resolution retires stale fallback authority', () => {
  const localCaller = createFunctionSummary(baseSummary({
    directCalls: [fallbackCall()],
    memoryWriteRegions: [broadFallbackWrite()],
    unknownCallEffects: [matchingUnknown()],
    noreturn: 'unknown',
    mayThrow: 'unknown',
    status: status('partial'),
  }));
  const callee = createFunctionSummary(baseSummary({
    functionId: 'callee',
    directCalls: [],
  }));

  const solved = solveInterproceduralSummaries({
    roots: ['caller'],
    localSummaries: new Map([['caller', localCaller], ['callee', callee]]),
    snapshotId,
  }).summaries.get('caller');

  assert.equal(solved.status.completeness, 'complete');
  assert.equal(solved.unknownCallEffects.length, 0);
  assert.equal(solved.directCalls[0].effectSource, 'proven-summary');
  assert.equal(summaryIsPure(solved), true);
});

test('#4098 interprocedural resolution honors the omitted fallback default on raw local envelopes', () => {
  const rawLocal = baseSummary({
    directCalls: [{ callSiteId: 'call-1', targetEntityIds: ['callee'], summaryId: null }],
    memoryWriteRegions: [broadFallbackWrite()],
    unknownCallEffects: [matchingUnknown()],
    noreturn: 'unknown',
    mayThrow: 'unknown',
    status: status('partial'),
  });
  const callee = createFunctionSummary(baseSummary({ functionId: 'callee' }));
  const solved = solveInterproceduralSummaries({
    roots: ['caller'],
    localSummaries: new Map([['caller', rawLocal], ['callee', callee]]),
    snapshotId,
  }).summaries.get('caller');
  assert.equal(solved.status.completeness, 'complete');
  assert.equal(solved.unknownCallEffects.length, 0);
  assert.equal(solved.directCalls[0].effectSource, 'proven-summary');
});

test('#4098 local unresolved calls retain unknown provenance and broad fallback', () => {
  const node = {
    id: 'call-1', kind: 'call', inputs: [], outputs: [],
    origin: { instructionIds: ['i-call-1'] },
    call: {
      targetEntityIds: ['callee'],
      completeness: 'partial',
      memoryRead: { scope: 'none' },
      memoryWrite: { scope: 'none' },
      noreturn: false,
      mayThrow: false,
    },
  };
  const summary = buildLocalFunctionSummary(
    { functionId: 'caller', values: [], nodes: [node] },
    {}, { definitions: [], uses: [] }, null, { snapshotId },
  ).summary;

  assert.equal(summary.status.completeness, 'partial');
  assert.equal(summary.directCalls[0].effectSource, 'unknown-call-fallback');
  assert.ok(summary.unknownCallEffects.some((effect) => effect.callSiteId === 'call-1'));
  assert.ok(summary.memoryWriteRegions.some((effect) => effect.broad && effect.source === 'unknown-call-fallback'));
  assert.equal(summaryIsPure(summary), false);
});
