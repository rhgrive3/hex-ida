import assert from 'node:assert/strict';
import { DevSupervisorV0 } from '../js/ai/dev/supervisor/dev-supervisor-v0.js';
import { ProgressBudgetDevSupervisorEngineV0 } from '../js/ai/dev/supervisor/dev-supervisor-progress-budget.js';
import { DevAgentUiSettings } from '../js/ai/dev/ui/settings.js';
import { AGENT_PROFILE } from '../js/ai/dev/policy/agent-profile.js';
import { createAgentProfileEngine } from '../js/ai/dev/ui/engine-router.js';
import { DEV_BOOTSTRAP_ROUND4_PROOF_CAPABILITY } from '../js/ai/dev/bootstrap/dev-bootstrap-gate.js';

function workerClient(discover) {
  const noop = async (args = {}) => args;
  return {
    enabled: true,
    discover: discover || (async () => [{ tabNodeId: 'same-tab' }]),
    claim: noop,
    createChat: noop,
    send: noop,
    observe: noop,
    followup: noop,
    nudge: noop,
    stop: noop,
    result: noop,
    release: noop,
    waitEvent: async () => ({ type: 'worker.completed', data: {}, observedAt: '2026-08-18T08:00:00.000Z' }),
  };
}

function createEngine({ maxDecisions = 3, onRequest } = {}) {
  const client = workerClient();
  const supervisor = new DevSupervisorV0({
    workerClient: client,
    idFactory: (kind) => `test-${kind}`,
    now: () => '2026-08-18T08:00:00.000Z',
  });
  const storage = { getItem: () => null, setItem() {} };
  const settings = new DevAgentUiSettings({ storage });
  settings.setAgentProfile(AGENT_PROFILE.DEV);

  const bridge = Object.freeze({
    async request(prompt, options = {}) {
      if (onRequest) return await onRequest(prompt, options);
      return { text: JSON.stringify({ type: 'final', answer: 'ok', completedTasks: [], remaining: [] }) };
    },
  });

  return new ProgressBudgetDevSupervisorEngineV0({ supervisor, settings, bridge, maxDecisions });
}

// 1. Single run works normally and resets budget
{
  const engine = createEngine({ maxDecisions: 2 });
  const res = await engine.run({ goal: 'single run', conversationId: 'c1' });
  assert.equal(res.answer, 'ok');
  assert.equal(engine.progressRunActive, false);
  assert.equal(engine.progressDecisionCount, 0);
  assert.equal(engine.maxDecisions, 2);
}

// 2. Concurrent run is rejected and does not corrupt active run's state
{
  let unblockFirst;
  const firstGate = new Promise((resolve) => { unblockFirst = resolve; });

  let requestCount = 0;
  let signalFirstStarted;
  const firstStarted = new Promise((resolve) => { signalFirstStarted = resolve; });
  const engine = createEngine({
    maxDecisions: 4,
    async onRequest() {
      requestCount += 1;
      if (requestCount === 1) {
        signalFirstStarted();
        await firstGate;
      }
      return { text: JSON.stringify({ type: 'final', answer: 'first done', completedTasks: [], remaining: [] }) };
    },
  });

  const firstPromise = engine.run({ goal: 'run 1', conversationId: 'c-first' });

  try {
    // Race startup against early completion/failure instead of polling forever.
    await waitForRequest(firstStarted, firstPromise);
    assert.equal(engine.progressRunActive, true);
    await assert.rejects(
      engine.run({ goal: 'run 2', conversationId: 'c-second' }),
      { name: 'Error', message: 'DevSupervisorEngine run is already in progress' },
    );
    assert.equal(engine.progressRunActive, true);
  } finally {
    unblockFirst();
    await firstPromise.catch(() => {});
  }
  const firstResult = await firstPromise;
  assert.equal(firstResult.answer, 'first done');
  assert.equal(engine.progressRunActive, false);

  // After first run completes, another run can succeed cleanly
  const afterResult = await engine.run({ goal: 'run after', conversationId: 'c-after' });
  assert.equal(afterResult.answer, 'first done');
  assert.equal(engine.progressRunActive, false);
  assert.equal(engine.progressDecisionCount, 0);
  assert.equal(engine.maxDecisions, 4);
}

// 3. A failed run releases the same engine for a later successful run
{
  let requestCount = 0;
  const engine = createEngine({
    maxDecisions: 2,
    async onRequest() {
      requestCount += 1;
      if (requestCount === 1) throw new Error('bridge boom');
      return { text: JSON.stringify({ type: 'final', answer: 'recovered', completedTasks: [], remaining: [] }) };
    },
  });

  await assert.rejects(
    async () => {
      await engine.run({ goal: 'failing run', conversationId: 'c-fail' });
    },
    /bridge boom/,
  );

  assert.equal(engine.progressRunActive, false);
  assert.equal(engine.progressDecisionCount, 0);
  assert.equal(engine.maxDecisions, 2);

  const recovered = await engine.run({ goal: 'subsequent run', conversationId: 'c-recovered' });
  assert.equal(recovered.answer, 'recovered');
  assert.equal(requestCount, 2);
  assert.equal(engine.progressRunActive, false);
  assert.equal(engine.progressDecisionCount, 0);
  assert.equal(engine.maxDecisions, 2);
}

