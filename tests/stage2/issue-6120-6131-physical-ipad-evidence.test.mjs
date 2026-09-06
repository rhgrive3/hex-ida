import assert from "node:assert/strict";
import test from "node:test";
import {
  REQUIRED_IPAD_CHECKS,
  createPhysicalIPadEvidence,
  validatePhysicalIPadEvidence,
} from "../../js/platform/physical-ipad-evidence.js";

const commitSha = "a".repeat(40);
const treeSha = "b".repeat(40);
const fixtureIdentity = `artifact:reports/stage2/fixture.bin@sha256:${"c".repeat(64)}`;
const scenarioEvidenceIdentity = `artifact:reports/stage2/ipad-output.json@sha256:${"d".repeat(64)}`;
const checks = Object.fromEntries(REQUIRED_IPAD_CHECKS.map((key) => [key, true]));
const expected = {
  commitSha,
  treeSha,
  buildIdentity: "build:test",
  runtimeIdentity: "runtime:test",
  deviceModel: "iPad mini 6",
  iPadOSVersion: "27.0-test",
  webKitVersion: "webkit:test",
  resolveEvidenceIdentity: (identity) => identity,
};

function makeRecord(overrides = {}) {
  return createPhysicalIPadEvidence({
    ...expected,
    testedAt: "2026-09-04T00:00:00Z",
    attestedBy: "test-harness",
    fixtureIdentity,
    scenarioEvidenceIdentity,
    checks,
    runtimeProfilesExercised: ["macho", "arm64e", "macho"],
    rebuildProfilesExercised: ["pe32+"],
    ...overrides,
  });
}

test("Issues #6120/#6131: physical iPad evidence binds expected environment and profile collections", () => {
  const record = makeRecord();
  assert.deepEqual(record.runtimeProfilesExercised, ["arm64e", "macho"]);
  assert.equal(validatePhysicalIPadEvidence(record, expected).ok, true);

  for (const [field, reason] of [
    ["runtimeIdentity", "ipad-evidence-runtime-mismatch"],
    ["deviceModel", "ipad-evidence-device-mismatch"],
    ["iPadOSVersion", "ipad-evidence-ipados-mismatch"],
    ["webKitVersion", "ipad-evidence-webkit-mismatch"],
  ]) {
    assert.equal(
      validatePhysicalIPadEvidence(record, { ...expected, [field]: `different-${field}` }).reason,
      reason,
    );
  }
});

test("Issues #6120/#6131: malformed profile containers and elements fail closed", () => {
  for (const [field, value, reason] of [
    ["runtimeProfilesExercised", "arm64e", "ipad-evidence-runtime-profiles-invalid"],
    ["rebuildProfilesExercised", { profile: "macho" }, "ipad-evidence-rebuild-profiles-invalid"],
  ]) {
    assert.throws(() => makeRecord({ [field]: value }), new RegExp(reason));
  }

  const record = makeRecord();
  for (const [field, reason] of [
    ["runtimeProfilesExercised", "ipad-evidence-runtime-profiles-invalid"],
    ["rebuildProfilesExercised", "ipad-evidence-rebuild-profiles-invalid"],
  ]) {
    const malformed = structuredClone(record);
    malformed[field] = [{ toString: () => "coerced-profile" }];
    assert.equal(validatePhysicalIPadEvidence(malformed, expected).reason, reason);
  }
});
