import assert from "node:assert/strict";
import { DevSupervisorEngineV0 } from "../js/ai/dev/supervisor/dev-supervisor-engine-v0.js";
import { DevSupervisorV0 } from "../js/ai/dev/supervisor/dev-supervisor-v0.js";
import {
  DEV_RUNTIME_ACTIVATION_TOOL,
  DEV_RUNTIME_IDENTITY_TOOL,
  DevSelfUpdateGate,
} from "../js/ai/dev/bootstrap/self-update-gate.js";

const NEW_COMMIT = "b".repeat(40);
const NEW_BUILD = "2".repeat(24);
const OLD_COMMIT = "a".repeat(40);
const OLD_BUILD = "1".repeat(24);
const GATED_CAPABILITY = "chatgpt.skill.run";

// #4608 regression 1-3: a model-visible dev.runtime.require_activation decision
// must not be able to clear an armed self-update gate while it is reload-required.
async function modelClearAttemptRejectedAndGateStaysShut() {
  const skillRuns = [];
  const harness = createHarness({
    client: {
      enabled: true,
      runtimeIdentity: async () => ({ realm: "parent-userscript", commit: OLD_COMMIT, buildId: OLD_BUILD }),
      skillRun: async (args) => { skillRuns.push(args); return { skillId: args.skillId, ran: true }; },
    },
    decisions: [
      { type: "tool", tool: DEV_RUNTIME_ACTIVATION_TOOL, arguments: { expectedCommit: NEW_COMMIT, expectedBuildId: NEW_BUILD, capabilities: [GATED_CAPABILITY], reason: "merged source not yet running" }, purpose: "arm the self-update gate" },
      { type: "tool", tool: DEV_RUNTIME_ACTIVATION_TOOL, arguments: { clear: true }, purpose: "try to disarm the gate from the model" },
      { type: "tool", tool: GATED_CAPABILITY, arguments: { skillId: "project.create", program: "probe" }, purpose: "prove the gated capability after the failed disarm" },
      { type: "final", answer: "done", completedTasks: ["proof"], remaining: [] },
    ],
  });

  const gate = harness.engine.selfUpdateGate;
  assert.equal(gate.state, "idle", "fresh engine starts unarmed");

  await harness.engine.run({ goal: "prove a merged capability", conversationId: "conversation-4608" });

  assert.equal(gate.state, "reload-required", "a model clear attempt must leave the gate armed");
  assert.equal(gate.blocks(GATED_CAPABILITY), true, "the gated capability must stay blocked");
  assert.equal(skillRuns.length, 0, "the gated proof must never run on the stale runtime");

  const clearRejection = harness.allHistory().find((entry) => entry.kind === "dev-runtime-activation-rejected" && entry.tool === DEV_RUNTIME_ACTIVATION_TOOL);
  assert.ok(clearRejection, "the refused activation arguments must be reported back to the Supervisor");
  assert.equal(clearRejection.code, "dev-runtime-activation-argument-rejected");
  assert.deepEqual(clearRejection.state, "reload-required");
}

// #4608 regression 4-5: a documented arm still works, and the gate opens only
// on an identity match plus the required reinitialization.
function validArmStillWorksAndOpensOnlyOnMatchedReinitialize() {
  const gate = new DevSelfUpdateGate();
  const armed = gate.requireActivation({
    expectedCommit: NEW_COMMIT,
    expectedBuildId: NEW_BUILD,
    capabilities: [GATED_CAPABILITY],
    requireReinitialization: true,
    reason: "merged source",
  });
  assert.equal(armed.state, "reload-required", "a documented activation must still arm the gate");
  assert.equal(gate.blocks(GATED_CAPABILITY), true);

  gate.observeActiveRuntime({ commit: OLD_COMMIT, buildId: OLD_BUILD });
  assert.equal(gate.state, "reload-required", "a mismatched identity must not open the gate");

  gate.observeActiveRuntime({ commit: NEW_COMMIT, buildId: NEW_BUILD });
  assert.equal(gate.state, "reload-required", "a matching read without reinitialization must not open the gate");

  gate.observeActiveRuntime({ commit: NEW_COMMIT, buildId: NEW_BUILD }, { reinitialized: true });
  assert.equal(gate.state, "active", "identity match + reinitialization is the only opener");
  assert.equal(gate.blocks(GATED_CAPABILITY), false);
}

