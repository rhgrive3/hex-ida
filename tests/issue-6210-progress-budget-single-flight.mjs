// Regression for #6210: ProgressBudgetDevSupervisorEngineV0 kept run-scoped
// decision-budget state (progressDecisionCount, progressRunActive, and the
// base engine's mutable maxDecisions loop bound) on shared instance fields
// with no concurrency guard, so an overlapping run() could reset another
// run's counter, roll back its progress-extended window, and poison its
// finally-cleanup. The engine is now explicitly single-flight: concurrent
// run() callers queue in arrival order, each starting with pristine state.
import assert from 'node:assert/strict';
import { DevSupervisorV0 } from '../js/ai/dev/supervisor/dev-supervisor-v0.js';
import { ProgressBudgetDevSupervisorEngineV0 } from '../js/ai/dev/supervisor/dev-supervisor-progress-budget.js';
import { DevAgentUiSettings } from '../js/ai/dev/ui/settings.js';
import { AGENT_PROFILE } from '../js/ai/dev/policy/agent-profile.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function buildEngine(bridge, maxDecisions) {
  const client = { async getTabs() { return [{ tabNodeId: 'same-tab' }]; }, async connect() { return null; } };
  const supervisor = new DevSupervisorV0({
    workerClient: client,
    idFactory: (kind) => `flight-${kind}`,
    now: () => '2026-09-08T00:00:00.000Z',
  });
  const storage = { getItem: () => null, setItem() {} };
  const settings = new DevAgentUiSettings({ storage });
  settings.setAgentProfile(AGENT_PROFILE.DEV);
  return new ProgressBudgetDevSupervisorEngineV0({ supervisor, settings, bridge, maxDecisions });
}

await concurrentRunsAreSingleFlight();
console.log('issue #6210 progress budget single-flight: PASS');

async function concurrentRunsAreSingleFlight() {
  const requests = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let releaseFirstRequest;
  const firstRequestGated = new Promise((resolve) => { releaseFirstRequest = resolve; });
  let requestCount = 0;
  const bridge = Object.freeze({
    async request(_prompt, options = {}) {
      requestCount += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      requests.push(options.sessionKey);
      try {
        if (requestCount === 1) await firstRequestGated;
        return { text: JSON.stringify({ type: 'final', answer: `done-${requestCount}`, completedTasks: ['single-flight'], remaining: [] }) };
      } finally {
        inFlight -= 1;
      }
    },
  });

  const engine = buildEngine(bridge, 2);

  const runA = engine.run({ goal: 'run A', conversationId: 'hex-6210-a' });
  await sleep(20);
  assert.equal(requestCount, 1, 'run A starts and issues its first decision request');

  const runB = engine.run({ goal: 'run B', conversationId: 'hex-6210-b' });
  await sleep(20);
  await sleep(20);
  await sleep(20);
  assert.equal(requestCount, 1, 'run B must not start while run A is still executing (single-flight)');
  assert.equal(maxInFlight, 1, 'bridge requests from the two runs must never overlap');

  releaseFirstRequest();
  const [resultA, resultB] = await Promise.all([runA, runB]);
  assert.equal(resultA.answer, 'done-1', 'run A keeps its queued position and answers from its own request');
  assert.equal(resultB.answer, 'done-2', 'run B executes only after run A fully completes');
  assert.equal(requests.length, 2);
  assert.equal(maxInFlight, 1);

  // A later run still gets a pristine budget and the progress extension works.
  const runC = await engine.run({ goal: 'run C', conversationId: 'hex-6210-c' });
  assert.ok(runC.answer, 'a run after the serialized batch completes normally');
}
