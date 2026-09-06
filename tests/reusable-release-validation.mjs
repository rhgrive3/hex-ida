import assert from "node:assert/strict";
import fs from "node:fs";

console.log("Testing Reusable Release Validation workflows...");

const reusableText = fs.readFileSync(".github/workflows/_phase-release-validation.yml", "utf8");
const phase10Text = fs.readFileSync(".github/workflows/phase10-release-validation.yml", "utf8");
const phase11Text = fs.readFileSync(".github/workflows/phase11-release-validation.yml", "utf8");

assert.ok(reusableText.includes("workflow_call:"));
assert.ok(reusableText.includes("contents: read"));
assert.ok(!reusableText.includes("write"));
assert.ok(reusableText.includes("checkout_ref:"));
assert.ok(reusableText.includes("ownership_script:"));
assert.ok(reusableText.includes("verify_script:"));
assert.ok(reusableText.includes("artifact_prefix:"));
assert.ok(reusableText.includes("artifact_suffix:"));
assert.ok(reusableText.includes("evidence_paths:"));
assert.ok(reusableText.includes("actions/checkout@v4"));
assert.ok(reusableText.includes("fetch-depth: 0"));
assert.ok(reusableText.includes("git fetch --no-tags origin main:refs/remotes/origin/main"));
assert.ok(reusableText.includes("actions/setup-node@v4"));
assert.ok(reusableText.includes("npm ci --no-audit --no-fund"));
assert.ok(reusableText.includes("node ${{ inputs.ownership_script }}"));
assert.ok(reusableText.includes("--expect-sha"));
assert.ok(reusableText.includes("--shadow"));
assert.ok(reusableText.includes("actions/upload-artifact@v4"));
assert.ok(reusableText.includes("if: success()"));
assert.ok(reusableText.includes("if-no-files-found: error"));

for (const [phase, text, ownership, verifier, artifact] of [
  ['Phase 10', phase10Text, 'tools/validation/phase10/ownership-check.mjs', 'tools/validation/phase10/verify.mjs', 'phase10-release-evidence'],
  ['Phase 11', phase11Text, 'tools/validation/phase11/ownership-check.mjs', 'tools/validation/phase11/verify.mjs', 'phase11-release-evidence'],
]) {
  assert.doesNotMatch(text, /^  push:/m, `${phase} must not auto-run on development pushes`);
  assert.doesNotMatch(text, /^  pull_request:/m, `${phase} must not auto-run on PR synchronization`);
  assert.match(text, /^  workflow_dispatch:/m, `${phase} must retain explicit release dispatch`);
  assert.ok(text.includes('sha:'), `${phase} exact SHA input`);
  assert.ok(text.includes('shadow:'), `${phase} shadow input`);
  assert.ok(text.includes(ownership), `${phase} ownership verifier`);
  assert.ok(text.includes(verifier), `${phase} product verifier`);
  assert.ok(text.includes(artifact), `${phase} evidence artifact`);
  const checkoutMatch = text.match(/checkout_ref:\s*(.+)/);
  const suffixMatch = text.match(/artifact_suffix:\s*(.+)/);
  assert.ok(checkoutMatch && suffixMatch, `${phase} has checkout_ref and artifact_suffix`);
  assert.equal(checkoutMatch[1].trim(), suffixMatch[1].trim(), `${phase} checkout_ref and artifact suffix match`);
}

for (const caller of [phase10Text, phase11Text]) {
  assert.ok(!caller.includes("actions/setup-node@v4"));
  assert.ok(!caller.includes("npm ci --no-audit --no-fund"));
  assert.ok(!caller.includes("git fetch --no-tags origin main"));
  assert.ok(!caller.includes("args=()"));
  assert.ok(!caller.includes("actions/upload-artifact@v4"));
}

console.log("All reusable release validation tests PASS!");
