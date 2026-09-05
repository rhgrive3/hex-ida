/**
 * #6212 regression: analyzeEscape must not publish complete/nonEscapingRoots
 * after an abort fired during captureProviders. Previously only the entry
 * gate checked signal.aborted, so a provider that aborts mid-run still
 * produced `complete` with strong non-escape proofs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeEscape } from '../js/analysis/summary/escape.js';

function fixture() {
  const localSet = { top: false, targets: [{ rootKey: 'alloc:A', rootKind: 'rooted' }] };
  const pointsToRun = {
    status: { completeness: 'complete' },
    pointsTo: new Map([['v0', localSet]]),
  };
  const ir = {
    nodes: [{ id: 'observe-local', kind: 'state-read', inputs: ['v0'], origin: { instructionIds: [] } }],
  };
  return { pointsToRun, ir };
}

test('#6212 pre-aborted signal stays partial/cancelled', () => {
  const { pointsToRun, ir } = fixture();
  const controller = new AbortController();
  controller.abort('pre-cancelled');
  const result = analyzeEscape(ir, {}, {}, pointsToRun, {
    snapshotId: 'snap',
    signal: controller.signal,
    allocationRootKeys: new Set(['alloc:A']),
  });
  assert.equal(result.status.completeness, 'partial');
  assert.equal(result.status.stopReason, 'cancelled');
  assert.equal(result.nonEscapingRoots.size, 0);
});

test('#6212 abort during captureProviders is not complete', () => {
  const { pointsToRun, ir } = fixture();
  const controller = new AbortController();
  const result = analyzeEscape(ir, {}, {}, pointsToRun, {
    snapshotId: 'snap',
    signal: controller.signal,
    allocationRootKeys: new Set(['alloc:A']),
    captureProviders: [() => { controller.abort('cancelled-during-capture'); return []; }],
  });
  assert.equal(controller.signal.aborted, true);
  assert.notEqual(result.status.completeness, 'complete');
  assert.equal(result.status.stopReason, 'cancelled');
  assert.equal(result.nonEscapingRoots.has('alloc:A'), false);
});

test('#6212 abort during second provider still fail-closed', () => {
  const { pointsToRun, ir } = fixture();
  const controller = new AbortController();
  const result = analyzeEscape(ir, {}, {}, pointsToRun, {
    snapshotId: 'snap',
    signal: controller.signal,
    allocationRootKeys: new Set(['alloc:A']),
    captureProviders: [
      () => [],
      () => { controller.abort('late-cancel'); return []; },
    ],
  });
  assert.equal(result.status.completeness, 'partial');
  assert.equal(result.status.stopReason, 'cancelled');
  assert.equal(result.nonEscapingRoots.size, 0);
});

test('#6212 non-aborted complete path is preserved', () => {
  const { pointsToRun, ir } = fixture();
  const controller = new AbortController();
  const result = analyzeEscape(ir, {}, {}, pointsToRun, {
    snapshotId: 'snap',
    signal: controller.signal,
    allocationRootKeys: new Set(['alloc:A']),
    captureProviders: [() => []],
  });
  assert.equal(result.status.completeness, 'complete');
  assert.equal(result.status.stopReason, null);
  assert.equal(result.nonEscapingRoots.has('alloc:A'), true);
});

test('#6212 partial points-to without abort stays partial', () => {
  const controller = new AbortController();
  const pointsToRun = {
    status: { completeness: 'partial' },
    pointsTo: new Map([['v0', { top: false, targets: [{ rootKey: 'alloc:A', rootKind: 'rooted' }] }]]),
  };
  const ir = {
    nodes: [{ id: 'observe-local', kind: 'state-read', inputs: ['v0'], origin: { instructionIds: [] } }],
  };
  const result = analyzeEscape(ir, {}, {}, pointsToRun, {
    snapshotId: 'snap',
    signal: controller.signal,
    allocationRootKeys: new Set(['alloc:A']),
  });
  assert.equal(result.status.completeness, 'partial');
  // Partial status already signals incompleteness; the pre-existing contract
  // still reports observed local roots, just never as complete proofs.
  assert.equal(result.status.stopReason, 'evidence-missing');
});

test('#6212 provider captures still applied when not aborted', () => {
  const controller = new AbortController();
  const pointsToRun = {
    status: { completeness: 'complete' },
    pointsTo: new Map(),
  };
  const ir = { nodes: [] };
  const result = analyzeEscape(ir, {}, {}, pointsToRun, {
    snapshotId: 'snap',
    signal: controller.signal,
    allocationRootKeys: new Set(['alloc:A']),
    captureProviders: [() => [{ rootKey: 'alloc:A', rootOrigin: 'local-allocation', reason: 'captured-by-closure', boundary: 'closure' }]],
  });
  // An observed escape voids the non-escaping set but the traversal itself
  // is complete.
  assert.equal(result.status.completeness, 'complete');
  assert.equal(result.nonEscapingRoots.has('alloc:A'), false);
  assert.ok(result.escapes.some((e) => e.rootKey === 'alloc:A'));
});
