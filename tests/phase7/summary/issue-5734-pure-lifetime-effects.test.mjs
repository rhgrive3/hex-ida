import assert from 'node:assert/strict';
import test from 'node:test';

import { createFunctionSummary, summaryIsPure } from '../../../js/analysis/summary/contract.js';

// #5734: summaryIsPure() ignored the allocations/frees effect dimensions, so
// a complete summary carrying explicit heap effects was judged pure.

const baseSummary = (overrides = {}) => createFunctionSummary({
  functionId:'f',
  inputs:[],
  returnValues:[],
  returnProvenance:[],
  registerEffects:[],
  memoryReadRegions:[],
  memoryWriteRegions:[],
  escapes:[],
  allocations:[],
  frees:[],
  directCalls:[],
  indirectCallSets:[],
  unknownCallEffects:[],
  noreturn:false,
  mayThrow:false,
  stackDelta:null,
  semanticFacts:[],
  status:{
    snapshotId:'s',
    analyzerId:'test',
    analyzerVersion:'1',
    completeness:'complete',
    stopReason:null,
  },
  ...overrides,
});

test('a complete summary with a free is not pure (#5734)', () => {
  assert.equal(summaryIsPure(baseSummary({ frees:['heap-object-1'] })), false);
});

test('a complete summary with an allocation is not pure (#5734)', () => {
  assert.equal(summaryIsPure(baseSummary({ allocations:['alloc-site-1'] })), false);
});

test('an effect-free complete summary remains pure (#5734)', () => {
  assert.equal(summaryIsPure(baseSummary()), true);
});
