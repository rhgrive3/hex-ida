import test from 'node:test';
import assert from 'node:assert/strict';
import { AnalysisWorkStopped } from '../../js/core/budgets/scoped-work.js';
import { serializeScopedWorkerStop, throwIfScopedWorkerStopped } from '../../js/core/budgets/scoped-worker.js';
import { workFor } from './helpers.mjs';
const binding = { kind: 'flow-inputs', worldId: 'world', snapshotId: 'snap', binaryId: 'binary' };
function stop(t, status = 'budget-exhausted') {
  const child = workFor(t); child.charge('workUnits', 7); child.charge('nodes', 3);
  return serializeScopedWorkerStop(new AnalysisWorkStopped(status, 'worker-stop', child.cost()), binding);
}
for (const status of ['budget-exhausted', 'timeout', 'cancelled']) test(`worker preserves ${status} and debits counters before throwing`, t => {
  const parent = workFor(t), payload = structuredClone(stop(t, status));
  assert.throws(() => throwIfScopedWorkerStopped(parent, payload, binding), e => e instanceof AnalysisWorkStopped && e.status === status);
  assert.equal(parent.cost().used.workUnits, 7); assert.equal(parent.cost().used.nodes, 3);
  assert.equal(payload.exact, false); assert.equal(payload.pipeline, undefined);
});
test('ordinary error strings and forged error classes are not typed worker stops', t => {
  assert.equal(serializeScopedWorkerStop(new Error('budget-exhausted'), binding), null);
  assert.equal(serializeScopedWorkerStop({ name: 'AnalysisWorkStopped', status: 'timeout', cost: workFor(t).cost() }, binding), null);
});
for (const key of ['kind', 'worldId', 'snapshotId', 'binaryId']) test(`worker stop ${key} mismatch is rejected before any debit`, t => {
  const parent = workFor(t), payload = stop(t); payload[key] += '-other';
  assert.throws(() => throwIfScopedWorkerStopped(parent, payload, binding), /source-mismatch/);
  assert.equal(parent.cost().used.workUnits ?? 0, 0);
});
for (const [name, mutate] of [
  ['unknown status', v => { v.status = 'completed'; }], ['forged exact', v => { v.exact = true; }],
  ['partial analysis payload', v => { v.pipeline = {}; }], ['negative counter', v => { v.cost.used.nodes = -1; }],
  ['unknown resource', v => { v.cost.used.unbounded = 1; }], ['nonfinite elapsed', v => { v.cost.elapsedMs = Infinity; }],
]) test(`worker stop rejects ${name} before any debit`, t => {
  const parent = workFor(t), payload = structuredClone(stop(t)); mutate(payload);
  assert.throws(() => throwIfScopedWorkerStopped(parent, payload, binding));
  assert.equal(parent.cost().used.workUnits ?? 0, 0);
});
test('worker serializer requires all source keys and a cost capture', t => {
  assert.throws(() => serializeScopedWorkerStop(new AnalysisWorkStopped('timeout', 'expired'), binding), /cost-required/);
  assert.throws(() => serializeScopedWorkerStop(new AnalysisWorkStopped('timeout', 'expired', workFor(t).cost()), {}), /binding/);
});
test('parent resource limit wins over a successful-looking remote counter set', t => {
  const parent = workFor(t, { workUnits: 3 });
  assert.throws(() => throwIfScopedWorkerStopped(parent, stop(t, 'timeout'), binding), e => e instanceof AnalysisWorkStopped && e.status === 'budget-exhausted');
});
