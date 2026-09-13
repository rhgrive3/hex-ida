import assert from 'node:assert/strict';
import {
  createFunctionSummary,
  createMemoryEffect,
  createUnknownCallEffect,
  createDirectCall,
  createIndirectCallSet,
} from '../js/analysis/summary/contract.js';

const status = { snapshotId: 'snapshot-1', analyzerId: 'test', analyzerVersion: '1', completeness: 'complete', stopReason: null };

for (const bad of [['fn-A'], { id: 'fn-A' }, 42, true, 3.5]) {
  assert.throws(() => createFunctionSummary({ functionId: bad, status }),
    TypeError, `structured/number/boolean functionId must not be laundered: ${JSON.stringify(bad)}`);
}

assert.throws(() => createMemoryEffect({
  regionId: ['region-A'], regionKind: 'stack-fixed', source: 'proven-summary', evidenceIds: ['ev1'],
}), TypeError, 'array regionId must be rejected');
assert.throws(() => createMemoryEffect({
  regionId: 'region-A', regionKind: ['stack-fixed'], source: 'proven-summary', evidenceIds: ['ev1'],
}), TypeError, 'array regionKind must be rejected');
assert.throws(() => createMemoryEffect({
  regionId: 'region-A', regionKind: 'stack-fixed', source: ['proven-summary'], evidenceIds: ['ev1'],
}), TypeError, 'array effect source must not be promoted into the closed enum');
assert.throws(() => createMemoryEffect({
  regionId: 'region-A', regionKind: 'stack-fixed', source: 'proven-summary', evidenceIds: [['ev1']],
}), TypeError, 'array evidence id must be rejected');

assert.throws(() => createUnknownCallEffect({
  callSiteId: 'site-1', reason: ['unresolved-target'], evidenceIds: [],
}), TypeError, 'array unknown-call reason must not be promoted into the closed enum');
assert.throws(() => createUnknownCallEffect({
  callSiteId: ['site-1'], reason: 'unresolved-target', evidenceIds: [],
}), TypeError, 'array callSiteId must be rejected');

assert.throws(() => createDirectCall({ callSiteId: ['site-1'], targetEntityIds: ['t1'] }),
  TypeError, 'array direct-call site id must be rejected');
assert.throws(() => createDirectCall({ callSiteId: 'site-1', targetEntityIds: [['t1']] }),
  TypeError, 'array direct-call target id must be rejected');
assert.throws(() => createDirectCall({ callSiteId: 'site-1', targetEntityIds: ['t1'], summaryId: { s: 1 } }),
  TypeError, 'object direct-call summary id must be rejected');
assert.throws(() => createIndirectCallSet({ callSiteId: 7, candidateEntityIds: ['c1'] }),
  TypeError, 'number indirect-call site id must be rejected');
assert.throws(() => createIndirectCallSet({ callSiteId: 'site-1', candidateEntityIds: [42] }),
  TypeError, 'number candidate entity id must be rejected');

const effect = createMemoryEffect({
  regionId: ' region-A ', regionKind: 'stack-fixed', source: 'proven-summary',
  evidenceIds: ['ev2', ' ev1 ', 'ev2'],
});
assert.equal(effect.regionId, 'region-A', 'canonical strings keep trim behavior');
assert.deepEqual(effect.evidenceIds, ['ev1', 'ev2'], 'canonical strings keep dedupe/sort behavior');

const summary = createFunctionSummary({
  functionId: ' fn-A ', inputs: ['a', 'a', 'b'], status,
});
assert.equal(summary.functionId, 'fn-A');
assert.deepEqual(summary.inputs, ['a', 'b']);

console.log('issue #3988 FunctionSummary string-only authority fields: PASS');
