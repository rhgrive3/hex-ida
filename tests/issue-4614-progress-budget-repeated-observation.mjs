import assert from 'node:assert/strict';
import { DevSupervisorV0 } from '../js/ai/dev/supervisor/dev-supervisor-v0.js';
import { ProgressBudgetDevSupervisorEngineV0 } from '../js/ai/dev/supervisor/dev-supervisor-progress-budget.js';
import { DevAgentUiSettings } from '../js/ai/dev/ui/settings.js';
import { AGENT_PROFILE } from '../js/ai/dev/policy/agent-profile.js';
import { DEV_RUNTIME_IDENTITY_TOOL, DEV_RUNTIME_ACTIVATION_TOOL } from '../js/ai/dev/bootstrap/self-update-gate.js';

const ABSOLUTE_CEILING = 256;

function workerClient() {
  const noop = async (args = {}) => args;
  return {
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
}

function identityDecision(args = {}, purpose = 'same identity again') {
  return { text: JSON.stringify({ type: 'tool', tool: DEV_RUNTIME_IDENTITY_TOOL, arguments: args, purpose }) };
}
function toolDecision(name, args = {}, purpose = 'progress') {
  return { text: JSON.stringify({ type: 'tool', tool: name, arguments: args, purpose }) };
}
function finalDecision(answer = 'done') {
  return { text: JSON.stringify({ type: 'final', answer, completedTasks: [], remaining: [] }) };
}

function createEngine({ maxDecisions, onRequest, identityProvider } = {}) {
  const supervisor = new DevSupervisorV0({
    workerClient: workerClient(),
    idFactory: (kind) => `p4614-${kind}`,
    now: () => '2026-08-18T08:00:00.000Z',
  });
  // Force the engine-owned read-only identity provider path (no parent runtime).
  supervisor.adminTools = null;
  const settings = new DevAgentUiSettings({ storage: { getItem: () => null, setItem() {} } });
  settings.setAgentProfile(AGENT_PROFILE.DEV);
  const bridge = Object.freeze({ request: async (...args) => onRequest(...args) });
  const engine = new ProgressBudgetDevSupervisorEngineV0({
    supervisor, settings, bridge, maxDecisions,
    runtimeIdentityProvider: identityProvider || null,
  });
  return engine;
}

const exhausts = /decision budget exhausted/;

// 1. Repeated identical dev.runtime.identity + identical result must not keep
//    sliding the window forward forever (issue #4614 minimal reproduction).
{
  let requests = 0;
  const engine = createEngine({
    maxDecisions: 2,
    identityProvider: async () => ({ commit: 'a'.repeat(40), buildId: 'b'.repeat(24) }),
    onRequest: async () => (++requests <= 8 ? identityDecision() : finalDecision()),
  });
  await assert.rejects(
    engine.run({ goal: 'loop identity', conversationId: 'c-identity' }),
    exhausts,
    'identical read-only identity observations must not replenish the budget indefinitely',
  );
  assert.ok(requests <= 4, `identity loop must be bounded, saw ${requests} requests`);
}

// 2. Repeated successful worker.observe (generic read tool) must be bounded by
//    the absolute ceiling rather than running without a stopping point.
{
  let requests = 0;
  let peak = 0;
  const engine = createEngine({
    maxDecisions: 2,
    onRequest: async () => {
      peak = Math.max(peak, engine.maxDecisions);
      return ++requests <= 400 ? toolDecision('worker.observe') : finalDecision();
    },
  });
  await assert.rejects(
    engine.run({ goal: 'loop observe', conversationId: 'c-observe' }),
    exhausts,
    'repeated successful observation must hit the absolute decision ceiling',
  );
  assert.ok(requests <= ABSOLUTE_CEILING, `observe loop must be bounded by the ceiling, saw ${requests}`);
  assert.ok(peak <= ABSOLUTE_CEILING, `maxDecisions must never exceed the ceiling, saw ${peak}`);
}

// 3. Genuine progress still earns a fresh window: identical successful worker
//    actions continue the #780 contract, and identity observations whose
//    fingerprint actually changes keep replenishing the budget.
{
  let requests = 0;
  const engine = createEngine({
    maxDecisions: 2,
    onRequest: async () => (++requests <= 5 ? toolDecision('worker.discover') : finalDecision()),
  });
  const result = await engine.run({ goal: 'real progress', conversationId: 'c-discover' });
  assert.equal(result.answer, 'done');
  assert.equal(requests, 6, 'successful worker progress must still outlive the original two-decision window');
}
{
  let requests = 0;
  let seq = 0;
  const engine = createEngine({
    maxDecisions: 2,
    identityProvider: async () => ({ commit: 'a'.repeat(40), buildId: String(++seq).padStart(24, '0') }),
    onRequest: async () => (++requests <= 5 ? identityDecision({}, `fresh-${seq}`) : finalDecision()),
  });
  const result = await engine.run({ goal: 'changing identity', conversationId: 'c-identity-fresh' });
  assert.equal(result.answer, 'done');
  assert.equal(requests, 6, 'identity observations with a new fingerprint must still be treated as progress');
}

// 4. Repeated identical dev.runtime.require_activation control re-declaration
//    must not extend the window (succeeds but does not advance).
{
  let requests = 0;
  const engine = createEngine({
    maxDecisions: 2,
    onRequest: async () => (++requests <= 8 ? toolDecision(DEV_RUNTIME_ACTIVATION_TOOL, { expectedCommit: 'a'.repeat(40), expectedBuildId: 'b'.repeat(24) }) : finalDecision()),
  });
  await assert.rejects(
    engine.run({ goal: 'redeclare activation', conversationId: 'c-activation' }),
    exhausts,
    'a control call that succeeds without changing state must not be progress',
  );
  assert.ok(requests <= 4, `activation re-declaration must be bounded, saw ${requests} requests`);
}

// 5. Existing no-progress contract holds: unavailable and invalid decisions do
//    not replenish the window.
{
  let requests = 0;
  const engine = createEngine({
    maxDecisions: 2,
    onRequest: async () => (++requests <= 8 ? toolDecision('worker.not-a-real-tool') : finalDecision()),
  });
  await assert.rejects(engine.run({ goal: 'unavailable tool', conversationId: 'c-unavailable' }), exhausts);
  assert.equal(requests, 2, 'unavailable tools remain bounded by the original window');
}
{
  let requests = 0;
  const engine = createEngine({
    maxDecisions: 2,
    onRequest: async () => (++requests <= 8 ? { text: 'not json at all' } : finalDecision()),
  });
  await assert.rejects(engine.run({ goal: 'invalid decision', conversationId: 'c-invalid' }), exhausts);
  assert.equal(requests, 2, 'invalid decisions remain bounded by the original window');
}

// 6. final / human transitions and engine reuse after an exhausted run are intact.
{
  const engine = createEngine({ maxDecisions: 2, onRequest: async () => finalDecision('clean finish') });
  const result = await engine.run({ goal: 'finish', conversationId: 'c-final' });
  assert.equal(result.answer, 'clean finish');
  assert.deepEqual({ active: engine.progressRunActive, count: engine.progressDecisionCount, limit: engine.maxDecisions }, { active: false, count: 0, limit: 2 });
}
{
  let requests = 0;
  const engine = createEngine({
    maxDecisions: 2,
    onRequest: async () => {
      if (++requests === 1) return { text: JSON.stringify({ type: 'human', question: 'which tab?', blocking: true }) };
      return { text: JSON.stringify({ type: 'human', question: 'still waiting?', blocking: true }) };
    },
  });
  const result = await engine.run({ goal: 'ask human', conversationId: 'c-human' });
  assert.equal(result.answer, 'which tab?');
}
{
  // A prior exhausted run must fully reset the budget + observation fingerprints.
  let requests = 0;
  let looping = true;
  const engine = createEngine({
    maxDecisions: 2,
    identityProvider: async () => ({ commit: 'a'.repeat(40), buildId: 'b'.repeat(24) }),
    onRequest: async () => (looping && ++requests <= 8 ? identityDecision() : finalDecision('reused')),
  });
  await assert.rejects(engine.run({ goal: 'exhaust first', conversationId: 'c-exhaust' }), exhausts);
  looping = false;
  const recovered = await engine.run({ goal: 'reuse engine', conversationId: 'c-reuse' });
  assert.equal(recovered.answer, 'reused');
  assert.equal(requests, 3, 'exhausted identity loop must stop at a bounded count and reset for reuse');
}

console.log('issue #4614 progress-budget repeated observation regressions PASS');
