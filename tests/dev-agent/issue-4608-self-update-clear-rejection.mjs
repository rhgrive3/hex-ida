// Regression for #4608: dev.runtime.require_activation must accept only the
// documented exact keys. A model-supplied {clear:true} used to disarm an armed
// reload-required self-update gate without any identity evidence, reopening
// every gated capability. Withdrawal stays available only through the trusted
// host/admin API.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DevSupervisorEngineV0 } from '../../js/ai/dev/supervisor/dev-supervisor-engine-v0.js';
import { DevSupervisorV0 } from '../../js/ai/dev/supervisor/dev-supervisor-v0.js';
import { DEV_TOOL_ERROR_HISTORY_KIND } from '../../js/ai/dev/supervisor/tool-error-recovery.js';
import {
  DEV_RUNTIME_ACTIVATION_TOOL,
  DEV_RUNTIME_IDENTITY_TOOL,
  DEV_SELF_UPDATE_HISTORY_KIND,
  DEV_SELF_UPDATE_STATE,
  DevSelfUpdateGate,
} from '../../js/ai/dev/bootstrap/self-update-gate.js';

const ARMED_COMMIT = 'b'.repeat(40);
const ARMED_BUILD = '2'.repeat(24);
const GATED_CAPABILITY = 'chatgpt.skill.run';

function armedGate() {
  const gate = new DevSelfUpdateGate();
  gate.requireActivation({
    expectedCommit: ARMED_COMMIT,
    expectedBuildId: ARMED_BUILD,
    capabilities: [GATED_CAPABILITY],
    reason: 'merged capability',
  });
  return gate;
}

test('#4608 requireActivation({clear:true}) cannot disarm an armed gate', () => {
  const gate = armedGate();
  const before = gate.status();
  assert.equal(before.state, DEV_SELF_UPDATE_STATE.RELOAD_REQUIRED);
  assert.equal(gate.blocks(GATED_CAPABILITY), true);

  assert.throws(
    () => gate.requireActivation({ clear: true, reason: 'bypass the reload gate' }),
    /dev-self-update-gate-unexpected-argument-field:clear/,
  );

  assert.deepEqual(gate.status(), before, 'a rejected activation must leave the gate exactly as it was');
  assert.equal(gate.state, DEV_SELF_UPDATE_STATE.RELOAD_REQUIRED);
  assert.equal(gate.blocks(GATED_CAPABILITY), true);
});

test('#4608 the clear escape hatch cannot be smuggled into a valid activation', () => {
  const gate = armedGate();
  const before = gate.status();
  assert.throws(
    () => gate.requireActivation({
      expectedCommit: ARMED_COMMIT,
      expectedBuildId: ARMED_BUILD,
      capabilities: ['other.capability'],
      clear: true,
    }),
    /dev-self-update-gate-unexpected-argument-field:clear/,
  );
  assert.deepEqual(gate.status(), before);
  assert.deepEqual([...gate.status().gatedCapabilities], [GATED_CAPABILITY]);
});

test('#4608 unknown argument fields are rejected fail-closed', () => {
  const gate = armedGate();
  const before = gate.status();
  assert.throws(
    () => gate.requireActivation({ expectedCommit: ARMED_COMMIT, expectedBuildId: ARMED_BUILD, force: true }),
    /dev-self-update-gate-unexpected-argument-field:force/,
  );
  assert.deepEqual(gate.status(), before);
});

test('#4608 the documented exact-key activation and identity match still work', () => {
  const gate = new DevSelfUpdateGate();
  const armed = gate.requireActivation({
    expectedCommit: ARMED_COMMIT,
    expectedBuildId: ARMED_BUILD,
    expectedUserscriptVersion: '2.0.2',
    capabilities: [GATED_CAPABILITY],
    reason: 'merged capability',
  });
  assert.equal(armed.state, DEV_SELF_UPDATE_STATE.RELOAD_REQUIRED);
  assert.equal(gate.blocks(GATED_CAPABILITY), true);

  gate.requireActivation({
    expectedCommit: ARMED_COMMIT,
    expectedBuildId: ARMED_BUILD,
    capabilities: [GATED_CAPABILITY],
    requireReinitialization: true,
    reason: 'reinitialize required',
  });
  const observed = gate.observeActiveRuntime({ commit: ARMED_COMMIT, buildId: ARMED_BUILD, userscriptVersion: '2.0.2' });
  assert.equal(observed.state, DEV_SELF_UPDATE_STATE.RELOAD_REQUIRED, 'identity alone must not open a reinitialization gate');
  assert.ok(observed.mismatches.includes('reinitialization'));

  const activated = gate.observeActiveRuntime(
    { commit: ARMED_COMMIT, buildId: ARMED_BUILD, userscriptVersion: '2.0.2' },
    { reinitialized: true },
  );
  assert.equal(activated.state, DEV_SELF_UPDATE_STATE.ACTIVE);
  assert.equal(gate.blocks(GATED_CAPABILITY), false);
});

