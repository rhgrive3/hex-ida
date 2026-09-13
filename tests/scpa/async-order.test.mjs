import test from 'node:test';
import assert from 'node:assert/strict';
import { checkAsyncEventOrder, queryAsyncEventOrder, ASYNC_EVENT_SCHEMA } from '../../js/analysis/apple/scoped-async.js';
import { fixture, workFor } from './helpers.mjs';
import { ScopedAnalysisService } from '../../js/analysis/query/scoped-service.js';
const ev = (id, sequence, kind = 'other', overrides = {}) => ({ id, kind, strandId: 'strand-a', sequence,
  taskId: 'task-a', actorId: 'actor-a', executorId: 'executor-a', sourceReferences: [`source-${id}`], ...overrides });
const contract = (id = 'seq', rule = 'sequenced-before') => ({ id, version: '1.0.0', rule, sourceReferences: ['library-rule-a'] });
const edge = (from, to, contractId = 'seq', extra = {}) => ({ id: `${from}-${to}`, from, to, contractId,
  contractVersion: '1.0.0', sourceReferences: [`edge-${from}-${to}`], ...extra });
const source = (overrides = {}) => ({ schema: ASYNC_EVENT_SCHEMA, events: [ev('a', 0), ev('b', 1), ev('c', 2)],
  relations: [edge('a', 'b'), edge('b', 'c')], contracts: [contract()], remaining: [], ...overrides });
const query = { fromEventId: 'a', toEventId: 'c' };
const run = (t, s = source(), q = query) => checkAsyncEventOrder(s, q, { work: workFor(t) });

test('bounded transitive order carries versioned edge witnesses and never static authority', async t => {
  const r = await run(t); assert.equal(r.relation, 'before-in-model'); assert.deepEqual(r.witness.nodes, ['a', 'b', 'c']);
  assert.ok(r.witness.edges.every(e => e.contractVersion === '1.0.0')); assert.equal(r.staticHappensBeforeProven, false);
  assert.equal(r.exact, false); assert.equal(r.runtimeExecutionRequested, false); assert.equal(r.canonicalTruthChanged, false);
});
test('reverse and identity queries preserve strict order semantics', async t => {
  assert.equal((await run(t, source(), { fromEventId: 'c', toEventId: 'a' })).relation, 'after-in-model');
  assert.equal((await run(t, source(), { fromEventId: 'a', toEventId: 'a' })).relation, 'same-event');
});
test('same actor/executor/sequence metadata without an explicit relation does not establish order', async t => {
  const r = await run(t, source({ relations: [] })); assert.equal(r.relation, 'unknown'); assert.equal(r.witness, null);
});
for (const [rule, fromKind, toKind] of [['task-spawn', 'spawn', 'task-start'], ['task-join', 'task-end', 'join'],
  ['continuation-resume', 'resume', 'continuation-start'], ['queue-delivery', 'enqueue', 'dequeue']]) {
  test(`${rule} requires a versioned contract plus the same one-use token generation`, async t => {
    const same = { token: 'token-a', objectId: 'object-a', objectGeneration: '3' };
    const s = source({ events: [ev('a', 0, fromKind, same), ev('c', 0, toKind, { ...same, strandId: 'strand-b' })],
      relations: [edge('a', 'c', 'rule')], contracts: [contract('rule', rule)] });
    assert.equal((await run(t, s)).relation, 'before-in-model');
    s.events[1].objectGeneration = '4'; assert.equal((await run(t, s)).relation, 'unknown');
  });
}
for (const [name, mutate, reason] of [
  ['version', s => { s.contracts[0].version = '2.0.0'; }, 'library-contract-version-unbound'],
  ['missing-contract', s => { s.contracts = []; }, 'library-contract-version-unbound'],
  ['sequence-order', s => { s.events[0].sequence = 5; }, 'event-rule-premises-unproved'],
  ['foreign-strand', s => { s.events[0].strandId = 'elsewhere'; }, 'event-rule-premises-unproved'],
  ['duplicate-sequence', s => { s.events[0].sequence = 1; }, 'ambiguous-strand-sequence'],
  ['unknown-rule', s => { s.contracts[0].rule = 'trust-timestamp'; }, 'event-rule-premises-unproved'],
  ['missing-event', s => { s.events = s.events.filter(e => e.id !== 'b'); }, 'event-outside-selected-scope'],
]) test(`order remains unknown for ${name}`, async t => {
  const s = source(); mutate(s); const r = await run(t, s); assert.equal(r.relation, 'unknown');
  assert.ok(r.remaining.some(v => v.includes(reason))); assert.ok(r.counts.rejectedEdges > 0);
});
test('multiple one-use token partners remain ambiguous instead of first-match selection', async t => {
  const scope = { token: 'k', objectId: 'continuation', objectGeneration: '1' };
  const s = source({ events: [ev('a', 0, 'resume', scope), ev('other', 1, 'resume', scope), ev('c', 0, 'continuation-start', { ...scope, strandId: 'different' })],
    relations: [edge('a', 'c', 'resume')], contracts: [contract('resume', 'continuation-resume')] });
  const r = await run(t, s); assert.equal(r.relation, 'unknown'); assert.ok(r.remaining.some(v => v.includes('ambiguous-one-use-token')));
});
test('a cycle outside the queried path still blocks every order claim', async t => {
  const scope = { token: 'k', objectId: 'queue-message', objectGeneration: '1' };
  const s = source(); s.events.push(ev('x', 4, 'enqueue', scope), ev('y', 3, 'dequeue', scope));
  s.contracts.push(contract('queue', 'queue-delivery')); s.relations.push(edge('x', 'y', 'queue'), edge('y', 'x'));
  const r = await run(t, s); assert.equal(r.consistent, false); assert.equal(r.relation, 'unknown'); assert.equal(r.witness, null);
  assert.ok(r.remaining.includes('event-order-cycle'));
});
test('depth limits are explicit and never interpreted as absence of happens-before', async t => {
  const r = await run(t, source(), { ...query, maximumDepth: 1 }); assert.equal(r.relation, 'unknown'); assert.ok(r.remaining.includes('query-depth-cut'));
});
test('captured lifetime boundaries retain instance generations and do not prove lifetime safety', async t => {
  const scope = { objectId: 'allocation', objectGeneration: '8' };
  const s = source({ events: [ev('a', 0, 'allocate', scope), ev('b', 1, 'use', scope), ev('c', 2, 'dispose', scope)] });
  const q = { ...query, lifetime: { ...scope, useEventId: 'b' } }, r = await run(t, s, q);
  assert.equal(r.lifetime.relation, 'between-captured-boundaries-in-model'); assert.equal(r.lifetime.lifetimeProven, false);
  s.events[2].objectGeneration = '9'; assert.equal((await run(t, s, q)).lifetime.relation, 'unknown');
});
test('an observed end-before-use relation stays a model ordering, not a static executable finding', async t => {
  const scope = { objectId: 'allocation', objectGeneration: '8' };
  const s = source({ events: [ev('a', 0, 'allocate', scope), ev('b', 1, 'dispose', scope), ev('c', 2, 'use', scope)] });
  const r = await run(t, s, { ...query, lifetime: { ...scope, useEventId: 'c' } });
  assert.equal(r.lifetime.relation, 'after-captured-end-in-model'); assert.equal(r.semanticProof, false);
});
for (const [name, mutate] of Object.entries({ duplicateEvent: s => s.events.push(s.events[0]),
  duplicateRelation: s => s.relations.push(s.relations[0]), duplicateContract: s => s.contracts.push(s.contracts[0]),
  missingSource: s => { s.events[0].sourceReferences = []; }, numericGeneration: s => { s.events[0].objectGeneration = 1; },
  invalidSequence: s => { s.events[0].sequence = -1; }, hiddenTimestamp: s => { s.events[0].time = 2; },
  oversizedEvents: s => { s.events = Array(513).fill(s.events[0]); } })) {
  test(`malformed ${name} cannot become an order proof`, async t => { const s = source(); mutate(s); await assert.rejects(() => run(t, s)); });
}
test('event graph obeys cancellation and cooperative work limits', async t => {
  await assert.rejects(() => checkAsyncEventOrder(source(), query, { work: workFor(t, { workUnits: 0 }) }), e => e.code === 'budget-exhausted');
  const work = workFor(t); work.dispose(); await assert.rejects(() => checkAsyncEventOrder(source(), query, { work }), e => e.code === 'cancelled');
});
const bound = f => ({ isCurrent: () => true, source: source(), binding: { worldId: f.world.id, assumptionsId: f.assumptions.id,
  snapshotId: 'snap', runtimeSessionId: 'runtime-a', epoch: 2, moduleGeneration: 'module-2', ownerRevision: 'events-v1' } });
