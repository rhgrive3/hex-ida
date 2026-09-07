import assert from 'node:assert/strict';
import test from 'node:test';

import { createTypeGraphResult } from '../../../js/analysis/types/graph.js';
import { createAnalysisStatus } from '../../../js/analysis/status.js';

const status = createAnalysisStatus({
  snapshotId: 'snapshot_issue_6070',
  analyzerId: 'phase7.types.test',
  analyzerVersion: '1',
  completeness: 'complete',
});

function result() {
  return createTypeGraphResult({
    snapshotId: 'snapshot_issue_6070',
    results: new Map([['A', { value: 1 }]]),
    components: [],
    recursiveComponents: [],
    iterations: 0,
    status,
  });
}

test('#6070 instance mutator overrides stay in place', () => {
  const view = result().results;
  assert.throws(() => view.set('B', { value: 2 }), /TypeGraphResult\.results is read-only/);
  assert.throws(() => view.delete('A'), /TypeGraphResult\.results is read-only/);
  assert.throws(() => view.clear(), /TypeGraphResult\.results is read-only/);
});

test('#6070 Map.prototype calls cannot reach the internal slot of a published result', () => {
  // The instance-property defense left the [[MapData]] slot reachable: a
  // prototype method invoked with the view as `this` mutated the published
  // analysis result after the fact.
  const view = result().results;
  assert.throws(() => Map.prototype.set.call(view, 'B', { value: 2 }), /read-only|incompatible/);
  assert.throws(() => Map.prototype.delete.call(view, 'A'), /read-only|incompatible/);
  assert.throws(() => Map.prototype.clear.call(view), /read-only|incompatible/);
  assert.equal(view.size, 1);
  assert.equal(view.has('B'), false);
  assert.deepEqual(view.get('A'), { value: 1 });
});

test('#6070 the read API behaves like a Map', () => {
  const view = result().results;
  assert.ok(view instanceof Map);
  assert.equal(view.size, 1);
  assert.deepEqual([...view.entries()], [['A', { value: 1 }]]);
  const seen = [];
  for (const [key, value] of view) seen.push([key, value]);
  assert.deepEqual(seen, [['A', { value: 1 }]]);
  let forEachSeen = 0;
  let callbackMap = null;
  view.forEach((_value, _key, map) => {
    forEachSeen += 1;
    callbackMap = map;
  });
  assert.equal(forEachSeen, 1);
  assert.equal(callbackMap, view);
  assert.throws(() => callbackMap.set('B', { value: 2 }), /TypeGraphResult\\.results is read-only/);
  assert.throws(() => callbackMap.delete('A'), /TypeGraphResult\\.results is read-only/);
  assert.throws(() => Map.prototype.set.call(callbackMap, 'C', { value: 3 }), /read-only|incompatible/);
  assert.equal(view.size, 1);
  assert.equal(view.has('B'), false);
  assert.equal(view.has('C'), false);
});

test('#6070 the view rejects direct property writes and deletions', () => {
  const view = result().results;
  assert.throws(() => { view.arbitrary = true; }, /TypeGraphResult\.results is read-only/);
  assert.throws(() => { delete view.arbitrary; }, /TypeGraphResult\.results is read-only/);
});
