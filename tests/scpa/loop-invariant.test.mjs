import test from 'node:test';
import assert from 'node:assert/strict';
import { checkScalarLoopInvariant, SCALAR_LOOP_SCHEMA, LOOP_OBSERVABLE_CONTRACT } from '../../js/core/evidence/loop-invariant.js';
import { queryLoopInvariant } from '../../js/analysis/query/semantic/loop-evidence.js';
import { ScopedAnalysisService } from '../../js/analysis/query/scoped-service.js';
import { fixture, workFor } from './helpers.mjs';
const iv = (lower, upper = lower) => ({ lower: String(lower), upper: String(upper) });
const model = (overrides = {}) => ({ schema: SCALAR_LOOP_SCHEMA, bits: 8, entry: iv(0), guard: iv(0, 9), step: '1', observableContract: LOOP_OBSERVABLE_CONTRACT, ...overrides });
const candidate = () => ({ invariant: iv(0, 10), postcondition: iv(10) });
const check = (t, m = model(), c = candidate()) => checkScalarLoopInvariant(m, c, { work: workFor(t) });

test('analytic induction and ranking establish all iterations of the explicit scalar model', t => {
  const r = check(t); assert.equal(r.status, 'verified-model'); assert.equal(r.termination, 'verified-model');
  assert.equal(r.ranking.maximumIterations, '10'); assert.equal(r.exact, false); assert.equal(r.semanticProof, false);
  assert.equal(r.wholeFunctionProof, false); assert.equal(r.rewriteAuthorized, false); assert.ok(Object.isFrozen(r.obligations));
});
test('64-bit induction is exact above Number precision without unrolling', t => {
  const n = (1n << 63n) + 123n;
  const r = check(t, model({ bits: 64, entry: iv(n), guard: iv(n, n + 99n) }), { invariant: iv(n, n + 100n), postcondition: iv(n + 100n) });
  assert.equal(r.status, 'verified-model'); assert.equal(r.ranking.maximumIterations, '100');
});
test('negative increments obtain a descending ranking under the same unsigned model', t => {
  const r = check(t, model({ entry: iv(10), guard: iv(1, 10), step: '-1' }), { invariant: iv(0, 10), postcondition: iv(0) });
  assert.equal(r.status, 'verified-model'); assert.equal(r.ranking.kind, 'value-minus-guard-lower-plus-one');
});
for (const [obligation, m, c] of [
  ['initiation', model({ entry: iv(11) }), candidate()],
  ['preservation', model(), { invariant: iv(0, 9), postcondition: iv(10) }],
  ['postcondition', model(), { invariant: iv(0, 10), postcondition: iv(9) }],
]) test(`reports first ${obligation} failure without fabricating an executable witness`, t => {
  const r = check(t, m, c); assert.equal(r.status, 'rejected'); assert.equal(r.firstFailure.obligation, obligation);
  assert.match(r.witnessDomain, /reachability-not-established/); assert.equal(r.termination, 'unknown');
});
test('modular wrap can preserve an invariant but cannot borrow a non-wrapping termination proof', t => {
  const r = check(t, model({ entry: iv(250), guard: iv(0, 255), step: '10' }), { invariant: iv(0, 255), postcondition: iv(0, 255) });
  assert.equal(r.status, 'verified-model'); assert.equal(r.termination, 'unknown'); assert.equal(r.ranking, null);
  assert.equal(r.image.length, 2); assert.deepEqual(r.exit, []);
});
test('zero step is nonterminating-unknown rather than declared terminating by a bounded run', t => {
  assert.equal(check(t, model({ step: '0' })).termination, 'unknown');
});
test('an entry outside the guard has an explicit zero-iteration ranking', t => {
  const r = check(t, model({ entry: iv(10) }), { invariant: iv(10), postcondition: iv(10) });
  assert.equal(r.status, 'verified-model'); assert.equal(r.ranking.kind, 'zero-iterations-on-invariant');
});
for (const [name, mutate] of Object.entries({
  width: m => { m.bits = 65; }, wrapWidth: m => { m.entry.upper = '256'; }, negativeZero: m => { m.step = '-0'; },
  numericString: m => { m.step = 1; }, extraEffect: m => { m.memory = []; },
  reversed: m => { m.guard = iv(10, 9); }, unboundedStep: m => { m.step = '256'; },
  schema: m => { m.schema = 'trusted'; }, observable: m => { m.observableContract = 'all-machine-state'; },
})) test(`loop model rejects malformed ${name}`, t => { const m = model(); mutate(m); assert.throws(() => check(t, m)); });
test('accessors and cyclic candidate structures do not reach the checker', t => {
  let hits = 0; const m = model(); Object.defineProperty(m, 'step', { enumerable: true, get() { hits++; return '1'; } });
  assert.throws(() => check(t, m)); assert.equal(hits, 0);
  const c = candidate(); c.invariant = c; assert.throws(() => check(t, model(), c));
});
test('analytic intervals agree with exhaustive state enumeration for 1500 deterministic small-width models', t => {
  const work = workFor(t, { workUnits: 200000 }); let seed = 3101;
  const rand = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  for (let i = 0; i < 1500; i++) {
    const bits = 1 + rand(6), size = 2 ** bits, range = () => { const a = rand(size), b = rand(size); return iv(Math.min(a, b), Math.max(a, b)); };
    const m = model({ bits, entry: range(), guard: range(), step: String(rand(size * 2 - 1) - size + 1) });
    const c = { invariant: range(), postcondition: range() }, r = checkScalarLoopInvariant(m, c, { work });
    const inRange = (v, a) => v >= Number(a.lower) && v <= Number(a.upper);
    const initiation = Array.from({ length: size }, (_, x) => x).every(x => !inRange(x, m.entry) || inRange(x, c.invariant));
    const preservation = Array.from({ length: size }, (_, x) => x).every(x => !inRange(x, c.invariant) || !inRange(x, m.guard)
      || inRange(((x + Number(m.step)) % size + size) % size, c.invariant));
    const postcondition = Array.from({ length: size }, (_, x) => x).every(x => !inRange(x, c.invariant) || inRange(x, m.guard) || inRange(x, c.postcondition));
    assert.deepEqual(r.obligations, { initiation, preservation, postcondition }, `model ${i}`);
    if (r.termination === 'verified-model') for (let x = Number(c.invariant.lower); x <= Number(c.invariant.upper); x++) {
      const seen = new Set(); let y = x;
      while (inRange(y, m.guard)) { assert.ok(!seen.has(y), `false termination at ${i}`); seen.add(y); y = ((y + Number(m.step)) % size + size) % size; }
    }
  }
});
test('loop checker observes cancellation and zero work budgets', t => {
  assert.throws(() => checkScalarLoopInvariant(model(), candidate(), { work: workFor(t, { workUnits: 0 }) }), e => e.code === 'budget-exhausted');
  const work = workFor(t); work.dispose(); assert.throws(() => checkScalarLoopInvariant(model(), candidate(), { work }), e => e.code === 'cancelled');
});
function hostContext(f) { return { isCurrent: () => true, model: model(), binding: { worldId: f.world.id, assumptionsId: f.assumptions.id,
  snapshotId: 'snap', functionLocator: '0x1000', loopId: 'loop-a', modelRevision: 'model-v1', artifactId: 'artifact-a', sourceReferences: ['cfg-header-a'] } }; }
