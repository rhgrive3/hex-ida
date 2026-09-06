import assert from "node:assert/strict";
import fs from "node:fs";

console.log("Testing Reusable Release Validation workflows...");

const reusableText = fs.readFileSync(".github/workflows/_phase-release-validation.yml", "utf8");
const phase10Text = fs.readFileSync(".github/workflows/phase10-release-validation.yml", "utf8");
const phase11Text = fs.readFileSync(".github/workflows/phase11-release-validation.yml", "utf8");

// Reusable workflow assertions
assert.ok(reusableText.includes("workflow_call:"), "1. contains workflow_call");
assert.ok(reusableText.includes("contents: read"), "2. contains contents: read");
assert.ok(!reusableText.includes("write"), "2. no write permission");
assert.ok(reusableText.includes("checkout_ref:"), "3. checkout_ref input");
assert.ok(reusableText.includes("ownership_script:"), "3. ownership_script input");
assert.ok(reusableText.includes("verify_script:"), "3. verify_script input");
assert.ok(reusableText.includes("artifact_prefix:"), "3. artifact_prefix input");
assert.ok(reusableText.includes("artifact_suffix:"), "3. artifact_suffix input");
assert.ok(reusableText.includes("evidence_paths:"), "3. evidence_paths input");
assert.ok(reusableText.includes("actions/checkout@v4"), "4. actions/checkout@v4");
assert.ok(reusableText.includes("fetch-depth: 0"), "5. fetch-depth: 0");
assert.ok(reusableText.includes("git fetch --no-tags origin main:refs/remotes/origin/main"), "6. fetch origin/main");
assert.ok(reusableText.includes("actions/setup-node@v4"), "7. setup-node");
assert.ok(reusableText.includes("22"), "7. node 22");
assert.ok(reusableText.includes("cache: npm"), "7. npm cache");
assert.ok(reusableText.includes("npm ci --no-audit --no-fund"), "8. npm ci");
assert.ok(reusableText.includes("node ${{ inputs.ownership_script }}"), "9. ownership execution");
assert.ok(reusableText.includes("--expect-sha"), "10. --expect-sha");
assert.ok(reusableText.includes("--shadow"), "11. --shadow");
assert.ok(
  reusableText.includes("${{ inputs.run_broad_regression && github.event_name != 'pull_request' }}"),
  "12. broad regression is preserved at release boundaries and deduplicated on PRs",
);
assert.ok(reusableText.includes("actions/upload-artifact@v4"), "13. upload-artifact");
assert.ok(reusableText.includes("if: success()"), "14. if: success()");
assert.ok(reusableText.includes("${{ inputs.artifact_prefix }}-${{ inputs.artifact_suffix }}"), "15. artifact name");
assert.ok(reusableText.includes("if-no-files-found: error"), "16. if-no-files-found: error");
const broadRegressionIndex = reusableText.indexOf("- name: Broad repository regression at release boundary");
const exactVerifierIndex = reusableText.indexOf("- name: ${{ inputs.phase_name }} exact-product verifier");
const evidenceUploadIndex = reusableText.indexOf("- name: Publish validated ${{ inputs.phase_name }} evidence");
assert.ok(
  broadRegressionIndex >= 0 && exactVerifierIndex >= 0 && broadRegressionIndex < exactVerifierIndex,
  "17. broad regression runs before exact verifier so verifier-published evidence cannot dirty clean-tree checks",
);
assert.ok(
  exactVerifierIndex < evidenceUploadIndex,
  "18. evidence is uploaded only after exact verification",
);

console.log("  ok 1-18 reusable workflow assertions");

function extractPaths(text, event) {
  const match = text.match(new RegExp(event + ":[\\s\\S]*?paths:\\s*\\n([\\s\\S]*?)(?:\\n\\s*\\w+:|\\Z)"));
  if (!match) return [];
  const lines = match[1].split("\n").map(l => l.trim()).filter(l => l.startsWith("-"));
  return lines.map(l => l.replace(/^-\s*['"]?/, "").replace(/['"]?$/, "")).sort();
}

// Phase 10/11 callers retain exact manual release proof but do not auto-run
// on development PRs or ordinary main pushes. The reusable verifier remains
// unchanged and is exercised through workflow_dispatch.
for (const [phase, text, ownership, verifier, artifact] of [
  ['Phase 10', phase10Text, 'tools/validation/phase10/ownership-check.mjs', 'tools/validation/phase10/verify.mjs', 'phase10-release-evidence'],
  ['Phase 11', phase11Text, 'tools/validation/phase11/ownership-check.mjs', 'tools/validation/phase11/verify.mjs', 'phase11-release-evidence'],
]) {
  assert.deepEqual(extractPaths(text, "push"), [], `${phase} must not auto-run on development pushes`);
  assert.deepEqual(extractPaths(text, "pull_request"), [], `${phase} must not auto-run on PR synchronization`);
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

console.log("  ok Phase 10/11 manual release caller assertions");

// No duplicated mechanics in caller files
for (const caller of [phase10Text, phase11Text]) {
  assert.ok(!caller.includes("actions/setup-node@v4"));
  assert.ok(!caller.includes("npm ci --no-audit --no-fund"));
  assert.ok(!caller.includes("git fetch --no-tags origin main"));
  assert.ok(!caller.includes("args=()"));
  assert.ok(!caller.includes("actions/upload-artifact@v4"));
}

console.log("  ok No duplicated mechanics in callers");
console.log("All reusable release validation tests PASS!");
