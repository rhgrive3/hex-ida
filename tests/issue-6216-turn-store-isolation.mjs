// Regression for #6216: executeTurn() projected per-session stores onto
// shared runtime fields and then re-read those fields across awaits. A later
// turn could therefore finalize with another session or binary's evidence,
// hypotheses, proposals, or persistence payload. These bounded tests use
// ordinary planner/provider turns and exercise the public job/cancel paths.
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { AIRuntime } from '../js/ai/runtime.js';

const binaryContext = new AsyncLocalStorage();

function turnFor(runtime, binaryId, input, options = {}) {
  return binaryContext.run({ binaryId }, () => runtime.turn({ ...input, binaryId }, options));
}

function storesFor(runtime, sessionId) {
  const match = [...runtime.storeNamespaces.entries()]
    .find(([key]) => key.endsWith(`::${sessionId}`));
  assert.ok(match, `namespace for ${sessionId} must exist`);
  return match[1];
}

function planFor(label) {
  const evidenceId = `plan-${label}`;
  const candidate = {
    address: label === 'A' ? '0x1000' : '0x2000',
    name: `fn-${label}`,
    score: 1,
    sources: [`source-${label}`],
    evidence: [evidenceId],
    verification: { verified: true, evidenceIds: [evidenceId] },
  };
  return { candidates: [candidate], best: candidate, evidence: [evidenceId], missingEvidence: [], stats: {} };
}

function decisionFor(label, { evidenceId = null, proposalId = null } = {}) {
  return {
    type: 'final',
    answer: `answer ${label}`,
    confidence: 0.9,
    evidenceIds: evidenceId ? [evidenceId] : [],
    hypotheses: [{ id: `hyp-${label}`, claim: `claim ${label}`, status: 'open' }],
    suggestedActions: proposalId ? [{ kind: 'review-proposal', target: proposalId }] : [],
    followups: [],
  };
}

function proposalFor(stores, label, evidenceId) {
  return stores.proposalStore.create({
    kind: 'comment',
    target: { address: label === 'A' ? '0x1000' : '0x2000' },
    before: null,
    after: `approved ${label}`,
    evidenceIds: [evidenceId],
    reason: `proposal ${label}`,
  });
}

async function waitFor(entered, running, message) {
  await Promise.race([
    entered,
    running.then(() => { throw new Error(message); }, (error) => { throw error; }),
  ]);
}

