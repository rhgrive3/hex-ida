import assert from 'node:assert/strict';
import test from 'node:test';

import { ChangeLog, createProjectOperation } from '../js/collaboration/index.js';

// #8901: ChangeLog recorded each new competing value on a meaningful fact by
// *appending* a fresh meaningful-conflict entry whose operationIds held the
// entire prefix of competing IDs seen so far. For N values that retained
// 2 + 3 + ... + N = Theta(N^2) redundant IDs (fully duplicated by the fact's own
// values[] array), and snapshot()/checkpoint()/digest()/remote-delivery all
// structuredClone/hash the whole quadratic array -- a few thousand otherwise-valid
// canonical operations deterministically exhausted the heap. A privileged
// materialization must not retain history with size beyond the predicate that
// justifies it: one meaningful conflict exists per fact key, so exactly one
// bounded entry (carrying the current competing set) may be retained.

const base = { projectIdentity: 'hex-project:p', binaryIdentity: 'hex-binary:p:b:macho:arm64' };
const factKey = (entity, factKind) => entity + String.fromCharCode(0) + factKind;

function ops(entity, factKind, n) {
  return Array.from({ length: n }, (_, i) => createProjectOperation({
    ...base,
    operationId: `op:${entity}:${factKind}:${String(i).padStart(6, '0')}`,
    targetEntityId: entity,
    factKind,
    action: 'set',
    payload: `v${i}`,
  }));
}

function meaningfulEntries(log) {
  return log.state.conflicts.filter((entry) => entry.type === 'meaningful-conflict');
}

function retainedConflictIds(log) {
  return meaningfulEntries(log).reduce((total, entry) => total + (entry.operationIds?.length || 0), 0);
}

test('#8901 many competing values on one meaningful fact retain one bounded conflict entry (linear, not quadratic)', () => {
  const log = new ChangeLog(base);
  log.applyBatch(ops('entity', 'name', 800));

  const meaningful = meaningfulEntries(log);
  assert.equal(meaningful.length, 1, 'a single fact key must retain exactly one meaningful-conflict entry');
  // Linear (800), not the Theta(N^2) prefix-sum (sum_{k=2..800} k = 320399) the old append retained.
  assert.equal(retainedConflictIds(log), 800, 'retained IDs equal the current competing set, not its quadratic prefix-sum');

  // Contract preserved: the single entry still reports the full current competing set in ID order.
  const entry = meaningful[0];
  assert.equal(entry.key, factKey('entity', 'name'));
  assert.equal(entry.factKind, 'name');
  assert.deepEqual(entry.operationIds, log.state.facts[factKey('entity', 'name')].values.map((v) => v.operationId));
});

test('#8901 growth stays linear as more competing values arrive', () => {
  const samples = [200, 400, 800].map((n) => {
    const log = new ChangeLog(base);
    log.applyBatch(ops('entity', 'name', n));
    return { n, objects: meaningfulEntries(log).length, ids: retainedConflictIds(log) };
  });
  for (const { n, objects, ids } of samples) {
    assert.equal(objects, 1, `one meaningful-conflict object at N=${n}`);
    assert.equal(ids, n, `retained IDs equal N at N=${n}, not N(N-1)/2`);
  }
});

test('#8901 aggregate retention across distinct conflicting keys is bounded by the values themselves', () => {
  const log = new ChangeLog(base);
  log.applyBatch([
    ...ops('alpha', 'name', 5),
    ...ops('beta', 'type', 5),
    ...ops('gamma', 'struct', 5),
  ]);
  const meaningful = meaningfulEntries(log);
  assert.equal(meaningful.length, 3, 'one meaningful-conflict entry per conflicting fact key');
  assert.equal(retainedConflictIds(log), 15, 'total retained IDs equals the sum of competing values (Theta(N)), not a quadratic prefix-sum');
  assert.deepEqual(meaningful.map((entry) => entry.key).sort(), [
    factKey('alpha', 'name'), factKey('beta', 'type'), factKey('gamma', 'struct'),
  ].sort());
});

test('#8901 a two-value conflict still surfaces one meaningful-conflict with both IDs', () => {
  const log = new ChangeLog(base);
  assert.equal(log.applyOperation(ops('e', 'name', 1)[0]).status, 'applied');
  assert.equal(log.applyOperation(createProjectOperation({
    ...base, operationId: 'op:e:name:second', targetEntityId: 'e', factKind: 'name', action: 'set', payload: 'other',
  })).status, 'conflict');
  const meaningful = meaningfulEntries(log);
  assert.equal(meaningful.length, 1);
  assert.equal(meaningful[0].operationIds.length, 2);
});

test('#8901 a single non-competing value (or a non-meaningful fact) retains no meaningful conflict', () => {
  const solo = new ChangeLog(base);
  solo.applyOperation(ops('entity', 'name', 1)[0]);
  assert.equal(meaningfulEntries(solo).length, 0);

  const nonMeaningful = new ChangeLog(base);
  nonMeaningful.applyBatch(ops('entity', 'comment', 50));
  assert.equal(meaningfulEntries(nonMeaningful).length, 0);
});

test('#8901 idempotent duplicate values do not grow retained conflict IDs', () => {
  const log = new ChangeLog(base);
  const op = ops('entity', 'name', 1)[0];
  log.applyOperation(op);
  log.applyOperation(createProjectOperation({ ...op, operationId: 'op:duplicate', payload: 'v0' }));
  assert.equal(log.state.facts[factKey('entity', 'name')].values.length, 1);
  assert.equal(meaningfulEntries(log).length, 0);
});

test('#8901 snapshot materialization stays bounded for a large single-fact conflict', () => {
  const log = new ChangeLog(base);
  log.applyBatch(ops('entity', 'name', 1000));
  const cloned = structuredClone(log.snapshot().conflicts);
  const ids = cloned.reduce((total, entry) => total + (entry.operationIds?.length || 0), 0);
  assert.equal(ids, 1000, 'materialized snapshot must carry only the linear competing set, not the quadratic prefix-sum');
});