test('current async owner is wired into the scoped service without invoking execution', async t => {
  const f = fixture(), context = bound(f); let loaded = 0;
  const host = { configuration: { maximumSessions: 2, sessionTtlMs: 10000, getAsyncEventContext: async () => context },
    isCurrent: () => true, loadPipeline: async () => { loaded++; return {}; } };
  const service = new ScopedAnalysisService({ host, snapshot: { snapshotId: 'snap' }, worldInput: f.world }); t.after(() => service.close());
  const r = (await service.invoke('asyncEventOrder', { ...query, runtimeSessionId: 'runtime-a' })).value;
  assert.equal(r.relation, 'before-in-model'); assert.equal(r.binding.epoch, 2); assert.equal(r.releaseQualified, false); assert.equal(loaded, 0);
});
for (const key of ['worldId', 'assumptionsId', 'snapshotId', 'runtimeSessionId']) test(`async context rejects foreign ${key}`, async t => {
  const f = fixture(), context = bound(f); context.binding[key] = 'foreign';
  await assert.rejects(() => queryAsyncEventOrder({ ...query, runtimeSessionId: 'runtime-a' }, {
    ...f, snapshotId: 'snap', work: workFor(t), getContext: async () => context, isCurrent: () => true }), /async-owner-binding/);
});
test('source retirement during cooperative graph work prevents late publication', async t => {
  const f = fixture(), context = bound(f); let current = true; context.isCurrent = () => current;
  const work = workFor(t, { yieldEvery: 1 });
  setTimeout(() => { current = false; }, 0);
  await assert.rejects(() => queryAsyncEventOrder({ ...query, runtimeSessionId: 'runtime-a' }, {
    ...f, snapshotId: 'snap', work, getContext: async () => context, isCurrent: () => true }), /async-owner-stale/);
});
test('query cannot inject events/contracts; absent owner stays unsupported', async t => {
  const f = fixture(), opts = { ...f, snapshotId: 'snap', work: workFor(t), isCurrent: () => true };
  assert.equal((await queryAsyncEventOrder({ ...query, runtimeSessionId: 'runtime-a' }, opts)).status, 'unsupported');
  await assert.rejects(() => queryAsyncEventOrder({ ...query, runtimeSessionId: 'runtime-a', source: source() }, opts), /async-query-fields/);
});
