import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createFunctionSummary,
  createMemoryEffect,
  summaryMayWriteRegion,
} from '../../../js/analysis/summary/contract.js';
import * as core from '../../../js/analysis/summary/contract-core.js';

const STATUS = {
  snapshotId: 'snapshot-4067',
  analyzerId: 'test',
  analyzerVersion: '1',
  completeness: 'complete',
  stopReason: null,
};

const unresolved = (build, extra = {}) => () => build({
  regionKind: 'unknown',
  broad: false,
  addressSpaces: ['memory'],
  source: 'proven-summary',
  ...extra,
});

function rejectsUnresolvedEffect(build, extra = {}) {
  assert.throws(
    unresolved(build, extra),
    (error) => error?.message === 'function-summary-unresolved-memory-region'
      || error?.code === 'function-summary-unresolved-memory-region',
  );
}

test('#4067 public memory-effect constructor rejects non-broad effects without a region identity', () => {
  rejectsUnresolvedEffect(createMemoryEffect);
});

test('#4067 omitted broad defaults to specific and still requires a region identity', () => {
  rejectsUnresolvedEffect(createMemoryEffect, { broad: undefined });
});

test('#4067 core constructor enforces the same canonical shape invariant', () => {
  rejectsUnresolvedEffect(core.createMemoryEffect);
});

test('#4067 a specific effect with a canonical region id remains valid', () => {
  const effect = createMemoryEffect({
    regionId: 'memoryregion:target',
    regionKind: 'stack-fixed',
    broad: false,
    addressSpaces: ['memory'],
    source: 'proven-summary',
  });
  assert.equal(effect.regionId, 'memoryregion:target');
  assert.equal(effect.broad, false);
});

test('#4067 a broad conservative effect may remain unbound to a region id', () => {
  const effect = createMemoryEffect({
    regionKind: 'unknown',
    broad: true,
    addressSpaces: ['memory'],
    source: 'unknown-call-fallback',
  });
  assert.equal(effect.regionId, null);
  assert.equal(effect.broad, true);
});

test('#4067 malformed specific writes cannot reach a complete summary or false NoWrite answer', () => {
  assert.throws(
    () => createFunctionSummary({
      functionId: 'f',
      memoryWriteRegions: [{
        regionId: null,
        regionKind: 'unknown',
        broad: false,
        addressSpaces: ['memory'],
        source: 'proven-summary',
      }],
      status: STATUS,
    }),
    (error) => error?.message === 'function-summary-unresolved-memory-region'
      || error?.code === 'function-summary-unresolved-memory-region',
  );

  const broad = createFunctionSummary({
    functionId: 'f',
    memoryWriteRegions: [{
      regionKind: 'unknown',
      broad: true,
      addressSpaces: ['memory'],
      source: 'abi-rule',
    }],
    status: STATUS,
  });
  assert.equal(summaryMayWriteRegion(broad, 'memoryregion:target'), true);
});
