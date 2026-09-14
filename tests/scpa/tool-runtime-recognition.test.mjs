import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, workFor, qualified } from './helpers.mjs';
import { installScopedAnalysisTools } from '../../js/ai/tools/scoped-analysis.js';
import { fingerprintFunction } from '../../js/fingerprint/index.js';
import { queryScopedRecognition } from '../../js/recognition/scoped-evidence.js';
import { RuntimeModuleBindingTable } from '../../js/runtime/provider-identity.js';
import { createRuntimeEvent } from '../../js/runtime/events.js';
import { queryRuntimeReconciliation } from '../../js/runtime/scoped-reconciliation.js';

function registry() {
  const tools = new Map();
  return { tools, get: name => tools.get(name), register: tool => tools.set(tool.name, tool) };
}
const authority = runScopedAnalysis => ({ analysisAuthority: 'AnalysisQueryAPI', runScopedAnalysis });
test('scoped tools require the canonical query authority before any registration', () => {
  const r = registry();
  for (const context of [null, {}, authority(null), { analysisAuthority: 'model', runScopedAnalysis() {} }]) {
    assert.equal(installScopedAnalysisTools(r, context), r);
    assert.equal(r.tools.size, 0);
  }
});
test('all scoped tools stay read-only, uncached and route to the query owner', async () => {
  const r = registry(), calls = [];
  assert.equal(installScopedAnalysisTools(r, authority((...args) => { calls.push(args); return 'owner-result'; })), r);
  const expected = ['inspect_task_idiom_view', 'inspect_conditional_model', 'check_loop_invariant', 'inspect_async_event_order', 'portable_integer_checks', 'inspect_investigation_frontier', 'inspect_objc_block_captures', 'inspect_physical_type_evidence',
    'query_scoped_interprocedural_flow', 'inspect_abi_input_bindings', 'inspect_abi_placement_evidence',
    'explain_transform_proof_chain', 'reconcile_captured_runtime_observations', 'explain_knowledge_matches',
    'inspect_apple_pointer_site', 'get_scoped_analysis_capabilities', 'query_semantic_flow', 'resume_semantic_flow',
    'resolve_dispatch_targets', 'describe_memory_objects', 'explain_scoped_reference_slice', 'replay_scoped_reference_slice',
    'inspect_scoped_call_graph', 'resume_scoped_call_graph', 'list_range_value_ids', 'refine_value_facts',
    'query_function_summaries', 'resume_function_summaries', 'export_evidence_slice', 'replay_evidence_slice',
    'cancel_scoped_query', 'query_demand_precision', 'resume_demand_precision', 'explain_demand_result',
    'replay_demand_result', 'investigate_demand_precision', 'inspect_demand_obligations'];
  assert.deepEqual([...r.tools.keys()].sort(), expected.sort());
  for (const tool of r.tools.values()) {
    assert.equal(tool.mutability, 'read-only'); assert.equal(tool.needsApproval, false);
    assert.equal(tool.deterministic, false); assert.equal(tool.storeResult, true);
    assert.deepEqual(tool.scopeSupport, ['auto', 'binary', 'project']);
    const request = { sentinel: tool.name };
    assert.equal(await tool.execute(request), 'owner-result');
    assert.deepEqual(calls.at(-1)[1], request); assert.notEqual(calls.at(-1)[1], request); assert.equal(calls.at(-1)[2].signal, null);
  }
  assert.equal(new Set(calls.map(call => call[0])).size, expected.length);
  assert.equal(r.get('get_scoped_analysis_capabilities').cost, 'cheap');
  assert.equal(r.get('query_semantic_flow').cost, 'expensive');
});
test('scoped tool execution preserves explicit and inherited cancellation signals', async () => {
  const r = registry(), calls = [];
  installScopedAnalysisTools(r, authority((...args) => calls.push(args)));
  const inherited = new AbortController(), explicit = new AbortController();
  r.executionSignal = inherited.signal;
  await r.get('query_semantic_flow').execute({});
  await r.get('query_semantic_flow').execute({}, { signal: explicit.signal });
  assert.equal(calls[0][2].signal, inherited.signal);
  assert.equal(calls[1][2].signal, explicit.signal);
});
test('a late scoped tool name conflict cannot leave a partially installed tool set', () => {
  const r = registry(), original = { name: 'cancel_scoped_query' };
  r.register(original);
  assert.throws(() => installScopedAnalysisTools(r, authority(() => {})), /scoped-tool-name-conflict/);
  assert.deepEqual([...r.tools.values()], [original]);
});