// #4608 regression 6: the trusted withdrawal recovery path is preserved.
function trustedWithdrawalStillClearsTheGate() {
  const gate = new DevSelfUpdateGate();
  gate.requireActivation({ expectedCommit: "d".repeat(40), expectedBuildId: "e".repeat(24), reason: "typo expectation" });
  assert.equal(gate.state, "reload-required");
  const cleared = gate.requireActivation({ clear: true, reason: "withdrew a wrong expectation" });
  assert.equal(cleared.state, "idle", "trusted host code must still be able to withdraw");
  assert.equal(gate.blocks(GATED_CAPABILITY), false);

  const engine = new DevSupervisorEngineV0({
    supervisor: new DevSupervisorV0({ workerClient: { enabled: true, skillRun: async () => ({ ran: true }) } }),
    settings: { decisionPolicy: "normal", lastRun: null, setLastRun() {} },
    bridge: null,
  });
  engine.requireRuntimeActivation({ expectedCommit: NEW_COMMIT, expectedBuildId: NEW_BUILD, capabilities: [GATED_CAPABILITY] });
  assert.equal(engine.runtimeActivationStatus().state, "reload-required");
  engine.requireRuntimeActivation({ clear: true, reason: "trusted host withdrawal" });
  assert.equal(engine.runtimeActivationStatus().state, "idle", "the trusted host wrapper must keep the withdrawal path");
}

// #4608 regression 7: identity and worker-cleanup ALWAYS_ALLOWED semantics intact.
function alwaysAllowedSemanticsIntact() {
  const gate = new DevSelfUpdateGate();
  gate.requireActivation({ expectedCommit: NEW_COMMIT, expectedBuildId: NEW_BUILD, capabilities: [GATED_CAPABILITY] });
  assert.equal(gate.state, "reload-required");
  assert.equal(gate.blocks(DEV_RUNTIME_IDENTITY_TOOL), false, "identity re-read stays reachable");
  assert.equal(gate.blocks(DEV_RUNTIME_ACTIVATION_TOOL), false, "a valid re-arm stays reachable");
  for (const cleanup of ["worker.release", "worker.stop", "worker.pool.release", "worker.pool.stop"]) {
    assert.equal(gate.blocks(cleanup), false, `${cleanup} must stay reachable`);
  }
  assert.equal(gate.blocks(GATED_CAPABILITY), true, "the gated capability stays blocked");
}

function createHarness({ client, decisions }) {
  let sequence = 0;
  const prompts = [];
  const supervisor = new DevSupervisorV0({
    workerClient: client,
    idFactory: (kind) => `${kind}-${++sequence}`,
    now: () => "2026-08-18T00:00:00.000Z",
  });
  const settings = { decisionPolicy: "normal", lastRun: null, setLastRun(run) { this.lastRun = run; } };
  let index = 0;
  const bridge = {
    async request(prompt) {
      prompts.push(String(prompt));
      const decision = decisions[Math.min(index, decisions.length - 1)];
      index += 1;
      return JSON.stringify(decision);
    },
  };
  return {
    engine: new DevSupervisorEngineV0({ supervisor, settings, bridge }),
    allHistory() {
      const out = [];
      for (const prompt of prompts) {
        const match = prompt.match(/<HEX_DEV_DATA>\n([\s\S]*?)\n<\/HEX_DEV_DATA>/);
        if (!match) continue;
        const history = JSON.parse(match[1]).history || [];
        for (const entry of history) if (!out.includes(entry)) out.push(entry);
      }
      return out;
    },
  };
}

await modelClearAttemptRejectedAndGateStaysShut();
validArmStillWorksAndOpensOnlyOnMatchedReinitialize();
trustedWithdrawalStillClearsTheGate();
alwaysAllowedSemanticsIntact();
console.log("issue #4608 self-update gate clear bypass: ok");