// 1. Planner evidence, hypotheses, proposals, persistence, and distinct
// binary namespaces remain isolated when turns interleave at the planner
// await. AsyncLocalStorage models two independent active binary bindings while
// retaining the runtime's real binding checks.
{
  let releaseAPlan;
  const aPlanGate = new Promise((resolve) => { releaseAPlan = resolve; });
  let enterAPlan;
  const aPlanEntered = new Promise((resolve) => { enterAPlan = resolve; });
  const persisted = new Map();
  let runtime;

  const planner = async (goal) => {
    const label = goal.endsWith(' A') ? 'A' : 'B';
    if (label === 'A') {
      enterAPlan();
      await aPlanGate;
    }
    return planFor(label);
  };

  runtime = new AIRuntime({
    context: binaryContextContext(),
    planner,
    persistence: {
      async save(session) { persisted.set(session.id, structuredClone(session)); },
    },
    provider: {
      async nextTurn(payload) {
        const text = payload.messages.at(-1)?.content || '';
        const label = text.endsWith(' A') ? 'A' : 'B';
        const sourceId = `plan-${label}`;
        const stores = storesFor(runtime, payload.sessionId);
        const evidence = stores.evidenceStore.all().find((item) => item.sourceData?.sourceId === sourceId);
        assert.ok(evidence, `${label} planner evidence must be in its captured namespace`);
        const proposal = proposalFor(stores, label, evidence.id);
        return decisionFor(label, { evidenceId: evidence.id, proposalId: proposal.id });
      },
    },
  });

  const turnA = turnFor(runtime, 'binary-A', { mode: 'agent', goal: 'find function A' });
  await waitFor(aPlanEntered, turnA, 'turn A completed before its planner barrier');
  const turnB = turnFor(runtime, 'binary-B', { mode: 'agent', goal: 'find function B' });
  const b = await turnB;
  releaseAPlan();
  const a = await turnA;

  assert.equal(a.evidence.length, 1, 'A result must contain one planner evidence record');
  assert.equal(a.evidence[0].sourceData.sourceId, 'plan-A', 'A result must use only A planner evidence');
  assert.equal(b.evidence.length, 1, 'B result must contain one planner evidence record');
  assert.equal(b.evidence[0].sourceData.sourceId, 'plan-B', 'B result must use only B planner evidence');
  assert.deepEqual(a.hypotheses.map((item) => item.id), ['hyp-A'], 'A result must use only A hypotheses');
  assert.deepEqual(b.hypotheses.map((item) => item.id), ['hyp-B'], 'B result must use only B hypotheses');
  assert.equal(a.hypotheses.some((item) => item.id === 'hyp-B'), false);
  assert.equal(b.hypotheses.some((item) => item.id === 'hyp-A'), false);

  const aProposalId = a.actions.find((item) => item.kind === 'review-proposal')?.target;
  const bProposalId = b.actions.find((item) => item.kind === 'review-proposal')?.target;
  assert.ok(aProposalId && bProposalId && aProposalId !== bProposalId, 'each result must retain its own proposal');
  assert.deepEqual(storesFor(runtime, a.sessionId).proposalStore.all().map((item) => item.id), [aProposalId]);
  assert.deepEqual(storesFor(runtime, b.sessionId).proposalStore.all().map((item) => item.id), [bProposalId]);

  const savedA = persisted.get(a.sessionId);
  const savedB = persisted.get(b.sessionId);
  assert.ok(savedA && savedB, 'both session namespaces must be persisted');
  assert.deepEqual(savedA.hypotheses.map((item) => item.id), ['hyp-A']);
  assert.deepEqual(savedB.hypotheses.map((item) => item.id), ['hyp-B']);
  assert.ok(savedA.confirmedFindings.some((item) => item.sourceData?.sourceId === 'plan-A'));
  assert.equal(savedA.confirmedFindings.some((item) => item.sourceData?.sourceId === 'plan-B'), false);
  assert.ok(savedB.confirmedFindings.some((item) => item.sourceData?.sourceId === 'plan-B'));
  assert.equal(savedB.confirmedFindings.some((item) => item.sourceData?.sourceId === 'plan-A'), false);
  assert.ok(savedA.proposedActions.some((item) => item.id === aProposalId));
  assert.equal(savedA.proposedActions.some((item) => item.id === bProposalId), false);
  assert.ok(savedB.proposedActions.some((item) => item.id === bProposalId));
  assert.equal(savedB.proposedActions.some((item) => item.id === aProposalId), false);

  const aKey = [...runtime.storeNamespaces.keys()].find((key) => key.endsWith(`::${a.sessionId}`));
  const bKey = [...runtime.storeNamespaces.keys()].find((key) => key.endsWith(`::${b.sessionId}`));
  assert.match(aKey, /^fallback:binary-A::/);
  assert.match(bKey, /^fallback:binary-B::/);
}

// 2. Cancelling one externally signalled turn must not abort or rebind a
// concurrent turn. The live turn waits until the cancelled provider has been
// stopped, then completes with its own evidence/proposal namespace.
{
  let enterCancelled;
  const cancelledEntered = new Promise((resolve) => { enterCancelled = resolve; });
  let enterLive;
  const liveEntered = new Promise((resolve) => { enterLive = resolve; });
  let releaseLive;
  const liveGate = new Promise((resolve) => { releaseLive = resolve; });
  let runtime;

  runtime = new AIRuntime({
    context: binaryContextContext(),
    planner: false,
    provider: {
      async nextTurn(payload, { signal }) {
        const text = payload.messages.at(-1)?.content || '';
        const live = text.includes('live');
        const label = live ? 'LIVE' : 'CANCELLED';
        const stores = storesFor(runtime, payload.sessionId);
        if (!live) {
          enterCancelled();
          await new Promise((resolve, reject) => {
            if (signal.aborted) { reject(abortError()); return; }
            signal.addEventListener('abort', () => reject(abortError()), { once: true });
          });
        } else {
          enterLive();
          await liveGate;
        }
        const evidenceId = 'live-evidence';
        stores.evidenceStore.add({ id: evidenceId, kind: 'provider', status: 'supported', title: 'live evidence', sourceTool: 'test-provider' });
        const proposal = proposalFor(stores, live ? 'B' : 'A', evidenceId);
        return decisionFor(label, { evidenceId, proposalId: proposal.id });
      },
    },
  });

  const controller = new AbortController();
  const cancelledTurn = turnFor(runtime, 'cancel-bin', { mode: 'agent', goal: 'cancelled turn' }, { signal: controller.signal });
  await waitFor(cancelledEntered, cancelledTurn.catch(() => {}), 'cancelled turn did not enter provider');
  const liveTurn = turnFor(runtime, 'live-bin', { mode: 'agent', goal: 'live turn' });
  await waitFor(liveEntered, liveTurn, 'live turn did not enter provider');
  controller.abort('cancelled');
  releaseLive();
  const [cancelledRejection, live] = await Promise.allSettled([cancelledTurn, liveTurn]);

  // #5632: a cancelled turn must reject instead of resolving a fallback answer.
  assert.equal(cancelledRejection.status, 'rejected', 'a cancelled turn must not resolve');
  assert.equal(cancelledRejection.reason?.type, 'cancelled');
  assert.equal(live.status, 'fulfilled');
  const liveResult = live.value;
  assert.equal(liveResult.answer, 'answer LIVE');
  assert.equal(liveResult.limits.exhausted, false);
  assert.deepEqual(liveResult.evidence.map((item) => item.id), ['live-evidence']);
  assert.deepEqual(liveResult.hypotheses.map((item) => item.id), ['hyp-LIVE']);
  assert.equal(liveResult.hypotheses.some((item) => item.id === 'hyp-CANCELLED'), false);
  assert.equal(storesFor(runtime, liveResult.sessionId).hypothesisStore.all().some((item) => item.id === 'hyp-CANCELLED'), false);
  assert.equal(runtime.activeControllers.size, 0, 'cancellation must release only its controller and leave no leaked bindings');
}

