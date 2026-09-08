import assert from "node:assert/strict";
import test from "node:test";
import { DevSelfUpdateGate } from "../js/ai/dev/bootstrap/self-update-gate.js";

const VALID_COMMIT_A = "a".repeat(40);
const VALID_BUILD_A = "b".repeat(24);
const VALID_COMMIT_C = "c".repeat(40);
const VALID_BUILD_C = "d".repeat(24);
const VALID_COMMIT_E = "e".repeat(40);
const VALID_BUILD_E = "f".repeat(24);

test("issue #5421 - fresh gate stays idle after a rejected activation", () => {
  const gate = new DevSelfUpdateGate();
  assert.equal(gate.state, "idle");

  assert.throws(() => {
    gate.requireActivation({
      expectedCommit: VALID_COMMIT_A,
      expectedBuildId: VALID_BUILD_A,
      capabilities: [null], // invalid: non-empty tool name required
    });
  }, TypeError);

  // The failed call must not have armed anything.
  assert.equal(gate.state, "idle");
  assert.equal(gate.status().expected, null);
  assert.deepEqual(gate.status().gatedCapabilities, []);
  assert.equal(gate.blocks("dev.any.tool"), false);
});

test("issue #5421 - failed re-arm on an armed gate leaves the previous status untouched", () => {
  const gate = new DevSelfUpdateGate();
  const before = gate.requireActivation({
    expectedCommit: VALID_COMMIT_C,
    expectedBuildId: VALID_BUILD_C,
    capabilities: ["dev.tool.a"],
    reason: "initial arm",
  });

  assert.throws(() => {
    gate.requireActivation({
      expectedCommit: VALID_COMMIT_E,
      expectedBuildId: VALID_BUILD_E,
      capabilities: [42], // invalid entry
      reason: "   ", // invalid reason (trim-to-empty)
    });
  }, TypeError);

  assert.deepEqual(gate.status(), before);
});

test("issue #5421 - invalid reason alone is also state-preserving", () => {
  const gate = new DevSelfUpdateGate();
  const before = gate.requireActivation({
    expectedCommit: VALID_COMMIT_C,
    expectedBuildId: VALID_BUILD_C,
    capabilities: ["dev.tool.a"],
    reason: "initial arm",
  });

  assert.throws(() => {
    gate.requireActivation({
      expectedCommit: VALID_COMMIT_E,
      expectedBuildId: VALID_BUILD_E,
      reason: "  \t ", // invalid reason
    });
  }, TypeError);

  assert.deepEqual(gate.status(), before);
});

test("issue #5421 - invalid capabilities shape (non-array) is state-preserving", () => {
  const gate = new DevSelfUpdateGate();
  assert.throws(() => {
    gate.requireActivation({
      expectedCommit: VALID_COMMIT_A,
      expectedBuildId: VALID_BUILD_A,
      capabilities: "dev.tool.a", // non-array
    });
  }, TypeError);
  assert.equal(gate.state, "idle");
  assert.equal(gate.status().expected, null);
});

test("issue #5421 - clear() with an invalid reason preserves the armed state", () => {
  const gate = new DevSelfUpdateGate();
  const before = gate.requireActivation({
    expectedCommit: VALID_COMMIT_C,
    expectedBuildId: VALID_BUILD_C,
    capabilities: ["dev.tool.a"],
  });

  assert.throws(() => gate.clear("   "), TypeError);
  assert.deepEqual(gate.status(), before);
});

test("issue #5421 - valid activation still transitions to reload-required", () => {
  const gate = new DevSelfUpdateGate();
  const status = gate.requireActivation({
    expectedCommit: VALID_COMMIT_A,
    expectedBuildId: VALID_BUILD_A,
    capabilities: ["dev.tool.a"],
    requireReinitialization: true,
  });
  assert.equal(status.state, "reload-required");
  assert.equal(status.expected.commit, VALID_COMMIT_A);
  assert.equal(status.expected.buildId, VALID_BUILD_A);
  assert.deepEqual(status.gatedCapabilities, ["dev.tool.a"]);
  assert.deepEqual(status.mismatches, ["not-observed"]);
});