function recognitionFixture(t) {
  const f = fixture(), snapshotId = 'snapshot-recognition';
  const fingerprint = fingerprintFunction({ architecture: 'arm64', bytes: [0xc0, 3, 0x5f, 0xd6], strings: ['fixture'] });
  const publish = id => ({ binaryId: 'binary-scpa-test', functionId: id, artifactId: 'artifact-' + id,
    fingerprint, evidenceIds: ['fingerprint-owner'], label: id, provenance: { kind: 'test-corpus' } });
  const context = { functionLocator: 'query', worldId: f.world.id, snapshotId, revision: 'knowledge-v1',
    query: publish('query'), candidates: [publish('a'), publish('b')],
    page: { completeness: 'complete-page', remaining: [] }, isCurrent: () => true };
  const run = request => queryScopedRecognition({ functionId: 'query', ...request },
    { ...f, snapshotId, work: workFor(t), getContext: () => context });
  return { f, context, run };
}
test('real fingerprint comparison cannot turn identical bytes or shared features into proof', async t => {
  const { run } = recognitionFixture(t), r = await run();
  assert.equal(r.status, 'completed'); assert.equal(r.candidates.length, 2);
  assert.equal(r.exact, false); assert.equal(r.upperBound.kind, 'top'); assert.deepEqual(r.provenMembers, []);
  assert.equal(r.existence, 'POSSIBLE'); assert.ok(r.collisions.length > 0);
  for (const candidate of r.candidates) {
    assert.equal(candidate.exactIdentity, false); assert.equal(candidate.semanticEquivalence, 'unproved');
    assert.equal(candidate.metadataTransferAllowed, false); assert.ok(candidate.features.length > 0);
    assert.ok(candidate.score >= 0 && candidate.score <= 1);
  }
});
test('recognition truncation and opaque page continuation cannot close the knowledge universe', async t => {
  const { run, context } = recognitionFixture(t);
  context.page = { completeness: 'partial', remaining: ['external-index'], continuation: 'host-page-2' };
  const r = await run({ resultLimit: 1 });
  assert.equal(r.candidates.length, 1); assert.equal(r.considered, 2); assert.equal(r.continuation, 'host-page-2');
  for (const reason of ['ranked-result-truncated', 'candidate-page-incomplete', 'external-index', 'knowledge-universe-open']) {
    assert.ok(r.remaining.includes(reason));
  }
});
test('an empty complete knowledge page remains UNKNOWN rather than proving no match', async t => {
  const { run, context } = recognitionFixture(t); context.candidates = [];
  const r = await run(); assert.equal(r.existence, 'UNKNOWN'); assert.equal(r.upperBound.kind, 'top');
});
for (const [name, mutate, error] of [
  ['duplicate candidates', c => c.candidates.push(c.candidates[0]), /duplicate-candidate/],
  ['foreign query binary', c => c.query.binaryId = 'foreign-binary', /outside-world/],
  ['obsolete fingerprint version', c => c.query.fingerprint = { ...c.query.fingerprint, version: 'obsolete' }, /full-fingerprint-required/],
  ['non-ARM fingerprint', c => c.query.fingerprint = { ...c.query.fingerprint, architecture: 'x86' }, /arm64-only/],
  ['stale owner', c => c.isCurrent = () => false, /context-binding/],
]) test(`recognition rejects ${name} without publishing qualified results`, async t => {
  const { run, context } = recognitionFixture(t); mutate(context); await assert.rejects(run(), error);
});

