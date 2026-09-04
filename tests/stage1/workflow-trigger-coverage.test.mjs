import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW_PATH = path.join(ROOT, '.github/workflows/stage1-release-validation.yml');

const content = fs.readFileSync(WORKFLOW_PATH, 'utf8');

function extractWorkflowJob(workflowContent, jobId) {
  const lines = workflowContent.split(/\r?\n/);
  const jobsIndex = lines.findIndex((line) => line === 'jobs:');
  assert.notEqual(jobsIndex, -1, 'Workflow must define jobs');

  const marker = `  ${jobId}:`;
  const start = lines.findIndex((line, index) => index > jobsIndex && line === marker);
  assert.notEqual(start, -1, `Workflow missing ${jobId} job`);

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^  [A-Za-z0-9_-]+:\s*$/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

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

const prProofJob = extractWorkflowJob(content, 'pr-proof');
assert.ok(prProofJob.includes('name: head-and-candidate-merge-tree'), 'pr-proof missing stable dual-proof name');
assert.ok(prProofJob.includes('ref: ${{ github.event.pull_request.head.sha }}'), 'pr-proof missing exact PR-head checkout');
assert.ok(prProofJob.includes('ref: ${{ github.sha }}'), 'pr-proof missing exact candidate-merge checkout');
assert.ok(prProofJob.includes('id: head_verify'), 'pr-proof missing head verification outcome');
assert.ok(prProofJob.includes('id: merge_verify'), 'pr-proof missing merge-tree verification outcome');
assert.ok(prProofJob.includes('HEAD_VERIFY: ${{ steps.head_verify.outcome }}'), 'pr-proof aggregate omits head proof');
assert.ok(prProofJob.includes('MERGE_VERIFY: ${{ steps.merge_verify.outcome }}'), 'pr-proof aggregate omits merge-tree proof');

// The Stage 1 completion branch is the aggregate integration lane. Component
// ownership/release jobs must not run their own whole-diff ownership checks on
// that branch; Stage 1's exact-head verifier is the authoritative aggregate
// gate. Keep this routing explicit so a shared package.json trigger cannot
// reintroduce the cross-phase ownership false positive.
const stage1IntegrationBranch = 'completion/stage1-integration';
const componentGateWorkflows = [
  '.github/workflows/phase7-ownership.yml',
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

console.log('stage1 workflow trigger coverage: PASS');