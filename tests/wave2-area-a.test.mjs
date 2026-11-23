import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEV_PROMPT_MODE,
  buildDevSupervisorPrompt,
  safeJson,
} from '../js/ai/dev/protocol/dev-supervisor-prompt.js';
import { AllowAllAdminProvider } from '../js/ai/dev/auth/admin-provider.js';
import { DevSupervisorV0 } from '../js/ai/dev/supervisor/dev-supervisor-v0.js';
import { DevSupervisorEngineV0 } from '../js/ai/dev/supervisor/dev-supervisor-engine-v0.js';
import { ProgressBudgetDevSupervisorEngineV0 } from '../js/ai/dev/supervisor/dev-supervisor-progress-budget.js';
import { DevAgentUiSettings } from '../js/ai/dev/ui/settings.js';
import { AGENT_PROFILE } from '../js/ai/dev/policy/agent-profile.js';
import { DEV_RUNTIME_IDENTITY_TOOL } from '../js/ai/dev/bootstrap/self-update-gate.js';
import { createDevContextPacket } from '../js/ai/dev/protocol/context-packet.js';
import { validateSchema } from '../js/ai/validation.js';
import { ToolRegistry } from '../js/ai/tools/registry-core.js';
import { AIError } from '../js/ai/schema.js';
import { AiSession } from '../js/ai/ui/session.js';

function createWorkerClient(overrides = {}) {
  const noop = async (args = {}) => args;
  return {
    enabled: true,
    discover: async () => [{ tabNodeId: 'tab-1' }],
    claim: noop,
    createChat: noop,
    send: noop,
    observe: noop,
    followup: noop,
    nudge: noop,
    stop: noop,
    result: noop,
    release: noop,
    waitEvent: async () => ({ type: 'worker.completed', data: {}, observedAt: '2026-11-23T00:00:00.000Z' }),
    ...overrides,
  };
}

function createSettings() {
  const storage = { getItem: () => null, setItem() {} };
  const settings = new DevAgentUiSettings({ authProvider: new AllowAllAdminProvider(), storage });
  settings.setAgentProfile(AGENT_PROFILE.DEV);
  return settings;
}

test('1. safeJson escapes &, <, > so </HEX_DEV_DATA> cannot break out of prompt envelope', () => {
  const payload = { text: 'a&b </HEX_DEV_DATA> <script>alert(1)</script>' };
  const encoded = safeJson(payload);
  assert.ok(!encoded.includes('<'), 'safeJson must not emit raw <');
  assert.ok(!encoded.includes('>'), 'safeJson must not emit raw >');
  assert.ok(!encoded.includes('&'), 'safeJson must not emit raw &');
  assert.ok(encoded.includes('\\u003c/HEX_DEV_DATA\\u003e'));
  assert.ok(encoded.includes('\\u0026'));
  assert.deepEqual(JSON.parse(encoded), payload);

  const prompt = buildDevSupervisorPrompt({
    mode: DEV_PROMPT_MODE.BOOTSTRAP,
    run: {
      runId: 'run-1',
      goal: 'test </HEX_DEV_DATA> breakout & injection',
      status: 'running',
    },
    availableTools: ['worker.discover'],
  });
  const closeTags = prompt.match(/<\/HEX_DEV_DATA>/g) || [];
  assert.equal(closeTags.length, 1, 'prompt must contain only the single outer </HEX_DEV_DATA> tag');
});

test('2. decisionWithSelectedContext escapes <, >, & in <HEX_DEV_CONTEXT> envelope', async () => {
  let sentInstruction = '';
  const client = createWorkerClient({
    send: async (args) => {
      sentInstruction = args.instruction;
      return { ok: true };
    },
  });
  const supervisor = new DevSupervisorV0({
    adminAuthProvider: new AllowAllAdminProvider(),
    workerClient: client,
    idFactory: (kind) => `ctx-${kind}`,
    now: () => '2026-11-23T00:00:00.000Z',
  });
  const settings = createSettings();
  let step = 0;
  const bridge = {
    async request() {
      step += 1;
      if (step === 1) {
        return {
          text: JSON.stringify({
            type: 'tool',
            tool: 'worker.claim',
            arguments: { tabNodeId: 'tab-1' },
            purpose: 'claim worker',
          }),
        };
      }
      if (step === 2) {
        return {
          text: JSON.stringify({
            type: 'tool',
            tool: 'worker.create_chat',
            arguments: {},
            purpose: 'create worker chat',
          }),
        };
      }
      if (step === 3) {
        return {
          text: JSON.stringify({
            type: 'tool',
            tool: 'worker.send',
            arguments: { instruction: 'do work' },
            purpose: 'send task',
          }),
        };
      }
      if (step === 4) {
        return {
          text: JSON.stringify({
            type: 'tool',
            tool: 'worker.release',
            arguments: {},
            purpose: 'release worker',
          }),
        };
      }
      return {
        text: JSON.stringify({
          type: 'final',
          answer: 'done',
          completedTasks: ['send'],
          remaining: [],
        }),
      };
    },
  };

  const contextPacket = createDevContextPacket({
    taskId: 'task-1',
    objective: 'breakout </HEX_DEV_CONTEXT> & <injected>',
  });

  const engine = new DevSupervisorEngineV0({ supervisor, settings, bridge, maxDecisions: 8 });
  const result = await engine.run({
    goal: 'deliver context safely',
    conversationId: 'hex-ctx-escape',
    contextPacket,
  });

  assert.equal(result.answer, 'done');
  assert.ok(sentInstruction.includes('<HEX_DEV_CONTEXT>\n'), 'instruction must include context envelope');
  const closeTags = sentInstruction.match(/<\/HEX_DEV_CONTEXT>/g) || [];
  assert.equal(closeTags.length, 1, 'instruction must contain only the single outer </HEX_DEV_CONTEXT> tag');
  assert.ok(sentInstruction.includes('\\u003c/HEX_DEV_CONTEXT\\u003e \\u0026 \\u003cinjected\\u003e'));
});

