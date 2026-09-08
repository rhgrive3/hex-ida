import assert from 'node:assert/strict';
import test from 'node:test';

import { analyzeEscape } from '../../../js/analysis/summary/escape.js';

function pointsTo(entries) {
  return {
    status: { completeness: 'complete' },
    pointsTo: new Map(Object.entries(entries).map(([valueId, rootKey]) => [
      valueId,
      { top: false, targets: [{ rootKey, rootKind: 'stack-like' }] },
    ])),
  };
}

function run(node, entries) {
  return analyzeEscape(
    { nodes: [{ id: 'call-1', ...node }] },
    {},
    {},
    pointsTo(entries),
    { snapshotId: 'snapshot-3814' },
  );
}

function escapedRoots(result) {
  return result.escapes.map((record) => record.rootKey);
}

test('canonical indirect-call arguments exclude the callee target', () => {
  const result = run({
    kind: 'call',
    inputs: ['fnptr'],
    call: {
      targetValueIds: ['fnptr'],
      arguments: ['arg0'],
      completeness: 'complete',
    },
  }, { fnptr: 'F', arg0: 'A' });

  assert.deepEqual(escapedRoots(result), ['A']);
  assert.equal(result.escapes[0].reason, 'passed-to-known-call');
  assert.equal(result.escapes[0].boundary, 'known-call');
  assert.equal(result.nonEscapingRoots.has('F'), true);
  assert.equal(result.status.completeness, 'complete');
});

test('direct-call canonical arguments remain escape inputs', () => {
  const result = run({
    kind: 'call',
    inputs: [],
    call: {
      arguments: [{ valueId: 'arg0' }],
      completeness: 'complete',
    },
  }, { arg0: 'A' });

  assert.deepEqual(escapedRoots(result), ['A']);
});

test('zero-argument indirect calls do not publish the target root', () => {
  const result = run({
    kind: 'call',
    inputs: ['fnptr'],
    call: {
      targetValueIds: ['fnptr'],
      arguments: [],
      completeness: 'complete',
    },
  }, { fnptr: 'F' });

  assert.deepEqual(result.escapes, []);
  assert.equal(result.nonEscapingRoots.has('F'), true);
});

test('legacy input fallback excludes targetValueIds when arguments are absent', () => {
  const result = run({
    kind: 'call',
    inputs: ['fnptr', 'legacyArg'],
    call: {
      targetValueIds: ['fnptr'],
      completeness: 'complete',
    },
  }, { fnptr: 'F', legacyArg: 'A' });

  assert.deepEqual(escapedRoots(result), ['A']);
  assert.equal(result.nonEscapingRoots.has('F'), true);
});

test('legacy input fallback also excludes structured targets when arguments are empty', () => {
  const result = run({
    kind: 'call',
    inputs: ['fnptr', 'legacyArg'],
    call: {
      targetValueIds: [{ valueId: 'fnptr' }],
      arguments: [],
      completeness: 'complete',
    },
  }, { fnptr: 'F', legacyArg: 'A' });

  assert.deepEqual(escapedRoots(result), ['A']);
  assert.equal(result.nonEscapingRoots.has('F'), true);
});

test('unknown calls keep target roots out of escape provenance', () => {
  const result = run({
    kind: 'call',
    inputs: ['fnptr'],
    call: {
      targetValueIds: ['fnptr'],
      arguments: ['arg0'],
      completeness: 'partial',
    },
  }, { fnptr: 'F', arg0: 'A' });

  assert.deepEqual(escapedRoots(result), ['A']);
  assert.equal(result.escapes[0].reason, 'passed-to-unknown-call');
  assert.equal(result.escapes[0].boundary, 'unknown-call');
  assert.equal(result.escapes.some((record) => record.rootKey === 'F'), false);
  assert.equal(result.sawUnresolvedFlow, true);
  assert.equal(result.nonEscapingRoots.size, 0);
  assert.equal(result.status.completeness, 'partial');
});
