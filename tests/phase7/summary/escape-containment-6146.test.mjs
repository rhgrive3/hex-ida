import assert from 'node:assert/strict';
import test from 'node:test';

import {
  analyzeEscape,
  invalidatesNonEscapeProof,
} from '../../../js/analysis/summary/escape.js';

// Issue 6146: containment propagation must reach a fixpoint over
// (root, escape fact), not stop at "already escaped".
const tgt = (rootKey, rootKind) => ({ rootKey, rootKind });

function chainFixture() {
  const pointsTo = new Map([
    ['vA_val', { targets: [tgt('A', 'stack-like')] }],
    ['vG', { targets: [tgt('G', 'absolute')] }],
    ['vB_val', { targets: [tgt('B', 'stack-like')] }],
    ['vA_addr', { targets: [tgt('A', 'stack-like')] }],
    ['vC_val', { targets: [tgt('C', 'stack-like')] }],
    ['vB_addr', { targets: [tgt('B', 'stack-like')] }],
    ['vD_val', { targets: [tgt('D', 'stack-like')] }],
    ['vC_addr', { targets: [tgt('C', 'stack-like')] }],
  ]);
  const pointsToRun = { pointsTo, status: { completeness: 'complete' } };
  // Node order records A=stored-to-global before B=passed-to-known-call, so the
  // LIFO worklist processes the already-escaped intermediate root B first.
  const ir = { nodes: [
    { id: 's1', kind: 'store', inputs: ['x0', 'vA_val'], memory: { addressExpr: { valueId: 'vG' } } },
    { id: 'c1', kind: 'call', call: { completeness: 'complete', arguments: [{ valueId: 'vB_val' }] }, inputs: [] },
    { id: 's2', kind: 'store', inputs: ['x1', 'vB_val'], memory: { addressExpr: { valueId: 'vA_addr' } } },
    { id: 's3', kind: 'store', inputs: ['x2', 'vC_val'], memory: { addressExpr: { valueId: 'vB_addr' } } },
    { id: 's4', kind: 'store', inputs: ['x3', 'vD_val'], memory: { addressExpr: { valueId: 'vC_addr' } } },
  ] };
  const options = { allocationRootKeys: new Set(['A', 'B', 'C', 'D']) };
  return { pointsToRun, ir, options };
}

const reasonsOf = (result, root) =>
  result.escapes.filter((record) => record.rootKey === root).map((record) => record.reason);

test('6146: a late stronger reason crosses an already-escaped intermediate root', () => {
  const { pointsToRun, ir, options } = chainFixture();
  const result = analyzeEscape(ir, null, null, pointsToRun, options);
  assert.ok(reasonsOf(result, 'C').includes('passed-to-known-call'));
  assert.ok(reasonsOf(result, 'C').includes('stored-to-global'),
    `C must inherit the late stored-to-global reason (got ${JSON.stringify(reasonsOf(result, 'C'))})`);
});

test('6146: propagation reaches the end of a longer chain', () => {
  const { pointsToRun, ir, options } = chainFixture();
  const result = analyzeEscape(ir, null, null, pointsToRun, options);
  assert.ok(reasonsOf(result, 'D').includes('stored-to-global'),
    `D must inherit stored-to-global transitively (got ${JSON.stringify(reasonsOf(result, 'D'))})`);
});

test('6146: a global publication is not hidden behind a known-call record', () => {
  const { pointsToRun, ir, options } = chainFixture();
  const result = analyzeEscape(ir, null, null, pointsToRun, options);
  const flags = result.escapes
    .filter((record) => record.rootKey === 'C')
    .map(invalidatesNonEscapeProof);
  assert.ok(flags.includes(true), 'C must carry an invalidating global-publication reason');
});

test('6146: identical facts do not multiply without bound', () => {
  const { pointsToRun, ir, options } = chainFixture();
  const result = analyzeEscape(ir, null, null, pointsToRun, options);
  const keys = result.escapes.map((record) =>
    `${record.rootKey}|${record.reason}|${record.boundary}|${record.siteId ?? ''}`);
  assert.equal(keys.length, new Set(keys).size, 'propagated facts must stay deduplicated');
});

test('6146: cyclic containment still converges', () => {
  const { pointsToRun, options } = chainFixture();
  const cyclic = {
    nodes: [
      { id: 's1', kind: 'store', inputs: ['x0', 'vA_val'], memory: { addressExpr: { valueId: 'vG' } } },
      { id: 'c1', kind: 'call', call: { completeness: 'complete', arguments: [{ valueId: 'vB_val' }] }, inputs: [] },
      { id: 's2', kind: 'store', inputs: ['x1', 'vB_val'], memory: { addressExpr: { valueId: 'vA_addr' } } },
      { id: 's3', kind: 'store', inputs: ['x2', 'vC_val'], memory: { addressExpr: { valueId: 'vB_addr' } } },
      // Close the cycle: A is stored into C as well.
      { id: 's4', kind: 'store', inputs: ['x4', 'vA_val'], memory: { addressExpr: { valueId: 'vC_addr' } } },
    ],
  };
  const result = analyzeEscape(cyclic, null, null, pointsToRun, options);
  assert.ok(reasonsOf(result, 'C').includes('stored-to-global'));
  assert.ok(result.escapes.length < 50, 'cyclic propagation must terminate with a bounded record set');
});
