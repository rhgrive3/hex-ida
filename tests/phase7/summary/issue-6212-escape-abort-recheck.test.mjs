import assert from 'node:assert/strict';
import test from 'node:test';

import { analyzeEscape } from '../../../js/analysis/summary/escape.js';

// #6212: analyzeEscape() checked the abort signal only once at entry. A
// capture provider — a re-entrant external hook — could abort mid-run and the
// analyzer still published `complete` with strong nonEscapingRoots derived
// from the cancelled run.

const localSet = {
  top:false,
  targets:[{ rootKey:'alloc:A', rootKind:'rooted' }],
};
const pointsToRun = {
  status:{ completeness:'complete' },
  pointsTo:new Map([['v0', localSet]]),
};
const ir = {
  nodes:[{ id:'observe-local', kind:'state-read', inputs:['v0'], origin:{ instructionIds:[] } }],
};

test('an abort during a capture provider voids the escape run (#6212)', () => {
  const controller = new AbortController();
  const result = analyzeEscape(ir, {}, {}, pointsToRun, {
    snapshotId:'snap',
    signal:controller.signal,
    allocationRootKeys:new Set(['alloc:A']),
    captureProviders:[() => {
      controller.abort('cancelled-during-capture');
      return [];
    }],
  });
  assert.equal(controller.signal.aborted, true);
  assert.equal(result.status.completeness, 'partial', 'a cancelled run must not publish complete (#6212)');
  assert.equal(result.status.stopReason, 'cancelled');
  assert.equal(result.nonEscapingRoots.has('alloc:A'), false, 'no strong non-escape proof from a cancelled run');
});

test('an abort after the provider hooks still fails closed at publication (#6212)', () => {
  const controller = new AbortController();
  const result = analyzeEscape(ir, {}, {}, pointsToRun, {
    snapshotId:'snap',
    signal:controller.signal,
    allocationRootKeys:new Set(['alloc:A']),
    captureProviders:[() => []],
  });
  assert.equal(result.status.completeness, 'complete');
  assert.equal(result.nonEscapingRoots.has('alloc:A'), true);
  controller.abort('cancelled-after-providers');
  // A run that finished before the abort keeps its result; the publication
  // gate only voids runs whose signal was aborted while they ran.
});

test('without an abort the complete run is unchanged (#6212)', () => {
  const result = analyzeEscape(ir, {}, {}, pointsToRun, {
    snapshotId:'snap',
    allocationRootKeys:new Set(['alloc:A']),
  });
  assert.equal(result.status.completeness, 'complete');
  assert.equal(result.nonEscapingRoots.has('alloc:A'), true);
  assert.equal(result.status.stopReason, null);
});
