// Adapter/receipt doubles verify orchestration, not a real same-model trial.
import test from 'node:test';
import assert from 'node:assert/strict';
import { protocolInput, H } from './benchmark-fixture.mjs';
import { workFor } from './helpers.mjs';
import { createCompetitiveProtocol } from '../../js/analysis/benchmark/competitive-protocol.js';
import { createAstraTrialPlan, runAstraTrials } from '../../js/analysis/benchmark/scoped-trials.js';
import { ScopedNativeBestAdapter } from '../../js/analysis/benchmark/scoped-native-adapter.js';
import { nativeWorkerFixture } from './native-worker-fixture.mjs';
import { trialFixture as fixture, trialHosts as hosts } from './trial-fixture.mjs';
test('all four modes keep full denominator and deterministic seeded order', () => {
  const f = fixture({ cacheStates: ['cold', 'warm'] }); assert.equal(f.plan.denominator, 48);
  assert.deepEqual(createAstraTrialPlan(f.protocols, f.config), f.plan);
  assert.notDeepEqual(createAstraTrialPlan(f.protocols, { ...f.config, seed: 72 }).trials.map(x => x.participantId), f.plan.trials.map(x => x.participantId));
  for (const mode of ['T0','T1','T2','T3']) assert.equal(f.plan.trials.filter(x => x.mode === mode).length, 12);
  assert.equal(f.plan.minimumFiveRepetitions, false); assert.equal(f.plan.preregistrationVerified, false);
});
for (const [label, change] of [
  ['missing track', p => delete p.T2], ['wrong native track', p => p.T0 = p.T1],
  ['changed binary', p => { const raw = protocolInput(); raw.cases[0].binarySha256 = 'c'.repeat(64); p.T1 = createCompetitiveProtocol(raw); }],
  ['model changed between tracks', p => { const raw = protocolInput(); raw.participants.forEach(x => x.astra.modelRevision = 'changed'); p.T3 = createCompetitiveProtocol(raw); }],
]) test(`rejects ${label} before executing`, () => { const f = fixture(), protocols = { ...f.protocols }; change(protocols); assert.throws(() => createAstraTrialPlan(protocols, f.config)); });
test('omitted tasks, invented cases, invalid seeds, unbounded budgets and wire-plan spoofing fail closed', async t => {
  const f = fixture();
  for (const change of [c => c.tasks.pop(), c => c.tasks[0].caseId = 'not-a-case', c => c.seed = 0, c => c.resources.deadlineMs = Infinity, c => c.cacheStates = []]) {
    const config = structuredClone(f.config); change(config); assert.throws(() => createAstraTrialPlan(f.protocols, config));
  }
  await assert.rejects(runAstraTrials(structuredClone(f.plan), f.protocols, { work: workFor(t) }), /owned-plan/);
});
test('missing adapter does not turn absent competitors into zero measurements or reduce denominator', async t => {
  const f = fixture(), result = await runAstraTrials(f.plan, f.protocols, { work: workFor(t) });
  assert.equal(result.denominator, 24); assert.equal(result.trials.length, 24); assert.ok(result.trials.every(x => x.state === 'UNAVAILABLE'));
  assert.equal(result.measurements.length, 0); assert.equal(result.victoryEstablished, false);
});
test('completed mock adapters remain unadjudicated and preserve per-mode model/knowledge budgets', async t => {
  const f = fixture(), h = hosts(f), result = await runAstraTrials(f.plan, f.protocols, { ...h, work: workFor(t, { calls: 256 }) });
  assert.equal(h.stats().queries, 24); assert.equal(h.stats().closes, 24); assert.equal(h.stats().cancels, 24);
  assert.ok(result.trials.every(x => x.executionState === 'executed-unadjudicated' && x.state === 'UNMEASURED'));
  assert.ok(result.trials.filter(x => x.mode === 'T0').every(x => x.preparation.limits.modelTokens === 0 && x.observed.modelTokens === 0));
  assert.ok(result.trials.filter(x => x.mode !== 'T0').every(x => x.observed.modelTokens === null));
  assert.equal(result.releaseQualified, false); assert.equal(result.minimumRepetitionsExecuted, false);
});
for (const [label, mutate] of [
  ['wrong binary', p => p.binding = { ...p.binding, binarySha256: 'f'.repeat(64) }],
  ['cache policy mismatch', p => p.cachePolicySha256 = 'f'.repeat(64)],
  ['cache temperature mismatch', p => p.cacheState = 'warm'],
  ['scope-budget escape', p => p.limits = { ...p.limits, modelTokens: 99 }],
  ['no cancellation', p => p.cancellationSupported = false],
  ['model in T0', p => p.modelCallsDisabled = false],
]) test(`preparation rejects ${label} without a query`, async t => {
  const f = fixture(), h = hosts(f, context => { const prepare = context.prepare; context.prepare = async () => { const p = await prepare(); mutate(p); return p; }; });
  const result = await runAstraTrials(f.plan, f.protocols, { ...h, work: workFor(t), maximumTrials: 1 });
  assert.equal(result.trials[0].state, 'FAILED'); assert.equal(h.stats().queries, 0); assert.equal(h.stats().closes, 1);
});
test('provider drift after await retires result instead of keeping a successful row', async t => {
  const f = fixture(), h = hosts(f, context => { context.adapter.query = async () => { context.stale(); return { mode: 'T0-model-free' }; }; });
  const result = await runAstraTrials(f.plan, f.protocols, { ...h, work: workFor(t), maximumTrials: 1 });
  assert.match(result.trials[0].reason, /stale/); assert.equal(result.measurements.length, 0);
});
test('hung adapter and hung cleanup are finite, later cells stay in denominator', async t => {
  const f = fixture({ resources: { deadlineMs: 15, cleanupMs: 10 } }), h = hosts(f, context => {
    context.adapter.query = () => new Promise(() => {}); context.adapter.cancel = () => new Promise(() => {});
  });
  const result = await runAstraTrials(f.plan, f.protocols, { ...h, work: workFor(t), maximumTrials: 1 });
  assert.equal(result.trials[0].reason, 'timeout'); assert.equal(result.trials[0].cleanup.status, 'unconfirmed');
  assert.equal(result.trials.length, 24); assert.ok(result.trials.slice(1).every(x => x.reason === 'per-invocation-trial-cap'));
});
test('parent cancellation forbids late publication and stops other provider calls', async t => {
  const f = fixture(), work = workFor(t), h = hosts(f, context => { context.adapter.query = async () => { work.dispose(); return { mode: 'T0-model-free' }; }; });
  const result = await runAstraTrials(f.plan, f.protocols, { ...h, work });
  assert.equal(result.trials[0].state, 'FAILED'); assert.ok(result.stopped); assert.equal(h.stats().closes, 1);
});
test('common-information mismatch invalidates the entire paired control rather than only later participant', async t => {
  const f = fixture(); let n = 0;
  const h = hosts(f, (context, trial) => { if (trial.mode === 'T2') { const prepare = context.prepare; context.prepare = async () => {
    const p = await prepare(); if (n++ % 3 === 1) p.knowledge.manifestSha256 = 'f'.repeat(64); return p;
  }; } });
  const result = await runAstraTrials(f.plan, f.protocols, { ...h, work: workFor(t, { calls: 256 }) });
  assert.ok(result.trials.filter(x => x.mode === 'T2').every(x => x.state === 'FAILED' && x.reason === 'paired-common-information-control-mismatch'));
  assert.equal(result.trials.filter(x => x.mode === 'T1' && x.executionState === 'executed-unadjudicated').length, 6);
});
test('namespaces are never reused across learning/knowledge trials', async t => {
  const f = fixture(), h = hosts(f, context => { const prepare = context.prepare; context.prepare = async () => ({ ...await prepare(), namespaceId: 'reused' }); });
  const result = await runAstraTrials(f.plan, f.protocols, { ...h, work: workFor(t), maximumTrials: 3 });
  assert.equal(result.trials[0].executionState, 'executed-unadjudicated'); assert.match(result.trials[1].reason, /namespace-reuse/);
});
test('real native-best adapter executes existing canonical worker handler in T0; fixture is not a competitor trial', async t => {
  const native = await nativeWorkerFixture(t), f = fixture({ resources: { deadlineMs: 10000, cleanupMs: 1000 } });
  const h = hosts(f, (context, trial) => { context.adapter = new ScopedNativeBestAdapter(native.service,
    { caseId: trial.caseId, snapshotId: 'snap', worldId: native.world.id, baselineCommit: 'a'.repeat(40) }); });
  const result = await runAstraTrials(f.plan, f.protocols, { ...h, work: workFor(t, { deadlineMs: 20000 }), maximumTrials: 1 });
  assert.equal(result.trials[0].executionState, 'executed-unadjudicated', JSON.stringify(result.trials[0]));
  assert.ok(native.counters.workers > 0); assert.equal(result.trials[0].correctness, 'UNMEASURED');
});

