import test from 'node:test';
import assert from 'node:assert/strict';
import { fuseFunctionCandidates } from '../js/analysis/discovery/fusion.js';

const item = (overrides) => ({
  start: '4096',
  authority: 'authoritative',
  producerId: 'source',
  kind: 'unwind-entry',
  extentRole: 'complete',
  regions: [],
  ...overrides,
});

const complete = (start, end, producerId = 'complete-source') => item({
  producerId,
  extentRole: 'complete',
  regions: [{ start: String(start), end: String(end), ownership: 'exclusive' }],
});

const partial = (start, end, producerId = 'partial-source', ownership = 'exclusive') => item({
  producerId,
  extentRole: 'partial',
  regions: [{ start: String(start), end: String(end), ownership }],
});

function fused(evidence) {
  const { candidates } = fuseFunctionCandidates(evidence, { snapshotId: 's' });
  assert.equal(candidates.length, 1);
  return candidates[0];
}

test('6047: contained partial keeps the exact claim', () => {
  const c = fused([complete(0x1000, 0x1020), partial(0x1008, 0x1010)]);
  assert.equal(c.extentState, 'exact');
  assert.equal(c.conflicts.length, 0);
});

test('6047: outside authoritative partial withdraws the exact claim', () => {
  const c = fused([complete(0x1000, 0x1010), partial(0x2000, 0x2010)]);
  assert.equal(c.extentState, 'unknown');
  assert.deepEqual(c.regions, []);
  assert.ok(c.conflicts.some((conflict) => conflict.kind === 'extent'), 'expected an extent conflict');
});

test('6047: partial inside one region of a non-contiguous complete claim is fine', () => {
  const multi = item({
    producerId: 'complete-source',
    extentRole: 'complete',
    regions: [
      { start: String(0x1000), end: String(0x1010), ownership: 'exclusive' },
      { start: String(0x2000), end: String(0x2020), ownership: 'exclusive' },
    ],
  });
  const c = fused([multi, partial(0x2008, 0x2010)]);
  assert.equal(c.extentState, 'exact');
  assert.equal(c.conflicts.length, 0);
});

test('6047: disagreeing complete claims still conflict', () => {
  const c = fused([complete(0x1000, 0x1010, 'a'), complete(0x1000, 0x1020, 'b')]);
  assert.equal(c.extentState, 'unknown');
});

test('6047: lower-tier partials do not disturb an authoritative complete claim', () => {
  const c = fused([
    complete(0x1000, 0x1010),
    { ...partial(0x2000, 0x2010), authority: 'corroborating' },
  ]);
  assert.equal(c.extentState, 'exact');
});