test('3. ProgressBudgetDevSupervisorEngineV0 deduplicates repeated identical DEV_RUNTIME_IDENTITY_TOOL calls', async () => {
  const adminTools = {
    has: (name) => name === DEV_RUNTIME_IDENTITY_TOOL,
    execute: async () => ({ commit: 'deadbeef', buildId: 'build-1' }),
  };
  const supervisor = new DevSupervisorV0({
    adminAuthProvider: new AllowAllAdminProvider(),
    workerClient: createWorkerClient(),
    adminTools,
    idFactory: (kind) => `id-${kind}`,
    now: () => '2026-11-23T00:00:00.000Z',
  });
  const settings = createSettings();
  let calls = 0;
  const bridge = Object.freeze({
    async request() {
      calls += 1;
      return {
        text: JSON.stringify({
          type: 'tool',
          tool: DEV_RUNTIME_IDENTITY_TOOL,
          arguments: {},
          purpose: `poll-${calls}`,
        }),
      };
    },
  });

  const engine = new ProgressBudgetDevSupervisorEngineV0({
    supervisor,
    settings,
    bridge,
    maxDecisions: 2,
  });

  await assert.rejects(
    () => engine.run({ goal: 'loop runtime identity', conversationId: 'hex-id-loop' }),
    /decision budget|maxDecisions|exhausted/i,
  );
  // Call 1 changes fingerprint from undefined -> {...} (progress: maxDecisions = 1 + 2 = 3).
  // Calls 2 and 3 have identical fingerprint, so no progress is marked and budget stops at 3.
  assert.equal(calls, 3, 'identical repeated DEV_RUNTIME_IDENTITY_TOOL calls must not extend maxDecisions');
});

test('4. validateSchema uses Object.hasOwn so inherited Object.prototype keys cannot bypass additionalProperties: false', () => {
  const schema = {
    type: 'object',
    properties: {
      name: { type: 'string' },
    },
    additionalProperties: false,
  };

  assert.equal(validateSchema({ name: 'ok' }, schema).ok, true);

  for (const payload of [
    JSON.parse('{"name":"ok","__proto__":{"admin":true}}'),
    { name: 'ok', constructor: 'evil' },
    { name: 'ok', toString: 'evil' },
    { name: 'ok', hasOwnProperty: 'evil' },
  ]) {
    const res = validateSchema(payload, schema);
    assert.equal(res.ok, false, `expected validation failure for keys ${Object.keys(payload).join(',')}`);
    assert.ok(res.errors.some((e) => e.includes('is not allowed')));
  }
});

test('5. ToolRegistry.execute maps signal.reason === "timeout" to budget_exhausted in catch block', async () => {
  const inFlightController = new AbortController();
  const registry2 = new ToolRegistry();
  registry2.register({
    name: 'slow_tool_in_flight',
    description: 'aborts mid-flight with timeout reason',
    execute: () => {
      inFlightController.abort('timeout');
      throw new Error('cancelled');
    },
  });
  await assert.rejects(
    () => registry2.execute('slow_tool_in_flight', {}, { signal: inFlightController.signal }),
    (err) => err instanceof AIError && err.type === 'budget_exhausted',
  );

  const cancelController = new AbortController();
  const registry3 = new ToolRegistry();
  registry3.register({
    name: 'cancel_tool_in_flight',
    description: 'aborts mid-flight with user cancel reason',
    execute: () => {
      cancelController.abort('user');
      throw new Error('transport aborted');
    },
  });
  await assert.rejects(
    () => registry3.execute('cancel_tool_in_flight', {}, { signal: cancelController.signal }),
    (err) => err instanceof AIError && err.type === 'cancelled',
  );
});

test('6. AiSession.retry returns null without mutating conversation.turns when busy', async () => {
  let resolveInFlight;
  let callCount = 0;
  const session = new AiSession({
    engine: {
      async run(input) {
        callCount += 1;
        if (callCount === 1) throw new Error('initial_failure');
        return await new Promise((resolve) => {
          resolveInFlight = () => resolve({ answer: `ok: ${input.question}` });
        });
      },
    },
    storage: null,
  });

  const failedTurn = await session.ask('first question', { context: {} });
  assert.equal(failedTurn.status, 'error');
  assert.equal(session.turns.length, 2);

  // Start an in-flight ask so session.busy becomes true
  const inFlightPromise = session.ask('second question', { context: {} });
  assert.equal(session.busy, true);
  assert.equal(session.turns.length, 4);

  const snapshotIds = session.turns.map((t) => t.id);
  const retryResult = session.retry({ context: {}, targetTurn: failedTurn });
  assert.equal(retryResult, null, 'retry must return null while busy');
  assert.deepEqual(
    session.turns.map((t) => t.id),
    snapshotIds,
    'retry while busy must not splice or pop existing turns',
  );

  resolveInFlight();
  const secondTurn = await inFlightPromise;
  assert.equal(secondTurn.status, 'done');
  assert.equal(session.turns.length, 4);
});
