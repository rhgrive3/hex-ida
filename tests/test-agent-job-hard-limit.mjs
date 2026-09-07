import assert from "node:assert/strict";
import { AgentJobManager } from "../js/ai/jobs/index.js";

console.log("Testing Issue #2652 AgentJobManager hard-limit preflight regression...");

{
  let turnCalled = 0;
  const runtime = {
    turn: async () => {
      turnCalled++;
      return { limits: { exhausted: false } };
    },
  };
  const manager = new AgentJobManager({ runtime });

  const job = {
    version: 1,
    id: "budget-exhausted",
    status: "checkpointed",
    goal: "test-goal",
    effectiveScope: "auto",
    conversationId: null,
    sessionId: null,
    provider: null,
    model: null,
    reasoning: null,
    evidenceIds: [], hypothesisIds: [], completedTools: [],
    continuationRefs: [], unresolvedWork: [],
    budgetUsage: { slices: 1, modelCalls: 0, toolCalls: 0, elapsedMs: 0, contextBytes: 0 },
    limits: { maxSlices: 1, maxElapsedMs: 1800000 },
    request: {}, lastResult: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };

  const result = await manager.runSlice(job);
  assert.equal(result.status, "hard-limit", "Job reaching slice limit must return status hard-limit");
  assert.equal(turnCalled, 0, "runtime.turn must NOT be invoked when hardLimit is reached");
}

{
  let turnCalled = 0;
  const runtime = {
    turn: async () => {
      turnCalled++;
      return { limits: { exhausted: false } };
    },
  };
  const manager = new AgentJobManager({ runtime });

  const elapsedExhaustedJob = {
    version: 1,
    id: "elapsed-exhausted",
    status: "ready",
    goal: "test-goal",
    effectiveScope: "auto",
    conversationId: null,
    sessionId: null,
    provider: null,
    model: null,
    reasoning: null,
    evidenceIds: [], hypothesisIds: [], completedTools: [],
    continuationRefs: [], unresolvedWork: [],
    budgetUsage: { slices: 0, modelCalls: 0, toolCalls: 0, elapsedMs: 1800001, contextBytes: 0 },
    limits: { maxSlices: 5, maxElapsedMs: 1800000 },
    request: {}, lastResult: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };

  const result = await manager.runSlice(elapsedExhaustedJob);
  assert.equal(result.status, "hard-limit", "Job reaching elapsed limit must return status hard-limit");
  assert.equal(turnCalled, 0, "runtime.turn must NOT be invoked when maxElapsedMs is reached");
}

console.log("Issue #2652 regressions PASS!");
