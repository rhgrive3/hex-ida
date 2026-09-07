import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW_PATH = path.join(ROOT, '.github/workflows/stage1-release-validation.yml');
const content = fs.readFileSync(WORKFLOW_PATH, 'utf8');

for (const trigger of [
  'js/targets/architecture/**', 'js/analysis/alias/**', 'js/semantics/**',
  'tests/stage1/**', 'tools/validation/stage1/**', 'tools/validation/competitive/**',
  'tests/machine-effects/**', 'tools/validation/stage2/closure-ledger.json',
]) assert.ok(content.includes(trigger), `Workflow missing main-impact path: ${trigger}`);

assert.match(content, /^  push:\n    branches: \[main\]/m, 'Stage 1 truth proof must run after relevant changes land on main');
assert.match(content, /^  workflow_dispatch:/m, 'Stage 1 truth proof must retain exact manual dispatch');
assert.doesNotMatch(content, /^  pull_request:/m, 'Stage 1 release truth must not consume a runner on every PR synchronization');
assert.match(content, /ref: \$\{\{ inputs\.expect_sha \|\| github\.sha \}\}/, 'automatic and manual proofs must checkout the exact target SHA');
assert.doesNotMatch(content, /head-and-candidate-merge-tree/, 'development mode removes duplicate PR head/merge-tree proof');
console.log('stage1 workflow trigger coverage: PASS');
