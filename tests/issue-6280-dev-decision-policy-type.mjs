import assert from "node:assert/strict";
import test from "node:test";
import {
  DEV_DECISION_POLICIES,
  DEV_DECISION_POLICY,
  assertDevDecisionPolicy,
  devDecisionPolicyContract,
} from "../js/ai/dev/policy/decision-policy.js";

test("issue #6280 - Dev decision policy accepts valid primitive strings", () => {
  assert.equal(assertDevDecisionPolicy("normal"), DEV_DECISION_POLICY.NORMAL);
  assert.equal(assertDevDecisionPolicy("yolo"), DEV_DECISION_POLICY.YOLO);
  assert.equal(assertDevDecisionPolicy("NORMAL"), DEV_DECISION_POLICY.NORMAL);
  assert.equal(assertDevDecisionPolicy("YOLO"), DEV_DECISION_POLICY.YOLO);
  assert.equal(assertDevDecisionPolicy("  yolo  "), DEV_DECISION_POLICY.YOLO);

  const normalContract = devDecisionPolicyContract("normal");
  assert.equal(normalContract.securityOrPermissionBoundary, "human-confirmation-normally");
  const yoloContract = devDecisionPolicyContract("yolo");
  assert.equal(yoloContract.securityOrPermissionBoundary, "autonomous");
});

test("issue #6280 - Dev decision policy rejects structured values and non-strings", () => {
  const invalidInputs = [
    ["yolo"],
    ["normal"],
    ["YOLO"],
    { toString: () => "yolo" },
    { policy: "yolo" },
    123,
    0,
    true,
    false,
    null,
    undefined,
    Symbol("yolo"),
  ];

  for (const input of invalidInputs) {
    assert.throws(
      () => assertDevDecisionPolicy(input),
      TypeError,
      `Should reject non-string input: ${String(input)}`
    );
    assert.throws(
      () => devDecisionPolicyContract(input),
      TypeError,
      `Should reject non-string contract input: ${String(input)}`
    );
  }
});

test("issue #6280 - Dev decision policy rejects unsupported strings", () => {
  assert.throws(() => assertDevDecisionPolicy(""), TypeError);
  assert.throws(() => assertDevDecisionPolicy("   "), TypeError);
  assert.throws(() => assertDevDecisionPolicy("unsafe"), TypeError);
  assert.throws(() => assertDevDecisionPolicy("admin"), TypeError);
});
