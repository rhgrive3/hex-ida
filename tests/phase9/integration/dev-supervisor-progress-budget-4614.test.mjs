import test from 'node:test';
import assert from 'node:assert/strict';
import { DevSupervisorV0 } from '../../../js/ai/dev/supervisor/dev-supervisor-v0.js';
import { ProgressBudgetDevSupervisorEngineV0 } from '../../../js/ai/dev/supervisor/dev-supervisor-progress-budget.js';
import { DevAgentUiSettings } from '../../../js/ai/dev/ui/settings.js';
import { AGENT_PROFILE } from '../../../js/ai/dev/policy/agent-profile.js';
import { DEV_RUN_STATUS } from '../../../js/ai/dev/run/dev-run.js';

const asText = (decision) => ({ text: JSON.stringify(decision) });
const finalText = () => asText({ type: 'final', answer: 'done', completedTasks: [], remaining: [] });
const identityDecision = () => ({ type: 'tool', tool: 'dev.runtime.identity', arguments: {}, purpose: 'same identity observation' });
const observeDecision = () => ({ type: 'tool', tool: 'worker.observe', arguments: {}, purpose: 'same observation' });
const BRIDGE_SAFETY_FINAL_AT = 320;

function create(onRequest, { maxDecisions = 2 } = {}) {
  const noop = async (args = {}) => args;
  const workerClient = {
    enabled: true,
    discover: async () => [{ tabNodeId: 'same-tab' }],
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
  const supervisor = new DevSupervisorV0({
    workerClient,
    idFactory: (kind) => `budget-4614-${kind}`,
    now: () => '2026-08-18T08:00:00.000Z',
  });
  const settings = new DevAgentUiSettings({ storage: { getItem: () => null, setItem() {} } });
  settings.setAgentProfile(AGENT_PROFILE.DEV);
  let calls = 0;
  const bridge = Object.freeze({
    request: async () => {
      calls += 1;
      return onRequest(calls);
    },
  });
  const engine = new ProgressBudgetDevSupervisorEngineV0({
    supervisor,
    settings,
    bridge,
    maxDecisions,
    runtimeIdentityProvider: async () => ({ commit: 'a'.repeat(40), buildId: 'b'.repeat(24) }),
  });
  return { engine, settings, callCount: () => calls };
}

test('#4614 identical dev.runtime.identity repetition cannot extend the decision budget indefinitely', { timeout: 10000 }, async () => {
  const { engine, settings, callCount } = create((n) => (n < BRIDGE_SAFETY_FINAL_AT ? asText(identityDecision()) : finalText()));
  await assert.rejects(
    engine.run({ goal: 'identity loop', conversationId: 'budget-4614-identity' }),
    /Dev Supervisor decision budget exhausted/,
  );
  assert.ok(
    callCount() <= engine.progressDecisionCeiling + 1,
    `identical identity observations must stop at the absolute ceiling, got ${callCount()}`,
  );
  assert.equal(settings.lastRun.status, DEV_RUN_STATUS.FAILED);
  assert.equal(engine.progressRunActive, false);
  assert.equal(engine.maxDecisions, 2);
});

test('#4614 identical worker.observe repetition stays bounded by the absolute ceiling', { timeout: 10000 }, async () => {
  const { engine, callCount } = create((n) => (n < BRIDGE_SAFETY_FINAL_AT ? asText(observeDecision()) : finalText()));
  await assert.rejects(
    engine.run({ goal: 'observe loop', conversationId: 'budget-4614-observe' }),
    /Dev Supervisor decision budget exhausted/,
  );
  assert.ok(
    callCount() <= engine.progressDecisionCeiling + 1,
    `identical observations must stop at the absolute ceiling, got ${callCount()}`,
  );
});

test('#4614 the absolute ceiling never shrinks below the base hard maximum', () => {
  for (const maxDecisions of [1, 2, 16, 256]) {
    const { engine } = create(() => finalText(), { maxDecisions });
    assert.equal(engine.progressDecisionCeiling, 256);
    assert.ok(engine.progressDecisionCeiling >= engine.progressDecisionWindow);
  }
});

test('#4614 meaningful successful progress still replenishes the window inside the ceiling', { timeout: 10000 }, async () => {
  const { engine, callCount } = create((n) => (n <= 5
    ? asText({ type: 'tool', tool: 'worker.discover', arguments: {}, purpose: `progress ${n}` })
    : finalText()));
  const result = await engine.run({ goal: 'real progress', conversationId: 'budget-4614-progress' });
  assert.equal(result.answer, 'done');
  assert.equal(callCount(), 6);
  assert.equal(engine.progressRunActive, false);
  assert.equal(engine.maxDecisions, 2);
});
