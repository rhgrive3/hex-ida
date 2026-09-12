import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeAnalysisPlatform } from '../../js/runtime/index.js';
import { RuntimeModuleBindingTable } from '../../js/runtime/provider-identity.js';
import { DebugAdapter } from '../../js/debug/adapter.js';
import { normalizeScopedExperimentObservation } from '../../js/runtime-evidence/index.js';
import { fixture } from './helpers.mjs';
import { installScopedAnalysisTools } from '../../js/ai/tools/scoped-analysis.js';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const HASH = 'ab'.repeat(32);
const observation = () => ({ stop: { kind: 'return' }, returnValue: 7n, memoryDelta: [], memoryAfter: [],
  trace: { complete: true, dropped: 0, gaps: [], events: [] } });
function experiment() { return { id: 'experiment-test', binaryHash: HASH, functionAddress: 0x1000n,
  cases: [{ id: 'one', input: { arguments: [1n] }, initialState: { objectBase: 0x600000000000n, fields: [] },
    watch: [], expected: { returnValue: 8n } }] }; }
class Adapter extends DebugAdapter {
  constructor() { super({ id: 'scpa-experiment-adapter', kind: 'test', capabilities: { launch: true, resume: true } }); this.launches = 0; this.resumes = 0; }
  async launch() { this.launches++; if (this.launchGate) await this.launchGate.promise; }
  async resume() { this.resumes++; if (this.resumeGate) await this.resumeGate.promise; return this.observation ?? observation(); }
}
async function setup(t, config = {}) {
  const adapter = new Adapter(), platform = new RuntimeAnalysisPlatform({ symbolic: false });
  const session = await platform.startSession({ adapter, binaryHash: HASH, connect: false });
  session.modules = [{ id: 'module', base: 0x1000n, size: 128, generation: 1 }];
  const f = fixture(), current = { value: true }, decisions = [];
  const broker = platform.createScopedExperimentBroker({ ...f, snapshotId: 'snap', isCurrent: () => current.value,
    authorize: async plan => { decisions.push(plan); return { approved: true, decisionId: 'host-confirmation-1' }; }, ...config });
  t.after(() => { broker.close(); session.cancelAll('test-end'); });
  return { adapter, platform, session, broker, current, decisions, ...f };
}
async function grant(f, request = {}) { const p = f.broker.prepare({ experiment: experiment(), ...request }); return f.broker.approve(p.id); }
async function waitFor(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await sleep(1); }
  assert.fail('test-operation-did-not-enter');
}

