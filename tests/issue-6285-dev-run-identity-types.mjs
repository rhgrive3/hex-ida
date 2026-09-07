import assert from "node:assert/strict";
import test from "node:test";
import { createDevRun, bindDevRunIdentity } from "../js/ai/dev/run/dev-run.js";

const baseInput = {
  runId: "run-123",
  supervisorSessionKey: "session-abc",
  goal: "inspect binary",
};

test("issue #6285 - valid string identity fields are accepted and preserved", () => {
  const run = createDevRun({
    ...baseInput,
    taskId: "task-1",
    workerId: "worker-1",
    tabNodeId: "tab-1",
    hexConversationId: "hex-conv-1",
    chatgptConversationId: "gpt-conv-1",
  });

  assert.equal(run.runId, "run-123");
  assert.equal(run.workerId, "worker-1");
  assert.equal(run.taskId, "task-1");

  const rebound = bindDevRunIdentity(run, {
    workerId: "worker-2",
    chatgptConversationId: "gpt-conv-2",
  });
  assert.equal(rebound.workerId, "worker-2");
  assert.equal(rebound.chatgptConversationId, "gpt-conv-2");
});

test("issue #6285 - structured or non-string runId rejected", () => {
  const invalidValues = [
    ["run-123"],
    { toString: () => "run-123" },
    123,
    true,
    null,
    undefined,
  ];

  for (const v of invalidValues) {
    assert.throws(
      () => createDevRun({ ...baseInput, runId: v }),
      TypeError,
      `Should reject runId: ${String(v)}`
    );
  }
});

test("issue #6285 - structured or non-string nullable identity fields rejected in createDevRun", () => {
  const invalidValues = [
    ["worker-1"],
    { toString: () => "worker-1" },
    123,
    true,
  ];

  for (const v of invalidValues) {
    assert.throws(
      () => createDevRun({ ...baseInput, workerId: v }),
      TypeError,
      `Should reject workerId: ${String(v)}`
    );
    assert.throws(
      () => createDevRun({ ...baseInput, taskId: v }),
      TypeError,
      `Should reject taskId: ${String(v)}`
    );
  }
});

test("issue #6285 - structured or non-string identity fields rejected in bindDevRunIdentity", () => {
  const run = createDevRun(baseInput);
  const invalidValues = [
    ["worker-2"],
    { toString: () => "worker-2" },
    456,
    false,
  ];

  for (const v of invalidValues) {
    assert.throws(
      () => bindDevRunIdentity(run, { workerId: v }),
      TypeError,
      `Should reject rebound workerId: ${String(v)}`
    );
    assert.throws(
      () => bindDevRunIdentity(run, { chatgptConversationId: v }),
      TypeError,
      `Should reject rebound chatgptConversationId: ${String(v)}`
    );
  }
});
