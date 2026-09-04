import assert from 'node:assert/strict';
import { DevSupervisorV0 } from '../js/ai/dev/supervisor/dev-supervisor-v0.js';
import { ProgressBudgetDevSupervisorEngineV0 } from '../js/ai/dev/supervisor/dev-supervisor-progress-budget.js';
import { DevAgentUiSettings } from '../js/ai/dev/ui/settings.js';
import { AGENT_PROFILE } from '../js/ai/dev/policy/agent-profile.js';

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

  let firstStarted = false;
  const engine = createEngine({
    maxDecisions: 4,
    async onRequest() {
      firstStarted = true;
      await firstGate;
      return { text: JSON.stringify({ type: 'final', answer: 'first done', completedTasks: [], remaining: [] }) };
    },
  });

  const firstPromise = engine.run({ goal: 'run 1', conversationId: 'c-first' });

  // Wait until first run is active
  while (!firstStarted) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(engine.progressRunActive, true);

  // Attempting concurrent second run must throw
  await assert.rejects(
    async () => {
      await engine.run({ goal: 'run 2', conversationId: 'c-second' });
    },
    {
      name: 'Error',
      message: 'DevSupervisorEngine run is already in progress',
    },
  );

  // Verify first run's state was not overwritten by rejected run
  assert.equal(engine.progressRunActive, true);

  // Unblock first run and ensure it completes cleanly
  unblockFirst();
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

console.log('issue #6210 progress-budget concurrent runs regressions PASS');