function runtimeFixture(t, observationMode = 'observed') {
  const f = fixture(), snapshotId = 'snapshot-runtime', runtimeSessionId = 'recorded-session';
  const modules = new RuntimeModuleBindingTable(runtimeSessionId);
  const moduleInput = { bindingKey: 'image', runtimeBase: 0x1000n, runtimeSize: 0x100n, staticBase: 0x2000n,
    binaryId: 'binary-scpa-test', sliceId: 'slice-arm64', identityState: 'exact',
    identityEvidenceIds: ['build-owner'], buildIdentity: { kind: 'fixture-image', hash: 'ab'.repeat(32) } };
  modules.load(moduleInput);
  const event = createRuntimeEvent({ runtimeSessionId, providerId: 'recorded-fixture', providerVersion: '1', sessionEpoch: 1,
    kind: 'basic-block', moduleBindingKey: 'image', moduleGeneration: 1, observationMode,
    interventionIds: observationMode === 'intervened' ? ['fixture-intervention'] : [], payload: { pc: '0x1010', unrelated: 'private-payload' } });
  const observation = { event, address: { eventId: event.eventId, role: 'instruction', fieldPath: ['pc'],
    moduleBindingKey: 'image', moduleGeneration: 1, providerSchemaVersion: '1', evidenceIds: ['address-role'], subject: null } };
  const context = { modules, binding: { worldId: f.world.id, assumptionsId: f.assumptions.id, snapshotId,
    runtimeSessionId, providerId: 'recorded-fixture', providerVersion: '1', sessionEpoch: 1 },
    isCurrent: () => true, getObservation: () => observation };
  const run = (extra = {}) => queryRuntimeReconciliation({ runtimeSessionId, eventIds: [event.eventId], role: 'instruction' },
    { ...f, snapshotId, work: workFor(t), getContext: () => context, ...extra });
  return { f, modules, moduleInput, context, observation, run };
}
test('captured runtime addresses use the real module owner but do not gain static authority', async t => {
  const { run } = runtimeFixture(t), r = await run();
  assert.equal(r.observations.length, 1); assert.equal(r.observations[0].staticAddress.address, '0x2010');
  assert.equal(r.observations[0].admitted, false); assert.equal(r.observations[0].staticExact, false);
  assert.equal(r.negativeConclusion, 'not-supported-by-observation'); assert.equal(r.runtimeSideEffects, false);
  assert.equal(r.staticTruthChanged, false); assert.equal(JSON.stringify(r).includes('private-payload'), false);
});
for (const mode of ['synthetic', 'intervened']) test(`${mode} events cannot invoke natural-observation admission`, async t => {
  const { run } = runtimeFixture(t, mode);
  const r = await run({ qualifyObservation: () => { throw Error('admission must not run'); } });
  assert.equal(r.observations[0].admitted, false);
  assert.ok(r.observations[0].remaining.includes('intervened-or-synthetic-not-natural-execution'));
});
test('a bound test-checker receipt qualifies only some witnessed execution, never all execution', async t => {
  const { run, f } = runtimeFixture(t);
  // This deliberately accepting test checker verifies the authority boundary, not real image semantics.
  const r = await run({ qualifyObservation: ({ observationId, proposition }) => qualified(f,
    { subject: observationId, value: proposition, quantifier: 'some-witnessed-execution' }) });
  assert.equal(r.observations[0].admitted, true);
  assert.equal(r.observations[0].quantifier, 'some-witnessed-execution'); assert.equal(r.exact, false);
});
test('runtime module replacement during event retrieval invalidates publication', async t => {
  const { run, context, modules, moduleInput, observation } = runtimeFixture(t);
  context.getObservation = () => { modules.unload('image'); modules.load(moduleInput); return observation; };
  await assert.rejects(run(), /module-generation-changed/);
});
test('unloaded captured generations remain explicit unknowns', async t => {
  const { run, modules } = runtimeFixture(t); modules.unload('image');
  const r = await run(); assert.equal(r.observations.length, 0);
  assert.equal(r.unknown[0].reason, 'historical-or-unloaded-module-generation');
});
test('missing runtime events cannot be silently converted into absent execution', async t => {
  const { run, context } = runtimeFixture(t); context.getObservation = () => null;
  const r = await run(); assert.equal(r.unknown[0].reason, 'captured-event-unavailable'); assert.equal(r.exact, false);
});
test('runtime epoch mismatch fails closed before address projection', async t => {
  const { run, context } = runtimeFixture(t); context.binding.sessionEpoch = 2;
  await assert.rejects(run(), /event-binding/);
});
