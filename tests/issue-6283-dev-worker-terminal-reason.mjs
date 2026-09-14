import assert from "node:assert/strict";
import test from "node:test";
import {
  DEV_TERMINAL_REASON,
  createDevWorkerResult,
  devTerminalReasonFrom,
} from "../js/ai/dev/protocol/context-packet.js";

test("issue #6283 - valid string terminalReason and workerState resolve correctly", () => {
  assert.equal(devTerminalReasonFrom({ runtimeReason: "completed" }), DEV_TERMINAL_REASON.COMPLETED);
  assert.equal(devTerminalReasonFrom({ runtimeReason: "cancelled" }), DEV_TERMINAL_REASON.CANCELLED);
  assert.equal(devTerminalReasonFrom({ runtimeReason: "worker-error" }), DEV_TERMINAL_REASON.WORKER_ERROR);

  assert.equal(devTerminalReasonFrom({ workerState: "COMPLETED" }), DEV_TERMINAL_REASON.COMPLETED);
  assert.equal(devTerminalReasonFrom({ workerState: "CANCELLED" }), DEV_TERMINAL_REASON.CANCELLED);
  assert.equal(devTerminalReasonFrom({ workerState: "FAILED" }), DEV_TERMINAL_REASON.WORKER_ERROR);

  const res = createDevWorkerResult({ taskId: "t1", terminalReason: "completed" });
  assert.equal(res.terminalReason, "completed");
});

test("issue #6283 - structured runtimeReason is not coerced into terminalReason", () => {
  const invalid = [
    ["completed"],
    { toString: () => "completed" },
    123,
    true,
  ];

  for (const r of invalid) {
    assert.equal(devTerminalReasonFrom({ runtimeReason: r }), null, `Should not coerce runtimeReason: ${String(r)}`);
    const res = createDevWorkerResult({ taskId: "t1", terminalReason: r });
    assert.equal(res.terminalReason, null, `Should not coerce result terminalReason: ${String(r)}`);
  }
});

test("issue #6283 - structured workerState is not coerced into terminalReason fallback", () => {
  const invalid = [
    ["COMPLETED"],
    { toString: () => "COMPLETED" },
    123,
    true,
  ];

  for (const s of invalid) {
    assert.equal(devTerminalReasonFrom({ workerState: s }), null, `Should not coerce workerState: ${String(s)}`);
  }
});