test('actual scoped service wires a current loop owner, while proof remains conditional on the model', async t => {
  const f = fixture(); const context = hostContext(f); let loads = 0;
  const host = { configuration: { maximumSessions: 2, sessionTtlMs: 10000, getLoopModelContext: async () => context },
    canonicalArchitecture: 'arm64', isCurrent: () => true, loadPipeline: async () => { loads++; return {}; } };
  const service = new ScopedAnalysisService({ host, snapshot: { snapshotId: 'snap' }, worldInput: f.world }); t.after(() => service.close());
  const r = await service.invoke('checkLoopInvariant', { functionId: '0x1000', loopId: 'loop-a', ...candidate() });
  assert.equal(r.value.checked.status, 'verified-model'); assert.equal(r.value.semanticClosure, 'unknown'); assert.equal(loads, 0);
});
for (const key of ['worldId', 'assumptionsId', 'snapshotId', 'functionLocator', 'loopId']) test(`loop owner rejects stale ${key}`, async t => {
  const f = fixture(), context = hostContext(f); context.binding[key] = 'stale';
  await assert.rejects(() => queryLoopInvariant({ functionId: '0x1000', loopId: 'loop-a', ...candidate() }, {
    ...f, snapshotId: 'snap', work: workFor(t), isCurrent: () => true, getContext: async () => context }), /loop-owner-binding/);
});
test('loop route is unsupported without owner and cannot accept a query-injected model', async t => {
  const f = fixture(), opts = { ...f, work: workFor(t), snapshotId: 'snap', isCurrent: () => true };
  const q = { functionId: '0x1000', loopId: 'loop-a', ...candidate() };
  assert.equal((await queryLoopInvariant(q, opts)).status, 'unsupported');
  await assert.rejects(() => queryLoopInvariant({ ...q, model: model() }, opts), /loop-query-fields/);
});
test('owner retirement while awaiting a model blocks publication', async t => {
  const f = fixture(), context = hostContext(f); context.isCurrent = () => false;
  await assert.rejects(() => queryLoopInvariant({ functionId: '0x1000', loopId: 'loop-a', ...candidate() }, {
    ...f, work: workFor(t), snapshotId: 'snap', isCurrent: () => true, getContext: async () => context }), /loop-model-owner-stale/);
});

test('loop checker charges its bounded model and candidate to the parent memory budget', t => {
  assert.throws(() => checkScalarLoopInvariant(model(), candidate(), { work: workFor(t, { residentBytes: 8 }) }), e => e.code === 'budget-exhausted');
});
