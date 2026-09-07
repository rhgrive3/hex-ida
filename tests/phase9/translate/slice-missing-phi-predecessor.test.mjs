import assert from 'node:assert/strict';
import test from 'node:test';

import { OP } from '../../../js/ir-base.js';
import { backwardDependencySlice } from '../../../js/symbolic/translate/slice.js';

const valueA = { id: 'a', kind: 'arg', origin: '0x1000' };
const valueB = { id: 'b', kind: 'arg', origin: '0x1004' };
const phi = {
  id: 'p',
  op: OP.PHI,
  origin: '0x1008',
  incoming: [
    { from: 'A', value: valueA },
    { from: 'B', value: valueB },
  ],
};

test('slice follows only the selected predecessor for a valid fromBlock', () => {
  const slice = backwardDependencySlice(phi, { fromBlock: 'A' });
  assert.equal(slice.instructions.has('p'), true);
  assert.equal(slice.values.has('a'), true);
  assert.equal(slice.values.has('b'), false);
  assert.equal(slice.completeness.controlFlow, 'complete');
  assert.equal(slice.completeness.queryScope, 'complete');
});

test('slice without fromBlock follows every incoming', () => {
  const slice = backwardDependencySlice(phi, {});
  assert.equal(slice.values.has('a'), true);
  assert.equal(slice.values.has('b'), true);
  assert.equal(slice.completeness.controlFlow, 'complete');
  assert.equal(slice.completeness.queryScope, 'complete');
});

test('slice with an unknown fromBlock is not complete and records the gap', () => {
  const slice = backwardDependencySlice(phi, { fromBlock: 'C' });
  assert.equal(slice.instructions.has('p'), true);
  assert.equal(slice.values.size, 0);
  assert.equal(slice.hasCycle, false);
  assert.equal(slice.hitDepthLimit, false);
  assert.equal(slice.completeness.controlFlow, 'partial');
  assert.equal(slice.completeness.queryScope, 'partial');
  const reasons = slice.assumptions.filter((item) => item?.kind === 'missing-phi-predecessor');
  assert.equal(reasons.length >= 1, true);
  assert.match(String(reasons[0]?.statement || ''), /C/);
});

test('slice with an unknown fromBlock on a single-incoming phi is not complete', () => {
  const single = {
    id: 'phi1',
    op: OP.PHI,
    incoming: [{ from: 'pred-A', value: { id: 'v1', kind: 'arg' } }],
  };
  const slice = backwardDependencySlice(single, { fromBlock: 'pred-B' });
  assert.equal(slice.values.size, 0);
  assert.equal(slice.completeness.controlFlow, 'partial');
  assert.equal(slice.completeness.queryScope, 'partial');
  assert.equal(slice.assumptions.some((item) => item?.kind === 'missing-phi-predecessor'), true);
});

test('slice with duplicate matching predecessors fails closed instead of selecting the first incoming', () => {
  const duplicate = {
    id: 'phi-duplicate',
    op: OP.PHI,
    incoming: [
      { from: 'pred-A', value: valueA },
      { from: 'pred-A', value: valueB },
    ],
  };
  const slice = backwardDependencySlice(duplicate, { fromBlock: 'pred-A' });
  assert.equal(slice.instructions.has('phi-duplicate'), true);
  assert.equal(slice.values.size, 0);
  assert.equal(slice.completeness.controlFlow, 'partial');
  assert.equal(slice.completeness.queryScope, 'partial');
  const reasons = slice.assumptions.filter((item) => item?.kind === 'ambiguous-phi-predecessor');
  assert.equal(reasons.length, 1);
  assert.match(String(reasons[0]?.statement || ''), /2 incoming values/);
  assert.match(String(reasons[0]?.statement || ''), /pred-A/);
});
