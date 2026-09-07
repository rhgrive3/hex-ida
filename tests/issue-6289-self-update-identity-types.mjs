import assert from "node:assert/strict";
import test from "node:test";
import {
  DevSelfUpdateGate,
  normalizeCommitText,
  normalizeBuildIdText,
} from "../js/ai/dev/bootstrap/self-update-gate.js";
import {
  verifyDevBootstrapIdentity,
} from "../js/ai/dev/bootstrap/dev-bootstrap-gate.js";

const VALID_COMMIT = "0123456789abcdef0123456789abcdef01234567";
const VALID_BUILD_ID = "0123456789abcdef01234567";

test("issue #6289 - valid string commit and buildId activate DevSelfUpdateGate", () => {
  const gate = new DevSelfUpdateGate();
  gate.requireActivation({
    expectedCommit: VALID_COMMIT,
    expectedBuildId: VALID_BUILD_ID,
  });

  assert.equal(gate.state, "reload-required");

  gate.observeActiveRuntime({
    commit: VALID_COMMIT,
    buildId: VALID_BUILD_ID,
  });

  assert.equal(gate.state, "active");
});

test("issue #6289 - structured commit or buildId rejected in observeActiveRuntime", () => {
  const gate = new DevSelfUpdateGate();
  gate.requireActivation({
    expectedCommit: VALID_COMMIT,
    expectedBuildId: VALID_BUILD_ID,
  });

  assert.throws(
    () => gate.observeActiveRuntime({ commit: [VALID_COMMIT], buildId: VALID_BUILD_ID }),
    TypeError,
    "Should reject array commit"
  );
  assert.throws(
    () => gate.observeActiveRuntime({ commit: VALID_COMMIT, buildId: [VALID_BUILD_ID] }),
    TypeError,
    "Should reject array buildId"
  );
  assert.equal(gate.state, "reload-required");
});

test("issue #6289 - structured values rejected in normalizeCommitText and normalizeBuildIdText", () => {
  assert.equal(normalizeCommitText([VALID_COMMIT]), null);
  assert.equal(normalizeBuildIdText([VALID_BUILD_ID]), null);
  assert.equal(normalizeCommitText({ toString: () => VALID_COMMIT }), null);
  assert.equal(normalizeBuildIdText({ toString: () => VALID_BUILD_ID }), null);
});

test("issue #6289 - verifyDevBootstrapIdentity rejects structured commit or buildId", () => {
  const checkpoint = {
    runId: "r1",
    goal: "g",
    decisionPolicy: "normal",
    supervisorSessionKey: "s1",
    chatgptConversationId: "c1",
    pendingTask: {},
    expectedCommit: VALID_COMMIT,
    expectedBuildId: VALID_BUILD_ID,
    expectedExtensionVersion: "2",
  };

  assert.throws(
    () => verifyDevBootstrapIdentity(checkpoint, { commit: [VALID_COMMIT], buildId: VALID_BUILD_ID }, "2"),
    TypeError,
    "Should reject array commit in active identity"
  );
  assert.throws(
    () => verifyDevBootstrapIdentity(checkpoint, { commit: VALID_COMMIT, buildId: [VALID_BUILD_ID] }, "2"),
    TypeError,
    "Should reject array buildId in active identity"
  );
});
