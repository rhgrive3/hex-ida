import test from 'node:test';
import assert from 'node:assert/strict';
import { DependencyEpochRegistry, normalizeDependencyScope } from '../../js/core/artifacts/dependencies.js';
import { ScopedAnalysisWork, normalizeQueryLimits, workStopStatus } from '../../js/core/budgets/scoped-work.js';
import { ResourceBudget } from '../../js/core/budgets/index.js';
import { fixture, selector, workFor } from './helpers.mjs';
for (const polarity of ['positive-membership', 'negative-membership', 'complete-membership']) test(`${polarity} invalidates on late target, not unrelated partition`, () => {
  const r = new DependencyEpochRegistry({ world: fixture().world, nonce: 'r1' });
  const token = r.capture([{ selector: selector('a'), polarity }]); assert.ok(r.validate(token));
  r.advance([selector('b')]); assert.ok(r.validate(token)); r.advance([selector('a')]); assert.equal(r.validate(token), false); r.close();
});
test('snapshot-only token invalidates on every membership change', () => {
  const r = new DependencyEpochRegistry({ world: fixture().world }); const token = r.capture([], { snapshotOnly: true }); r.advance([selector()]); assert.equal(r.validate(token), false); r.close();
});
test('reset/close/restart permanently invalidate serialized dependency tokens', () => {
  const world = fixture().world, r = new DependencyEpochRegistry({ world, nonce: 'first' }); const token = r.capture([]);
  const persisted = JSON.parse(JSON.stringify(token)); assert.ok(r.validate(persisted)); r.reset(); assert.equal(r.validate(persisted), false);
  const next = r.capture([]); r.close(); assert.equal(r.validate(next), false); assert.throws(() => r.capture([]), /closed/);
  assert.equal(new DependencyEpochRegistry({ world, nonce: 'other' }).validate(token), false);
});
test('invalidation is synchronous and one throwing callback cannot suppress other watchers', () => {
  const r = new DependencyEpochRegistry({ world: fixture().world }); const token = r.capture([{ selector: selector(), polarity: 'negative-membership' }]); let called = 0;
  r.watch(token, () => { assert.equal(r.validate(token), false); throw new Error('consumer'); }); r.watch(token, () => called++);
  r.advance([selector()]); assert.equal(called, 1); assert.equal(r.stats().watchers, 0); r.advance([selector()]); assert.equal(called, 1); r.close();
});
test('unsubscribe cleans reverse index and subscription budget recovers', () => {
  const r = new DependencyEpochRegistry({ world: fixture().world, maxWatchers: 1 }); const token = r.capture([{ selector: selector(), polarity: 'positive-membership' }]); let called = 0;
  const stop = r.watch(token, () => called++); assert.throws(() => r.watch(token, () => {}), /watch-budget/); stop(); stop();
  r.watch(token, () => called++); r.close(); assert.equal(called, 1); assert.equal(r.stats().watchers, 0);
});
test('selector capacity overflow resets all absence reads conservatively', () => {
  const r = new DependencyEpochRegistry({ world: fixture().world, maxSelectors: 1 }); r.advance([selector('a')]); const t = r.capture([{ selector: selector('a'), polarity: 'negative-membership' }]);
  assert.equal(r.advance([selector('b')]).status, 'global-invalidation'); assert.equal(r.validate(t), false); r.close();
});
test('malformed epochs, duplicate selectors, or foreign worlds never validate', () => {
  const r = new DependencyEpochRegistry({ world: fixture().world }); const read = { selector: selector(), polarity: 'negative-membership' }; const t = r.capture([read]);
  assert.throws(() => r.capture([read, read]), /duplicate/);
  for (const bad of [{ ...t, worldId: 'foreign' }, { ...t, globalEpoch: -1 }, { ...t, resetEpoch: '0' }, { ...t, reads: [{ ...t.reads[0], epoch: -0 }] }]) assert.equal(r.validate(bad), false);
  assert.deepEqual(normalizeDependencyScope(JSON.parse(JSON.stringify(t))), t); r.close();
});
test('dependency randomized partition changes match an independent epoch model', () => {
  const r = new DependencyEpochRegistry({ world: fixture().world }); const epochs = Array(7).fill(0), tokens = []; let seed = 9173;
  for (let i = 0; i < 120; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; const p = seed % 7;
    if (i % 3) { r.advance([selector(String(p))]); epochs[p]++; } else tokens.push({ token: r.capture([{ selector: selector(String(p)), polarity: 'negative-membership' }]), p, epoch: epochs[p] });
    for (const t of tokens) assert.equal(r.validate(t.token), epochs[t.p] === t.epoch);
  } r.close();
});
for (const name of ['workUnits', 'calls', 'nodes', 'results', 'residentBytes']) test(`resource ${name} hard cap is enforced`, t => {
  const work = workFor(t, { [name]: 1 }); work.charge(name, 1); assert.equal(work.remaining(name), 0); assert.throws(() => work.charge(name, 1), e => workStopStatus(e) === 'budget-exhausted');
});
for (const value of [-1, -0, 0.5, '5', Infinity, null]) test(`query limit rejects invalid value ${String(value)} (${Object.is(value, -0) ? '-zero' : typeof value})`, () => assert.throws(() => normalizeQueryLimits({ calls: value })));
test('unknown resource, invalid yield and excessive deadlines are rejected', () => {
  for (const limits of [{ extra: 1 }, { yieldEvery: 0 }, { deadlineMs: 120001 }]) assert.throws(() => normalizeQueryLimits(limits));
});
test('zero deadline and disposed work stop before provider execution', async () => {
  let called = false; const work = new ScopedAnalysisWork({ limits: { deadlineMs: 0 } });
  await assert.rejects(work.await(() => { called = true; }), e => e.status === 'timeout'); work.dispose(); assert.equal(called, false);
  assert.throws(() => work.checkpoint(), e => e.status === 'cancelled');
});
test('hanging provider is interrupted by deadline and late rejection is handled', async () => {
  const work = new ScopedAnalysisWork({ limits: { deadlineMs: 20 } }); let reject;
  await assert.rejects(work.await(() => new Promise((_, r) => { reject = r; })), e => e.status === 'timeout');
  reject(new Error('late provider')); await new Promise(r => setTimeout(r, 0)); work.dispose();
});
test('external abort and parent abort propagate to active awaits', async () => {
  const controller = new AbortController(); const work = new ScopedAnalysisWork({ signal: controller.signal });
  const pending = work.await(() => new Promise(() => {})); controller.abort(); await assert.rejects(pending, e => e.status === 'cancelled'); work.dispose();
});
test('parent accounting survives child disposal and release removes child registration', () => {
  const parent = new ResourceBudget({ workUnits: 3 });
  const a = new ScopedAnalysisWork({ parentBudget: parent }); a.charge('workUnits', 2); a.dispose(); assert.equal(parent.children.size, 0);
  const b = new ScopedAnalysisWork({ parentBudget: parent }); b.charge('workUnits', 1); assert.throws(() => b.charge('workUnits', 1), e => e.status === 'budget-exhausted'); b.dispose();
});
test('cooperative yield permits a queued cancellation macrotask', async t => {
  const work = workFor(t, { yieldEvery: 1 }); let tick = false; setTimeout(() => { tick = true; }, 0); work.charge(); await work.yieldIfNeeded(); assert.ok(tick);
});
