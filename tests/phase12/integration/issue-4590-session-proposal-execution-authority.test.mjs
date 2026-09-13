import assert from 'node:assert/strict';
import test from 'node:test';
import { AIRuntime } from '../../../js/ai/runtime.js';
import { InvestigationSessionStore } from '../../../js/ai/session-core/index.js';

const BINARY = 'bin-4590-exact';

function memoryPersistence() {
  const rows = new Map();
  return {
    rows,
    async save(session) { rows.set(session.id, structuredClone(session)); },
    async load(id) { return rows.has(id) ? structuredClone(rows.get(id)) : null; },
    async delete(id) { rows.delete(id); },
  };
}

function deepValue(depth) {
  let value = { leaf: 'exact-leaf' };
  for (let index = 0; index < depth; index++) value = { index, next: value };
  return value;
}

test('#4590 reload preserves exact proposal execution authority beyond display limits', async () => {
  const persistence = memoryPersistence();
  const sessionStore = new InvestigationSessionStore({ persistence });
  const runtime = new AIRuntime({ context: { binaryId: BINARY }, sessionStore, planner: false });
  const session = await sessionStore.create({ id: 's-4590-exact', binaryId: BINARY });
  const stores = runtime.storesFor(session, BINARY);
  const evidence = stores.evidenceStore.ingestPlan({
    best: { address: 0x1000n },
    candidates: [{ address: 0x1000n, name: 'fn', score: 10, sources: ['src'], evidence: ['src-1'], verification: { verified: true } }],
  }).find((item) => item.status === 'verified');
  assert.ok(evidence?.id);

  const target = Object.fromEntries(Array.from({ length: 240 }, (_, index) => [`field_${index}`, `target_${index}`]));
  target.address = '0x1000';
  const before = deepValue(14);
  const after = Array.from({ length: 1205 }, (_, index) => ({ index, value: `after_${index}` }));
  const created = stores.proposalStore.create({
    id: 'p-4590-exact', kind: 'comment', target, before, after, evidenceIds: [evidence.id],
  });
  const beforeReload = stores.proposalStore.executionView(created.id);

  // The ordinary display view is deliberately bounded, proving this fixture
  // crosses all three jsonSafe limits that used to corrupt restore authority.
  const display = stores.proposalStore.all()[0];
  assert.equal(display.executionDisplayExact, false);
  assert.ok(Object.keys(display.target).length < Object.keys(target).length);
  assert.ok(display.after.length < after.length);
  let displayBefore = display.before;
  for (let index = 0; index < 12 && displayBefore && typeof displayBefore === 'object'; index++) displayBefore = displayBefore.next;
  assert.equal(displayBefore, '[truncated]');

  const updated = await sessionStore.update(session.id, {
    confirmedFindings: stores.evidenceStore.byStatus('verified'),
    proposedActions: stores.proposalStore.persistedActions(),
  });
  assert.equal(updated.proposedActions.length, 1);
  assert.equal(typeof updated.proposedActions[0].executionPayload, 'string');
  assert.equal(typeof persistence.rows.get(session.id).proposedActions[0].executionPayload, 'string');

  const reloadedStore = new InvestigationSessionStore({ persistence });
  const reloadedSession = await reloadedStore.get(session.id);
  const resumedRuntime = new AIRuntime({ context: { binaryId: BINARY }, sessionStore: reloadedStore, planner: false });
  const resumed = resumedRuntime.storesFor(reloadedSession, BINARY);
  assert.equal(resumed.proposalStore.has(created.id), true);
  const afterReload = resumed.proposalStore.executionView(created.id);
  assert.deepEqual(afterReload.target, beforeReload.target);
  assert.deepEqual(afterReload.before, beforeReload.before);
  assert.deepEqual(afterReload.after, beforeReload.after);

  const approval = resumed.proposalStore.approve(created.id);
  let applied = null;
  await resumed.proposalStore.apply(created.id, {
    approvalToken: approval.approvalToken,
    currentState: before,
    apply: async (proposal) => { applied = proposal; },
  });
  assert.deepEqual(applied.target, target);
  assert.deepEqual(applied.after, after);
});

test('#4590 exact restore rejects target/after authority tampering', async () => {
  const persistence = memoryPersistence();
  const sessionStore = new InvestigationSessionStore({ persistence });
  const runtime = new AIRuntime({ context: { binaryId: BINARY }, sessionStore, planner: false });
  const session = await sessionStore.create({ id: 's-4590-tamper', binaryId: BINARY });
  const stores = runtime.storesFor(session, BINARY);
  const evidence = stores.evidenceStore.ingestPlan({
    best: { address: 0x1000n },
    candidates: [{ address: 0x1000n, name: 'fn', score: 10, sources: ['src'], evidence: ['src-1'], verification: { verified: true } }],
  }).find((item) => item.status === 'verified');
  stores.proposalStore.create({ id: 'p-4590-tamper', kind: 'comment', target: { address: '0x1000' }, before: '', after: 'exact', evidenceIds: [evidence.id] });
  const persisted = stores.proposalStore.persistedActions()[0];
  const confirmedFindings = stores.evidenceStore.byStatus('verified');

  for (const mutate of [
    (row) => { row.targetRevision = '0'.repeat(row.targetRevision.length); },
    (row) => { row.afterRevision = '0'.repeat(row.afterRevision.length); },
    (row) => { row.executionPayload = row.executionPayload.replace('exact', 'wrong'); },
  ]) {
    const row = structuredClone(persisted);
    mutate(row);
    const candidate = { id: `candidate-${Math.random()}`, binaryId: BINARY, confirmedFindings, proposedActions: [row] };
    const candidateRuntime = new AIRuntime({ context: { binaryId: BINARY }, planner: false });
    assert.equal(candidateRuntime.storesFor(candidate, BINARY).proposalStore.has('p-4590-tamper'), false);
  }
});
