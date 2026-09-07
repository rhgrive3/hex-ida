import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_PROFILE,
  assertAgentProfile,
  canSelectAgentProfile,
} from "../js/ai/dev/policy/agent-profile.js";
import { DevAgentUiSettings } from "../js/ai/dev/ui/settings.js";
import { AllowAllAdminProvider, AdminAuthProvider } from "../js/ai/dev/auth/admin-provider.js";

test("issue #6296 - valid string agent profiles are accepted", () => {
  assert.equal(assertAgentProfile("standard"), AGENT_PROFILE.STANDARD);
  assert.equal(assertAgentProfile("dev"), AGENT_PROFILE.DEV);
  assert.equal(assertAgentProfile("STANDARD"), AGENT_PROFILE.STANDARD);
  assert.equal(assertAgentProfile("DEV"), AGENT_PROFILE.DEV);
});

test("issue #6296 - structured and non-string agent profiles are rejected", () => {
  const invalid = [
    ["dev"],
    ["standard"],
    { toString: () => "dev" },
    123,
    true,
    null,
    undefined,
  ];

  for (const p of invalid) {
    assert.throws(
      () => assertAgentProfile(p),
      TypeError,
      `Should reject profile: ${String(p)}`
    );
    assert.throws(
      () => canSelectAgentProfile({ admin: true }, p),
      TypeError,
      `Should reject canSelect profile: ${String(p)}`
    );
  }
});

test("issue #6296 - settings.setAgentProfile rejects structured profiles", () => {
  const settings = new DevAgentUiSettings({ authProvider: new AllowAllAdminProvider(), storage: null });
  assert.throws(
    () => settings.setAgentProfile(["dev"]),
    TypeError,
    "Should reject structured profile in settings"
  );
  assert.equal(settings.agentProfile, AGENT_PROFILE.STANDARD);
});
