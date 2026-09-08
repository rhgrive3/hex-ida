import assert from "node:assert/strict";
import test from "node:test";
import {
  createAnalysisScopeRequest,
  createDevAnalysisScopeRequest,
  toLegacyAnalysisScope,
} from "../js/ai/dev/run/analysis-scope.js";
import { DevAgentUiSettings } from "../js/ai/dev/ui/settings.js";
import { AllowAllAdminProvider } from "../js/ai/dev/auth/admin-provider.js";

test("issue #6293 - valid string analysis scope requests are accepted", () => {
  const req = createAnalysisScopeRequest({ initial: "none", expansionPolicy: "agent" });
  assert.equal(req.initial, "none");
  assert.equal(req.expansionPolicy, "agent");
  assert.equal(toLegacyAnalysisScope(req), null);

  const autoReq = createAnalysisScopeRequest({ initial: "binary", expansionPolicy: "auto" });
  assert.equal(toLegacyAnalysisScope(autoReq), "auto");
});

test("issue #6293 - structured and non-string inputs are rejected", () => {
  const invalid = [
    ["none"],
    ["function"],
    { toString: () => "none" },
    123,
    true,
    null,
    undefined,
  ];

  for (const v of invalid) {
    assert.throws(
      () => createAnalysisScopeRequest({ initial: v, expansionPolicy: "agent" }),
      TypeError,
      `Should reject initial: ${String(v)}`
    );
    assert.throws(
      () => createAnalysisScopeRequest({ initial: "none", expansionPolicy: v }),
      TypeError,
      `Should reject expansionPolicy: ${String(v)}`
    );
  }
});

test("issue #6293 - settings.setAnalysisScope rejects structured inputs", () => {
  const settings = new DevAgentUiSettings({ authProvider: new AllowAllAdminProvider(), storage: null });
  assert.throws(
    () => settings.setAnalysisScope(["function"]),
    TypeError,
    "Should reject structured initial scope in settings"
  );
});
