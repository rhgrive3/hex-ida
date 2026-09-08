import test from 'node:test';
import assert from 'node:assert/strict';
import { DevSupervisorV0 } from '../../../js/ai/dev/supervisor/dev-supervisor-v0.js';
import { ProgressBudgetDevSupervisorEngineV0 } from '../../../js/ai/dev/supervisor/dev-supervisor-progress-budget.js';
import { DevAgentUiSettings } from '../../../js/ai/dev/ui/settings.js';
import { createAgentProfileEngine } from '../../../js/ai/dev/ui/engine-router.js';
import { AGENT_PROFILE } from '../../../js/ai/dev/policy/agent-profile.js';
import { DEV_BOOTSTRAP_ROUND4_PROOF_CAPABILITY } from '../../../js/ai/dev/bootstrap/dev-bootstrap-gate.js';

const identity = { commit: 'a'.repeat(40), buildId: 'b'.repeat(24) };
const final = () => ({ text: JSON.stringify({ type: 'final', answer: 'done', completedTasks: [], remaining: [] }) });
const tool = (name) => ({ text: JSON.stringify({ type: 'tool', tool: name, arguments: {}, purpose: 'progress-window regression' }) });
const busy = { name: 'Error', message: 'DevSupervisorEngine run is already in progress' };
const state = (engine) => ({ active: engine.progressRunActive, count: engine.progressDecisionCount, limit: engine.maxDecisions });
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function create(onRequest) {
  const noop = async (args = {}) => args;
  const workerClient = {
    enabled: true, discover: async () => [{ tabNodeId: 'same-tab' }],
    claim: noop, createChat: noop, send: noop, observe: noop, followup: noop,
    nudge: noop, stop: noop, result: noop, release: noop,
    waitEvent: async () => ({ type: 'worker.completed', data: {}, observedAt: '2026-08-18T08:00:00.000Z' }),
  };
  let nextId = 0;
  const supervisor = new DevSupervisorV0({
    workerClient, idFactory: (kind) => `window-${kind}-${++nextId}`,
    now: () => '2026-08-18T08:00:00.000Z',
  });
  const settings = new DevAgentUiSettings({ storage: { getItem: () => null, setItem() {} } });
  settings.setAgentProfile(AGENT_PROFILE.DEV);
  const bridge = Object.freeze({ request: onRequest });
  const engine = new ProgressBudgetDevSupervisorEngineV0({ supervisor, settings, bridge, maxDecisions: 2 });
  const router = createAgentProfileEngine({
    standardEngine: { run() { assert.fail('Dev request must not use the standard engine'); } },
    settings, supervisor, devEngine: engine,
  });
  return { engine, router };
}

test('#6210 successful tools repeatedly replenish the frozen-bridge progress window', { timeout: 5000 }, async () => {
  let requests = 0;
  const { engine, router } = create(async () => ++requests <= 5 ? tool('worker.discover') : final());
  const result = await router.run({ mode: 'agent', goal: 'keep making progress', conversationId: 'window-positive' });
  assert.equal(result.answer, 'done');
  assert.equal(requests, 6, 'five successful tools must outlive the original two-decision window');
  assert.deepEqual(state(engine), { active: false, count: 0, limit: 2 });
});

for (const firstKind of ['normal', 'proof']) {
  test(`#6210 normal/proof overlap cannot reset an extended ${firstKind} run`, { timeout: 5000 }, async () => {
    const paused = deferred();
    const release = deferred();
    let requests = 0;
    const { engine, router } = create(async () => {
      requests++;
      if (requests === 1) return tool(firstKind === 'proof' ? DEV_BOOTSTRAP_ROUND4_PROOF_CAPABILITY : 'worker.discover');
      if (requests === 2) { paused.resolve(); await release.promise; }
      return final(); // A missing single-flight guard must fail promptly, not deadlock.
    });
    const checkpoint = router.devBootstrap.createCheckpoint({
      conversationId: 'window-proof', chatgptConversationId: 'chatgpt-window-proof', activeIdentity: identity,
    });
    const handoff = { checkpoint };
    if (firstKind === 'proof') {
      await router.devBootstrap.prepare();
      assert.equal(router.devBootstrap.activateAtSafeBoundary({ checkpoint, activeIdentity: identity, reinitialized: true }).status, 'active');
    }
    const active = firstKind === 'proof'
      ? router.devBootstrap.runProof({ handoff })
      : router.run({ mode: 'agent', goal: 'ordinary active run', conversationId: 'window-normal' });
    try {
      await Promise.race([
        paused.promise,
        active.then(() => { throw new Error('active run ended before the budget checkpoint'); }),
      ]);
      const extended = state(engine);
      assert.deepEqual(extended, { active: true, count: 1, limit: 3 });
      await assert.rejects(router.run({ mode: 'agent', goal: 'overlap', conversationId: 'window-overlap' }), busy);
      assert.deepEqual(state(engine), extended, 'normal overlap must not reset counters or run the active finally');
      await assert.rejects(Promise.resolve().then(() => router.devBootstrap.runProof({ handoff })), busy);
      assert.deepEqual(state(engine), extended, 'bootstrap overlap must use the same guard');
      assert.equal(requests, 2, 'rejected runs must not send a bridge request or mix response counts');
      release.resolve();
      assert.equal((await active).answer, 'done');
      assert.deepEqual(state(engine), { active: false, count: 0, limit: 2 });
      const recovered = await router.run({ mode: 'agent', goal: 'reuse', conversationId: 'window-reuse' });
      assert.equal(recovered.answer, 'done');
      assert.equal(requests, 3);
    } finally {
      release.resolve();
      await active.catch(() => {});
    }
  });
}

test('#6210 cancellation releases the same engine without granting a progress window', { timeout: 5000 }, async () => {
  const started = deferred();
  let requests = 0;
  const controller = new AbortController();
  const reason = Object.assign(new Error('cancel test run'), { name: 'AbortError' });
  const { engine, router } = create(async (_prompt, options = {}) => {
    if (++requests > 1) return final();
    const { signal } = options;
    assert.ok(signal, 'the real run must propagate its signal to the bridge');
    return new Promise((resolve, reject) => {
      const onAbort = () => { signal.removeEventListener('abort', onAbort); reject(signal.reason); };
      signal.addEventListener('abort', onAbort, { once: true });
      started.resolve();
      if (signal.aborted) onAbort();
    });
  });
  const active = router.run({ mode: 'agent', goal: 'cancel', conversationId: 'window-cancel', signal: controller.signal });
  try {
    await Promise.race([started.promise, active.then(() => { throw new Error('run ended before bridge cancellation'); })]);
    controller.abort(reason);
    await assert.rejects(active, (error) => error === reason);
    assert.deepEqual(state(engine), { active: false, count: 0, limit: 2 });
    assert.equal((await router.run({ mode: 'agent', goal: 'recover', conversationId: 'window-cancel-reuse' })).answer, 'done');
    assert.equal(requests, 2);
    assert.deepEqual(state(engine), { active: false, count: 0, limit: 2 });
  } finally {
    controller.abort(reason);
    await active.catch(() => {});
  }
});
