import assert from "node:assert/strict";
import test from "node:test";
import {
  DEV_SUPERVISOR_DECISION_TYPES,
  validateDevSupervisorDecision,
} from "../js/ai/dev/protocol/hex-dev-supervisor-v1.js";

test("issue #6281 - valid supervisor decisions pass validation", () => {
  const toolDecision = validateDevSupervisorDecision(
    { type: "tool", tool: "dev.runtime.identity", arguments: {}, purpose: "inspect" },
    { availableTools: ["dev.runtime.identity"] }
  );
  assert.equal(toolDecision.type, "tool");
  assert.equal(toolDecision.tool, "dev.runtime.identity");

  const humanDecision = validateDevSupervisorDecision({
    type: "human",
    question: "Continue?",
    blocking: true,
  });
  assert.equal(humanDecision.type, "human");

  const waitDecision = validateDevSupervisorDecision({
    type: "wait",
    events: ["run.done"],
    reason: "waiting for completion",
  });
  assert.equal(waitDecision.type, "wait");

  const finalDecision = validateDevSupervisorDecision({
    type: "final",
    answer: "done",
    completedTasks: ["task1"],
    remaining: [],
  });
  assert.equal(finalDecision.type, "final");
});

test("issue #6281 - supervisor decision rejects structured type", () => {
  const invalidTypes = [
    ["tool"],
    ["human"],
    ["wait"],
    ["final"],
    { toString: () => "tool" },
    123,
    true,
    null,
    undefined,
  ];

  for (const t of invalidTypes) {
    assert.throws(
      () => validateDevSupervisorDecision({ type: t, question: "q", blocking: true }),
      TypeError,
      `Should reject non-string type: ${String(t)}`
    );
  }
});

test("issue #6281 - supervisor decision rejects structured or malformed tool identity", () => {
  const invalidTools = [
    ["dev.runtime.identity"],
    { toString: () => "dev.runtime.identity" },
    123,
    true,
    null,
    undefined,
    "  dev.runtime.identity  ",
    "",
  ];

  for (const tool of invalidTools) {
    assert.throws(
      () => validateDevSupervisorDecision(
        { type: "tool", tool, arguments: {}, purpose: "inspect" },
        { availableTools: ["dev.runtime.identity"] }
      ),
      TypeError,
      `Should reject non-primitive/untrimmed tool: ${String(tool)}`
    );
  }
});