test('preparation has no execution; separate host approval issues a one-use non-serializable grant', async t => {
  const f = await setup(t), p = f.broker.prepare({ experiment: experiment() });
  assert.equal(f.adapter.launches, 0); assert.equal(f.decisions.length, 0); assert.equal(p.observationMode, 'intervened');
  const g = await f.broker.approve(p.id); assert.equal(f.decisions.length, 1); assert.equal(f.adapter.launches, 0);
  await assert.rejects(() => f.broker.execute(structuredClone(g)), /grant-unavailable/);
  const result = await f.broker.execute(g); assert.equal(result.status, 'observed');
  assert.equal(result.globalStaticTruth, false); assert.equal(result.exact, false); assert.equal(f.adapter.resumes, 1);
  assert.equal(result.annotation.observationMode, 'intervened');
  assert.equal(f.platform.evidence.length, 1);
  assert.equal(f.platform.evidence[0].scopedObservation.planId, p.id);
  assert.equal(f.platform.evidence[0].verdict, 'inconclusive', 'legacy fusion cannot promote scoped intervention comparisons');
  await assert.rejects(() => f.broker.execute(g), /grant-unavailable/);
});
test('a declined host approval and caller approval flags cannot execute anything', async t => {
  const f = await setup(t, { authorize: () => ({ approved: false, decisionId: 'denied' }) });
  assert.throws(() => f.broker.prepare({ experiment: experiment(), approved: true }), /request-fields/);
  const p = f.broker.prepare({ experiment: experiment() }); await assert.rejects(() => f.broker.approve(p.id), /authorization-denied/);
  await assert.rejects(() => f.broker.execute({ planId: p.id, approved: true }), /grant-unavailable/);
  assert.equal(f.adapter.launches, 0); assert.equal(f.platform.evidence.length, 0);
});
for (const [name, mutate] of Object.entries({
  build: f => { f.session.binaryHash = 'cd'.repeat(32); },
  epoch: f => f.session.newEpoch(),
  module: f => { f.session.modules[0].generation++; },
  moduleReplacement: f => { f.session.modules = structuredClone(f.session.modules); },
  world: f => { f.current.value = false; },
  close: f => f.broker.close(),
})) test(`grant cannot cross ${name} change`, async t => {
  const f = await setup(t), g = await grant(f); mutate(f);
  await assert.rejects(() => f.broker.execute(g)); assert.equal(f.adapter.launches, 0); assert.equal(f.platform.evidence.length, 0);
});
test('approval cannot outlive a source invalidation during its awaited callback', async t => {
  const decision = deferred(); const f = await setup(t, { authorize: () => decision.promise });
  const p = f.broker.prepare({ experiment: experiment() }); const a = f.broker.approve(p.id);
  await sleep(1); f.current.value = false; decision.resolve({ approved: true, decisionId: 'late' });
  await assert.rejects(a, /stale/); assert.equal(f.adapter.launches, 0);
});
test('expiry, input bounds, malformed hash and unknown fields fail closed', async t => {
  const f = await setup(t), g = await grant(f, { ttlMs: 30 }); await sleep(40);
  await assert.rejects(() => f.broker.execute(g), /grant-unavailable/);
  for (const change of [e => { e.binaryHash = 'other'; }, e => { e.cases = Array(65).fill(e.cases[0]); },
    e => { e.cases[0].input.arguments = Array(17).fill(1n); }, e => { e.scopedObservation = { approved: true }; }]) {
    const e = experiment(); change(e); assert.throws(() => f.broker.prepare({ experiment: e }));
  }
  assert.throws(() => f.broker.prepare({ experiment: experiment(), timeoutMs: 0 }));
  assert.equal(f.adapter.launches, 0);
});
for (const stage of ['launch', 'resume']) test(`uncooperative ${stage} is timeout bounded, cannot resume/publish late`, async t => {
  const f = await setup(t), gate = deferred(); f.adapter[stage + 'Gate'] = gate;
  const g = await grant(f, { timeoutMs: 15 }); const running = f.broker.execute(g);
  await assert.rejects(running, e => ['timeout', 'cancelled'].includes(e.code));
  assert.equal(f.platform.evidence.length, 0); assert.equal(f.session.observations.length, 0);
  gate.resolve(); await sleep(5);
  assert.equal(f.platform.evidence.length, 0); if (stage === 'launch') assert.equal(f.adapter.resumes, 0);
  assert.equal(f.session.controllers.size, 0);
});
for (const mode of ['abort', 'world', 'epoch', 'module', 'session-switch', 'broker-close']) test(`no evidence publication after in-flight ${mode}`, async t => {
  const f = await setup(t), gate = deferred(); f.adapter.resumeGate = gate;
  const g = await grant(f), abort = new AbortController(); const running = f.broker.execute(g, { signal: abort.signal });
  // Attach rejection observer immediately; invalidation may synchronously abort.
  const rejection = assert.rejects(running);
  await waitFor(() => f.adapter.resumes === 1);
  if (mode === 'abort') abort.abort();
  else if (mode === 'world') f.current.value = false;
  else if (mode === 'epoch') f.session.newEpoch();
  else if (mode === 'module') f.session.modules[0].generation++;
  else if (mode === 'session-switch') await f.platform.startSession({ adapter: new Adapter(), binaryHash: HASH, connect: false });
  else f.broker.close();
  gate.resolve(); await rejection; await sleep(2);
  assert.equal(f.platform.evidence.length, 0); assert.equal(f.session.observations.length, 0);
});
test('session single-flight prevents a second experiment from replacing adapter state', async t => {
  const f = await setup(t); f.adapter.resumeGate = deferred();
  const running = f.platform.runExperiment(experiment(), { experimentTimeoutMs: 1000 });
  await waitFor(() => f.adapter.resumes === 1);
  await assert.rejects(() => f.platform.runExperiment(experiment()), e => e.code === 'experiment-busy');
  f.adapter.resumeGate.resolve(); await running; assert.equal(f.adapter.launches, 1);
});
test('platform host guard must explicitly admit publication, before launch too', async t => {
  const f = await setup(t);
  await assert.rejects(() => f.platform.runExperiment(experiment(), {}, () => false), e => e.code === 'experiment-publication-refused');
  assert.equal(f.adapter.launches, 0);
});
test('SAT replay requires a live, same-world owner and never bypasses separate approval', async t => {
  let candidateCurrent = true, f;
  f = await setup(t, { resolveCounterexample: () => ({ isCurrent: () => candidateCurrent,
    data: { id: 'sat-candidate', kind: 'validated-sat-candidate', worldId: f.world.id, assumptionsId: f.assumptions.id,
      snapshotId: 'snap', queryHash: 'query-owner-hash', checkerId: 'owner-solver', checkerVersion: 'test-1', experiment: experiment() } }) });
  const p = await f.broker.prepareCounterexampleReplay({ candidateId: 'sat-candidate' });
  assert.equal(f.adapter.launches, 0); assert.equal(p.purpose, 'sat-counterexample-candidate-replay');
  const g = await f.broker.approve(p.id); const result = await f.broker.execute(g);
  assert.equal(result.result.cases[0].comparison.status, 'contradicted');
  assert.equal(result.candidateReproduced, true); assert.equal(result.globalStaticTruth, false);
  const p2 = await f.broker.prepareCounterexampleReplay({ candidateId: 'sat-candidate' });
  candidateCurrent = false; await assert.rejects(() => f.broker.approve(p2.id), /counterexample-stale/);
});
test('gaps or missing completeness never qualify a replayed counterexample', async t => {
  let f;
  f = await setup(t, { resolveCounterexample: () => ({ isCurrent: () => true, data: { id: 'sat', kind: 'validated-sat-candidate',
    worldId: f.world.id, assumptionsId: f.assumptions.id, snapshotId: 'snap', queryHash: 'q', checkerId: 'c', checkerVersion: 'v', experiment: experiment() } }) });
  for (const trace of [null, { complete: true, dropped: 1, gaps: [] }, { complete: true, dropped: 0, gaps: ['lost'] }]) {
    f.adapter.observation = { ...observation(), trace };
    const p = await f.broker.prepareCounterexampleReplay({ candidateId: 'sat' }), g = await f.broker.approve(p.id);
    const r = await f.broker.execute(g); assert.equal(r.candidateReproduced, false); assert.equal(r.traceCompleteness, 'unknown-or-gapped');
  }
});
test('forged SAT payload cannot be used as a resolver or a read-only AI tool execution request', async t => {
  const f = await setup(t);
  await assert.rejects(() => f.broker.prepareCounterexampleReplay({ candidateId: 'sat', sat: true }), /fields/);
  await assert.rejects(() => f.broker.prepareCounterexampleReplay({ candidateId: 'sat' }), /owner-unavailable/);
  const registered = [];
  installScopedAnalysisTools({ get: () => null, register: definition => registered.push(definition) }, { analysisAuthority: 'AnalysisQueryAPI', runScopedAnalysis() {} });
  assert.ok(registered.length > 20); assert.ok(registered.every(tool => tool.mutability === 'read-only'));
  const tools = JSON.stringify(registered);
  assert.doesNotMatch(tools, /createScopedExperimentBroker|prepareCounterexampleReplay|runExperiment/);
});
test('scoped evidence provenance rejects relabeling intervention as natural or erasing its identity', () => {
  const base = { schema: 'scoped-experiment-observation/v1', worldId: 'w', assumptionsId: 'a', snapshotId: 's', planId: 'p',
    authorizationId: 'h', sessionEpoch: 1, observationMode: 'intervened', interventionIds: ['p'], classification: 'observation-only' };
  assert.ok(Object.isFrozen(normalizeScopedExperimentObservation(base)));
  for (const patch of [{ observationMode: 'observed' }, { interventionIds: [] }, { classification: 'proven' }, { sessionEpoch: 0 }]) {
    assert.throws(() => normalizeScopedExperimentObservation({ ...base, ...patch }));
  }
});
function providerOwner(f) {
  const modules = new RuntimeModuleBindingTable('provider-session');
  const input = { bindingKey: 'image', runtimeBase: 0x1000n, runtimeSize: 0x100n, staticBase: 0x2000n,
    binaryId: 'binary-scpa-test', sliceId: 'slice-arm64', identityState: 'exact', identityEvidenceIds: ['build-owner'] };
  modules.load(input);
  return { modules, input, isCurrent: () => true, binding: { worldId: f.world.id, assumptionsId: f.assumptions.id,
    snapshotId: 'snap', runtimeSessionId: 'provider-session', debugSessionId: f.session.id,
    providerId: 'mock-first-party', providerVersion: '1', sessionEpoch: f.session.epoch } };
}
test('canonical provider module owner binds relocation/generation into saved observation', async t => {
  let owner; const f = await setup(t, { getModuleBindingContext: () => owner }); owner = providerOwner(f);
  const p = f.broker.prepare({ experiment: experiment() });
  assert.equal(p.moduleBinding.moduleGeneration, 1); assert.equal(p.moduleBinding.staticAddress, '8192');
  const r = await f.broker.execute(await f.broker.approve(p.id));
  assert.equal(r.remaining.includes('canonical-provider-module-generation-unbound'), false);
  assert.deepEqual(f.platform.evidence[0].scopedObservation.moduleBinding, p.moduleBinding);
});
for (const mode of ['reload', 'overlap', 'owner', 'binding']) test(`provider ${mode} change blocks grant before launch`, async t => {
  let owner; const f = await setup(t, { getModuleBindingContext: () => owner }); owner = providerOwner(f);
  const g = await grant(f);
  if (mode === 'reload') { owner.modules.unload('image'); owner.modules.load(owner.input); }
  if (mode === 'overlap') owner.modules.load({ ...owner.input, bindingKey: 'overlap' });
  if (mode === 'owner') owner.isCurrent = () => false;
  if (mode === 'binding') owner.binding.providerVersion = '2';
  await assert.rejects(() => f.broker.execute(g)); assert.equal(f.adapter.launches, 0);
});
test('provider same-address unload/reload during resume blocks all publication', async t => {
  let owner; const f = await setup(t, { getModuleBindingContext: () => owner }); owner = providerOwner(f);
  const gate = deferred(); f.adapter.resumeGate = gate; const g = await grant(f);
  const running = f.broker.execute(g), rejected = assert.rejects(running, /module-generation-changed/);
  await waitFor(() => f.adapter.resumes === 1); owner.modules.unload('image'); owner.modules.load(owner.input); gate.resolve();
  await rejected; assert.equal(f.platform.evidence.length, 0); assert.equal(f.session.observations.length, 0);
});
test('missing, ambiguous, and cross-debug-session provider mappings cannot authorize target execution', async t => {
  let owner; const f = await setup(t, { getModuleBindingContext: () => owner }); owner = providerOwner(f);
  owner.binding.debugSessionId = 'other'; assert.throws(() => f.broker.prepare({ experiment: experiment() }), /binding-mismatch/);
  owner.binding.debugSessionId = f.session.id; owner.modules.load({ ...owner.input, bindingKey: 'overlap' });
  assert.throws(() => f.broker.prepare({ experiment: experiment() }), /target-module-unbound/);
  owner.modules.unload('overlap'); owner.modules.unload('image');
  assert.throws(() => f.broker.prepare({ experiment: experiment() }), /target-module-unbound/);
});