test('cleanup failure invalidates previously executed candidate measurements',async t=>{
  const f=fixture(),h=hosts(f,c=>{c.close=async()=>{throw Error('cleanup-failed');};});
  const result=await runAstraTrials(f.plan,f.protocols,{...h,work:workFor(t),maximumTrials:1});
  assert.equal(result.trials[0].executionState,'invalidated-cleanup');assert.equal(result.trials[0].state,'FAILED');assert.deepEqual(result.measurements,[]);
});
test('actual runner call counter is retained without asserting model token counts',async t=>{
  const f=fixture(),h=hosts(f);const result=await runAstraTrials(f.plan,f.protocols,{...h,work:workFor(t),maximumTrials:1});
  assert.ok(result.trials[0].observed.runnerCalls>=3);assert.equal(result.trials[0].observed.modelTokens,0);
});
test('adjudication staging rejects cross-cell records without publishing an earlier valid candidate',async t=>{
  const {rowsFor}=await import('./benchmark-fixture.mjs');const f=fixture(),h=hosts(f);
  const result=await runAstraTrials(f.plan,f.protocols,{...h,work:workFor(t),maximumTrials:1,adjudicate:({trial},{protocol})=>{
    const row=rowsFor(protocol).find(r=>r.caseId===trial.caseId&&r.participantId===trial.participantId);
    return [{...row,caseId:'not-this-cell'}];
  }});
  assert.equal(result.trials[0].state,'FAILED');assert.deepEqual(result.measurements,[]);
});
test('valid host measurement remains a candidate, not an admitted score or release decision',async t=>{
  const {rowsFor}=await import('./benchmark-fixture.mjs');const {reviewAstraTrialReadiness}=await import('../../js/analysis/benchmark/scoped-trials.js');
  const f=fixture(),h=hosts(f);const result=await runAstraTrials(f.plan,f.protocols,{...h,work:workFor(t),maximumTrials:1,
    adjudicate:({trial},{protocol})=>[rowsFor(protocol).find(r=>r.caseId===trial.caseId&&r.participantId===trial.participantId)]});
  assert.equal(result.measurements.length,1);assert.equal(result.measurements[0].measurement.receiptVerified,false);
  const review=reviewAstraTrialReadiness(f.plan,result);assert.equal(review.denominator,24);assert.equal(review.modes.T0.independentlyMeasured,0);
  assert.equal(review.defaultRolloutEligible,false);assert.ok(review.vetoes.includes('cold-and-warm-strata-incomplete'));
  assert.throws(()=>reviewAstraTrialReadiness(f.plan,structuredClone(result)),/owned-results/);
});

test('a promptly rejected cancel still attempts close within the same cleanup budget', async t => {
  const f = fixture(), h = hosts(f, context => { context.adapter.cancel = async () => { throw new Error('test-cancel-rejected'); }; });
  const result = await runAstraTrials(f.plan, f.protocols, { ...h, work: workFor(t), maximumTrials: 1 });
  assert.equal(h.stats().closes, 1); assert.equal(result.trials[0].state, 'FAILED');
  assert.equal(result.trials[0].executionState, 'invalidated-cleanup'); assert.equal(result.measurements.length, 0);
});
