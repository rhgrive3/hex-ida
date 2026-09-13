import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, workFor, qualified } from './helpers.mjs';
import { EvidenceStore } from '../../js/ai/evidence.js';
import { HypothesisStore } from '../../js/ai/hypothesis.js';
import { stableDigest, lossyTypeWitness } from '../../js/core/identity/index.js';
import { createScopedJobContextProvider } from '../../js/ai/investigation/scoped-job-context.js';
import { describeInvestigationFrontier, investigationDischargeProposition, InvestigationViewCache } from '../../js/ai/investigation/scoped-frontier.js';
const digest = value => stableDigest({ value, typed: lossyTypeWitness(value) });
const cost = (n = 10) => ({ workUnits: n, bytesRead: 0, residentBytes: 1, toolCalls: 1 });
function setup(t) {
  const f = fixture(), evidenceStore = new EvidenceStore(), hypothesisStore = new HypothesisStore(evidenceStore);
  hypothesisStore.upsert({ id: 'h', claim: 'fixture proposition', status: 'open' });
  const job = { id: 'j', executionScopeId: 'scope', sessionId: 's', goal: 'check declared fixture propositions', status: 'paused',
    effectiveScope: {}, hypothesisIds: ['h'], evidenceIds: [], unresolvedWork: [], completedTools: [], budgetUsage: {}, limits: {}, updatedAt: 'now' };
  const stores = { evidenceStore, hypothesisStore }, runtime = { jobs: { jobs: new Map([['j', job]]), runningJobIds: new Set(),
    loadingPromises: new Map(), pendingCheckpoints: new Map() }, storeNamespaces: new Map([['binary-scpa-test::s', stores]]),
    storeNamespaceOwners: new Map([['binary-scpa-test::s', 's']]) };
  const obligations = ['a', 'b'].map(id => ({ id, propositionId: 'p-' + id, producerArtifactId: 'artifact', ownerRevision: '1',
    hypothesisIds: ['h'], dependencies: [], evidenceIds: [], requiredCapability: 'inspect-canonical-evidence', declaredImpact: 1, costEstimate: cost() }));
  const binding = { worldId: f.world.id, assumptionsId: f.assumptions.id, snapshotId: 'snap', jobId: 'j', executionScopeId: 'scope', ownerRevision: '1' };
  const data = { schema: 'canonical-investigation-obligations/v1', ...binding, obligations, costSamples: [],
    successContract: { schema: 'investigation-success-contract/v1', id: 'contract', ...binding, goalDigest: digest(job.goal),
      requiredObligationIds: ['a', 'b'], contradictionObligationIds: [] } };
  let current = true;
  const getContext = createScopedJobContextProvider(runtime, { binaryId: 'binary-scpa-test', getObligations: () => ({ data, isCurrent: () => current }) });
  const discharge = row => qualified(f, { subject: row.id, value: investigationDischargeProposition(row) });
  const view = (request = {}, options = {}) => describeInvestigationFrontier({ jobId: 'j', ...request },
    { ...f, snapshotId: 'snap', getContext, work: workFor(t), ...options });
  return { f, data, job, stores, view, discharge, retire: () => { current = false; } };
}
test('explicit fixed contract closes only with scoped qualified discharges; job is unchanged', async t => {
  const x = setup(t), before = structuredClone(x.job);
  const r = await x.view({}, { resolveDischarge: x.discharge });
  assert.equal(r.goal.goalCompleted, true); assert.equal(r.coverage.fixedContract.percent, 100);
  assert.equal(r.stop.kind, 'success-contract-met'); assert.equal(r.coverage.wholeGoalPercentage, null);
  assert.equal(r.jobStateChanged, false); assert.equal(r.canonicalTruthChanged, false); assert.deepEqual(x.job, before);
});
test('one missing qualified proposition reports 50% of the fixed denominator, not completion', async t => {
  const x = setup(t), r = await x.view({}, { resolveDischarge: row => row.id === 'a' ? x.discharge(row) : null });
  assert.equal(r.goal.goalCompleted, false); assert.equal(r.coverage.fixedContract.percent, 50);
  assert.equal(r.coverage.wholeBinaryCoverage, 'unknown');
});
for (const [name, mutate, pattern] of [
  ['empty', d => d.successContract.requiredObligationIds = [], /nonempty-unique/],
  ['duplicate', d => d.successContract.requiredObligationIds = ['a', 'a'], /nonempty-unique/],
  ['foreign world', d => d.successContract.worldId = 'other', /contract-binding/],
  ['foreign goal', d => d.successContract.goalDigest = 'other', /contract-binding/],
  ['stale inventory', d => d.successContract.ownerRevision = 'old', /contract-binding/],
  ['undeclared contradiction', d => d.successContract.contradictionObligationIds = ['not-in-contract'], /untracked-contradiction/],
]) test(`success contract rejects ${name}`, async t => {
  const x = setup(t); mutate(x.data); await assert.rejects(x.view({}, { resolveDischarge: x.discharge }), pattern);
});
for (const [name, mutate] of [
  ['missing required row', d => d.obligations.pop()],
  ['new obligation', d => d.obligations.push({ ...d.obligations[0], id: 'new' })],
  ['missing dependency', d => d.obligations[0].dependencies.push('missing')],
  ['cycle', d => { d.obligations[0].dependencies = ['b']; d.obligations[1].dependencies = ['a']; }],
]) test(`${name} blocks completion even with accepting test judgments`, async t => {
  const x = setup(t); mutate(x.data); const r = await x.view({}, { resolveDischarge: x.discharge });
  assert.equal(r.goal.goalCompleted, false); assert.notEqual(r.stop.kind, 'success-contract-met');
});
test('absent success contract never treats an empty inventory or all discharges as completion', async t => {
  const x = setup(t); delete x.data.successContract;
  assert.equal((await x.view({}, { resolveDischarge: x.discharge })).goal.goalCompleted, false);
  x.data.obligations.length = 0; assert.equal((await x.view()).goal.goalCompleted, false);
});
test('model JSON cannot inject cost samples or success authority into the read query', async t => {
  const x = setup(t);
  for (const injected of [{ costSamples: [] }, { successContract: x.data.successContract }]) await assert.rejects(x.view(injected), /query-fields/);
  await assert.rejects(x.view({}, { resolveDischarge: () => ({ status: 'discharged', precision: 'exact' }) }));
});
test('stale job/owner during discharge cannot publish a completed goal', async t => {
  const x = setup(t); await assert.rejects(x.view({}, { resolveDischarge: async row => {
    const result = await x.discharge(row); x.retire(); return result;
  } }), /stale/);
});
test('budget-deferred inspections are explicit and no tools execute', async t => {
  const x = setup(t), r = await x.view({ planningBudget: { workUnits: 0, bytesRead: 0, residentBytes: 0, toolCalls: 0 } });
  assert.equal(r.stop.kind, 'budget'); assert.equal(r.frontier.actions.length, 0); assert.equal(r.frontier.deferred.length, 2);
  assert.equal(r.goal.automatedActionsStarted, 0); assert.equal(r.frontier.hardExecutionBudgetEnforcedHere, false);
});
test('cost calibration is descriptive and applied before Pareto and action cuts', async t => {
  const x = setup(t); x.data.obligations[1].requiredCapability = 'inspect-memory-object';
  x.data.obligations[1].costEstimate = cost(1000); // originally dominated by a
  x.data.costSamples = [
    { id: '1', ownerRevision: '1', requiredCapability: 'inspect-canonical-evidence', cost: cost(100), elapsedMs: 10, resolvedObligationIds: ['fake-resolution'] },
    { id: '2', ownerRevision: '1', requiredCapability: 'inspect-memory-object', cost: cost(1), elapsedMs: 1, resolvedObligationIds: [] },
  ];
  const r = await x.view({ maximumActions: 1, planningBudget: { workUnits: 5, bytesRead: 0, residentBytes: 1, toolCalls: 1 } });
  assert.equal(r.frontier.actions[0].obligationId, 'b'); assert.equal(r.frontier.actions[0].costModel, 'host-observed-p75/v1');
  assert.equal(r.costCalibration.models[0].currentlyAdmittedReferences, 0); assert.equal(r.goal.goalCompleted, false);
});
test('malformed, negative, duplicate or old cost samples fail closed', async t => {
  const x = setup(t), sample = { id: '1', ownerRevision: '1', requiredCapability: 'inspect-canonical-evidence', cost: cost(), elapsedMs: 1, resolvedObligationIds: [] };
  for (const samples of [[{ ...sample, elapsedMs: NaN }], [{ ...sample, ownerRevision: 'old' }], [sample, sample], [{ ...sample, cost: cost(-1) }]]) {
    x.data.costSamples = samples; await assert.rejects(x.view());
  }
});
test('delta transport explicitly reports a fixed-denominator change', async t => {
  const x = setup(t), cache = new InvestigationViewCache(), a = await x.view();
  cache.project(a, null, { work: workFor(t) });
  x.data.obligations.push({ ...x.data.obligations[0], id: 'c' }); x.data.successContract.requiredObligationIds.push('c');
  const b = await x.view(), delta = cache.project(b, a.id, { work: workFor(t) });
  assert.equal(delta.transfer.mode, 'delta'); assert.equal(delta.transfer.fixedDenominatorChanged, true);
  assert.equal(delta.coverage.fixedContract.denominator, 3);
});