// 3. An agent job slice and an interactive turn may overlap on one runtime.
// The job remains at a provider barrier while the interactive turn completes,
// and each receives only its own namespace state.
{
  let enterJob;
  const jobEntered = new Promise((resolve) => { enterJob = resolve; });
  let releaseJob;
  const jobGate = new Promise((resolve) => { releaseJob = resolve; });
  let enterInteractive;
  const interactiveEntered = new Promise((resolve) => { enterInteractive = resolve; });
  let runtime;

  runtime = new AIRuntime({
    context: binaryContextContext(),
    planner: false,
    provider: {
      async nextTurn(payload) {
        const text = payload.messages.at(-1)?.content || '';
        const isJob = text.includes('job');
        const label = isJob ? 'JOB' : 'INTERACTIVE';
        const stores = storesFor(runtime, payload.sessionId);
        if (isJob) {
          enterJob();
          await jobGate;
        } else {
          enterInteractive();
        }
        const evidenceId = `${label.toLowerCase()}-evidence`;
        stores.evidenceStore.add({ id: evidenceId, kind: 'provider', status: 'supported', title: `${label} evidence`, sourceTool: 'test-provider' });
        const proposal = proposalFor(stores, isJob ? 'A' : 'B', evidenceId);
        return decisionFor(label, { evidenceId, proposalId: proposal.id });
      },
    },
  });

  const job = await runtime.createJob({ jobId: 'job-store-isolation', goal: 'job turn' });
  const jobRun = binaryContext.run({ binaryId: 'job-bin' }, () => runtime.runJobSlice(job.id));
  await waitFor(jobEntered, jobRun, 'job slice did not enter provider');
  const interactiveRun = turnFor(runtime, 'interactive-bin', { mode: 'agent', goal: 'interactive turn' });
  await waitFor(interactiveEntered, interactiveRun, 'interactive turn did not overlap job slice');
  const interactive = await interactiveRun;
  releaseJob();
  const checkpoint = await jobRun;

  assert.equal(checkpoint.status, 'complete');
  assert.deepEqual(checkpoint.evidenceIds, ['job-evidence']);
  assert.deepEqual(checkpoint.hypothesisIds, ['hyp-JOB']);
  assert.deepEqual(interactive.evidence.map((item) => item.id), ['interactive-evidence']);
  assert.deepEqual(interactive.hypotheses.map((item) => item.id), ['hyp-INTERACTIVE']);
  assert.equal(interactive.hypotheses.some((item) => item.id === 'hyp-JOB'), false);
  assert.deepEqual(storesFor(runtime, checkpoint.sessionId).hypothesisStore.all().map((item) => item.id), ['hyp-JOB']);
  assert.deepEqual(storesFor(runtime, interactive.sessionId).hypothesisStore.all().map((item) => item.id), ['hyp-INTERACTIVE']);
}

function binaryContextContext() {
  const context = {};
  Object.defineProperty(context, 'binaryId', {
    enumerable: true,
    get() { return binaryContext.getStore()?.binaryId ?? null; },
  });
  return context;
}

function abortError() {
  const error = new Error('cancelled');
  error.name = 'AbortError';
  return error;
}

console.log('issue #6216 turn-store isolation regressions PASS');