test('#4608 the trusted withdrawal API stays available to host code', () => {
  const gate = armedGate();
  const withdrawn = gate.clearActivationExpectation('withdrew a wrong expectation');
  assert.equal(withdrawn.state, DEV_SELF_UPDATE_STATE.IDLE);
  assert.equal(withdrawn.reason, 'withdrew a wrong expectation');
  assert.equal(gate.blocks(GATED_CAPABILITY), false);
});

test('#4608 identity and worker cleanup ALWAYS_ALLOWED semantics are unchanged', () => {
  const gate = armedGate();
  for (const tool of [
    DEV_RUNTIME_IDENTITY_TOOL, DEV_RUNTIME_ACTIVATION_TOOL,
    'worker.release', 'worker.stop', 'worker.pool.release', 'worker.pool.stop',
  ]) {
    assert.equal(gate.blocks(tool), false, `${tool} must stay reachable while the gate is armed`);
  }
  assert.equal(gate.blocks('worker.send'), false, 'an explicit capability list gates exactly its capabilities, not teardown-adjacent tools');
  assert.equal(gate.blocks('some.other.new.capability'), false);
});

test('#4608 the Supervisor model path rejects a clear:true activation decision', async () => {
  let promptIndex = 0;
  const prompts = [];
  const supervisor = new DevSupervisorV0({
    workerClient: {
      enabled: true,
      runtimeIdentity: async () => ({}),
      skillRun: async () => { throw new Error('the gated capability must never execute in this regression'); },
    },
    idFactory: (kind) => `issue-4608-${kind}`,
    now: () => '2026-09-13T00:00:00.000Z',
  });
  const settings = { decisionPolicy: 'normal', lastRun: null, setLastRun(run) { this.lastRun = run; } };
  const decisions = [
    {
      type: 'tool',
      tool: DEV_RUNTIME_ACTIVATION_TOOL,
      arguments: { expectedCommit: ARMED_COMMIT, expectedBuildId: ARMED_BUILD, capabilities: [GATED_CAPABILITY], reason: 'declare merged runtime' },
      purpose: 'arm the gate',
    },
    {
      type: 'tool',
      tool: DEV_RUNTIME_ACTIVATION_TOOL,
      arguments: { clear: true },
      purpose: 'withdraw the expectation without evidence',
    },
    { type: 'tool', tool: GATED_CAPABILITY, arguments: { skillId: 'project.create', program: 'probe' }, purpose: 'prove the gated capability' },
    { type: 'final', answer: 'done', completedTasks: [], remaining: [] },
  ];
  const bridge = {
    async request(prompt) {
      prompts.push(String(prompt));
      const decision = decisions[Math.min(promptIndex, decisions.length - 1)];
      promptIndex += 1;
      return JSON.stringify(decision);
    },
  };
  const engine = new DevSupervisorEngineV0({ supervisor, settings, bridge });
  const result = await engine.run({ goal: 'bypass attempt', conversationId: 'conversation-4608' });

  assert.equal(result.answer, 'done');
  const historyOf = (index) => {
    const match = String(prompts[index]).match(/<HEX_DEV_DATA>\n([\s\S]*?)\n<\/HEX_DEV_DATA>/);
    assert.ok(match, 'the Supervisor prompt must carry its data block');
    return JSON.parse(match[1]).history;
  };
  const afterBypass = historyOf(2).at(-1);
  assert.equal(afterBypass.kind, DEV_TOOL_ERROR_HISTORY_KIND, 'the clear:true decision must be rejected as a tool error');
  assert.equal(afterBypass.tool, DEV_RUNTIME_ACTIVATION_TOOL);
  assert.equal(engine.runtimeActivationStatus().state, DEV_SELF_UPDATE_STATE.RELOAD_REQUIRED,
    'the rejected bypass attempt must leave the gate armed');
  assert.deepEqual([...engine.runtimeActivationStatus().gatedCapabilities], [GATED_CAPABILITY]);

  const gated = historyOf(3).at(-1);
  assert.equal(gated.kind, DEV_SELF_UPDATE_HISTORY_KIND, 'the gated capability must still be blocked');
  assert.equal(gated.tool, GATED_CAPABILITY);
});
