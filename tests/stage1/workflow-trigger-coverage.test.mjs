import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW_PATH = path.join(ROOT, '.github/workflows/stage1-release-validation.yml');

const content = fs.readFileSync(WORKFLOW_PATH, 'utf8');
const workflowJob = (workflow, jobId) => {
  const lines = workflow.split('\n');
  const start = lines.findIndex((line) => line === `  ${jobId}:`);
  assert.notEqual(start, -1, `Workflow missing ${jobId} job`);
  const relativeEnd = lines.slice(start + 1).findIndex((line) => /^  [A-Za-z0-9_-]+:\s*$/.test(line));
  const end = relativeEnd === -1 ? lines.length : start + 1 + relativeEnd;
  return lines.slice(start, end).join('\n');
};

const requiredTriggers = [
  'js/targets/architecture/**',
  'js/analysis/alias/**',
  'js/semantics/**',
  'tests/stage1/**',
  'tools/validation/stage1/**',
  'tools/validation/competitive/**',
  'tests/phase7/**',
  'tools/validation/phase7/**',
  'tests/phase8/**',
  'tools/validation/phase8/**',
  'tests/phase9/**',
  'tools/validation/phase9/**',
  'tests/phase11/**',
  'tools/validation/phase11/**',
  'tests/machine-effects/**',
  '.github/workflows/stage1-release-validation.yml',
  'tools/validation/stage2/completion-scope.lock.json',
  'tools/validation/stage2/closure-ledger.json',
];

for (const trigger of requiredTriggers) {
  assert.ok(content.includes(trigger), `Workflow missing path trigger: ${trigger}`);
}

const prProof = workflowJob(content, 'pr-proof');
assert.ok(prProof.includes('name: head-and-candidate-merge-tree'), 'Workflow missing stable dual-proof name');
assert.ok(prProof.includes('ref: ${{ github.event.pull_request.head.sha }}'), 'Workflow missing exact PR-head checkout');
assert.ok(prProof.includes('ref: ${{ github.sha }}'), 'Workflow missing exact candidate-merge checkout');
assert.ok(prProof.includes('id: head_verify'), 'Workflow missing head verification outcome');
assert.ok(prProof.includes('id: merge_verify'), 'Workflow missing merge-tree verification outcome');
assert.ok(prProof.includes('HEAD_VERIFY: ${{ steps.head_verify.outcome }}'), 'Workflow aggregate omits head proof');
assert.ok(prProof.includes('MERGE_VERIFY: ${{ steps.merge_verify.outcome }}'), 'Workflow aggregate omits merge-tree proof');

// The Stage 1 completion branch is the aggregate integration lane. Component
// ownership/release jobs must not run their own whole-diff ownership checks on
// that branch; Stage 1's exact-head verifier is the authoritative aggregate
// gate. Keep this routing explicit so a shared package.json trigger cannot
// reintroduce the cross-phase ownership false positive.
const stage1IntegrationBranch = 'completion/stage1-integration';
const componentGateWorkflows = [
  '.github/workflows/phase10-release-validation.yml',
  '.github/workflows/phase11-release-validation.yml',
  '.github/workflows/phase12-release-validation.yml',
];

for (const workflow of componentGateWorkflows) {
  const workflowContent = fs.readFileSync(path.join(ROOT, workflow), 'utf8');
  assert.ok(
    workflowContent.includes(`github.head_ref != '${stage1IntegrationBranch}'`),
    `${workflow} must route the Stage 1 integration branch to the aggregate verifier`
  );
}

const phase7Workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/phase7-ownership.yml'), 'utf8');
assert.ok(
  phase7Workflow.includes("if: ${{ github.event_name == 'workflow_dispatch' }}"),
  'the Phase 7 GitHub fallback must stay manual-only after automatic ownership moved to CircleCI',
);

console.log('stage1 workflow trigger coverage: PASS');
