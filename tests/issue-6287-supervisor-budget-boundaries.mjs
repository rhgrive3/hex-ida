import assert from "node:assert/strict";
import test from "node:test";
import { DevSupervisorEngineV0 } from "../js/ai/dev/supervisor/dev-supervisor-engine-v0.js";
import { ProgressBudgetDevSupervisorEngineV0 } from "../js/ai/dev/supervisor/dev-supervisor-progress-budget.js";

const dummySupervisor = { async complete() { return { type: "final", answer: "ok", completedTasks: [], remaining: [] }; } };
const dummySettings = { decisionPolicy: "normal" };

test("issue #6287 - default safety budgets are preserved", () => {
  const engine = new DevSupervisorEngineV0({ supervisor: dummySupervisor, settings: dummySettings });
  assert.equal(engine.maxDecisions, 16);
  assert.equal(engine.maxToolErrorRecoveries, 6);

  const progressEngine = new ProgressBudgetDevSupervisorEngineV0({ supervisor: dummySupervisor, settings: dummySettings });
  assert.equal(progressEngine.maxDecisions, 16);
  assert.equal(progressEngine.progressDecisionWindow, 16);
  assert.equal(progressEngine.maxToolErrorRecoveries, 6);
});

test("issue #6287 - valid custom bounded budgets are accepted", () => {
  const engine = new DevSupervisorEngineV0({
    supervisor: dummySupervisor,
    settings: dummySettings,
    maxDecisions: 10,
    maxToolErrorRecoveries: 2,
  });
  assert.equal(engine.maxDecisions, 10);
  assert.equal(engine.maxToolErrorRecoveries, 2);
});

test("issue #6287 - invalid maxDecisions rejected", () => {
  const invalidValues = [
    Infinity,
    -Infinity,
    NaN,
    0,
    -1,
    3.5,
    "16",
    [16],
    { value: 16 },
    null,
    1000, // exceeds hard ceiling
  ];

  for (const v of invalidValues) {
    assert.throws(
      () => new DevSupervisorEngineV0({ supervisor: dummySupervisor, settings: dummySettings, maxDecisions: v }),
      TypeError,
      `Should reject maxDecisions: ${String(v)}`
    );
    assert.throws(
      () => new ProgressBudgetDevSupervisorEngineV0({ supervisor: dummySupervisor, settings: dummySettings, maxDecisions: v }),
      TypeError,
      `Should reject maxDecisions in ProgressBudget: ${String(v)}`
    );
  }
});

test("issue #6287 - invalid maxToolErrorRecoveries rejected", () => {
  const invalidValues = [
    Infinity,
    -Infinity,
    NaN,
    -1,
    2.5,
    "6",
    [6],
    { value: 6 },
    null,
    200, // exceeds hard ceiling
  ];

  for (const v of invalidValues) {
    assert.throws(
      () => new DevSupervisorEngineV0({ supervisor: dummySupervisor, settings: dummySettings, maxToolErrorRecoveries: v }),
      TypeError,
      `Should reject maxToolErrorRecoveries: ${String(v)}`
    );
  }
});