/** Reject an early run termination instead of hanging on an unobserved request. */
async function waitForRequest(entered, running) {
  await Promise.race([
    entered,
    running.then(() => { throw new Error('run completed before the request barrier'); }),
  ]);
}

// 4. Actual successful tools extend the budget beyond its initial window;
// a rejected overlap must not reset the extension, counters, or active run.
{
  let enter;
  let release;
  const entered = new Promise((resolve) => { enter = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  let requests = 0;
  const engine = createEngine({
    maxDecisions: 2,
    async onRequest() {
      const request = ++requests;
      if (request <= 3) return { text: JSON.stringify({
        type: 'tool', tool: 'worker.discover', arguments: {}, purpose: 'verified progress',
      }) };
      if (request === 4) { enter(); await gate; }
      return { text: JSON.stringify({ type: 'final', answer: 'progress done', completedTasks: [], remaining: [] }) };
    },
  });
  const running = engine.run({ goal: 'extend budget', conversationId: 'progress-owner' });
  try {
    await waitForRequest(entered, running);
    assert.equal(engine.progressDecisionCount, 3);
    assert.equal(engine.maxDecisions, 5);
    const activeRun = engine.settings.lastRun;
    await assert.rejects(engine.run({ goal: 'overlap', conversationId: 'rejected' }), /already in progress/);
    assert.equal(requests, 4, 'rejected run must not call the bridge');
    assert.equal(engine.settings.lastRun, activeRun);
    assert.equal(engine.progressRunActive, true);
    assert.equal(engine.progressDecisionCount, 3);
    assert.equal(engine.maxDecisions, 5, 'rejected run must not roll back the extended limit');
  } finally {
    release();
    await running.catch(() => {});
  }
  assert.equal((await running).answer, 'progress done');
  assert.equal(engine.progressRunActive, false);
  assert.equal(engine.progressDecisionCount, 0);
  assert.equal(engine.maxDecisions, 2);
}

// 5. The production facade's bootstrap proof and ordinary run share the same
// single-flight guard in both directions; neither can reset the other's run.
for (const first of ['ordinary', 'proof']) {
  let enter;
  let release;
  const entered = new Promise((resolve) => { enter = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  let requests = 0;
  const engine = createEngine({
    maxDecisions: 2,
    async onRequest() {
      const request = ++requests;
      if (request === 1) { enter(); await gate; }
      const decision = first === 'proof' && request === 1
        ? { type: 'tool', tool: DEV_BOOTSTRAP_ROUND4_PROOF_CAPABILITY, arguments: {}, purpose: 'verify bootstrap' }
        : { type: 'final', answer: 'done', completedTasks: [], remaining: [] };
      return { text: JSON.stringify(decision) };
    },
  });
  const router = createAgentProfileEngine({
    standardEngine: { run() { throw new Error('unexpected standard engine'); } },
    settings: engine.settings,
    devEngine: engine,
  });
  const identity = { commit: 'a'.repeat(40), buildId: 'b'.repeat(24) };
  await router.devBootstrap.prepare();
  const checkpoint = router.devBootstrap.createCheckpoint({
    conversationId: 'proof-owner', chatgptConversationId: 'proof-chat', activeIdentity: identity,
  });
  assert.equal(router.devBootstrap.activateAtSafeBoundary({
    checkpoint, activeIdentity: identity, reinitialized: true,
  }).status, 'active');
  const ordinary = () => router.run({ mode: 'agent', goal: 'ordinary run', conversationId: 'ordinary-owner' });
  const proof = () => router.devBootstrap.runProof({ handoff: { checkpoint } });
  const running = first === 'ordinary' ? ordinary() : proof();
  try {
    await waitForRequest(entered, running);
    const activeRun = engine.settings.lastRun;
    await assert.rejects(first === 'ordinary' ? proof() : ordinary(), /already in progress/);
    assert.equal(engine.settings.lastRun, activeRun);
    assert.equal(engine.progressRunActive, true);
    assert.equal(engine.progressDecisionCount, 0);
    assert.equal(engine.maxDecisions, 2);
    assert.equal(requests, 1);
  } finally {
    release();
    await running.catch(() => {});
  }
  assert.equal((await running).answer, 'done');
  assert.equal(requests, first === 'proof' ? 2 : 1);
  assert.equal(engine.progressRunActive, false);
  assert.equal(engine.progressDecisionCount, 0);
  assert.equal(engine.maxDecisions, 2);
  assert.equal((await ordinary()).answer, 'done', 'same engine remains usable after either entry path');
}

console.log('issue #6210 progress-budget concurrent runs regressions PASS');
