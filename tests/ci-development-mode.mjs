import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (name) => fs.readFileSync(`.github/workflows/${name}`, 'utf8');
const noPr = (name) => assert.doesNotMatch(read(name), /^  pull_request:/m, `${name} must not auto-run on PR synchronization`);

for (const name of [
  'invariant-gates.yml',
  'generated-sync.yml',
  'cross-binary-accuracy.yml',
  'ghidra-differential.yml',
  'universal-platform.yml',
  'ui-regression.yml',
  'codeql-actions.yml',
  'codeql-javascript.yml',
  'phase6-release-validation.yml',
  'phase7-release-validation.yml',
  'phase8-release-validation.yml',
  'phase10-release-validation.yml',
  'phase11-release-validation.yml',
  'phase12-release-validation.yml',
  'phase9-preflight.yml',
  'stage1-release-validation.yml',
  'stage2-release-validation.yml',
  'stage2-nonphysical-closure.yml',
]) noPr(name);

const phase12 = read('phase12-release-validation.yml');
assert.match(phase12, /^  workflow_dispatch:\n    inputs:\n      expect_sha:/m,
  'Phase 12 release validation must retain an exact-SHA manual path');
assert.match(phase12, /ref: \$\{\{ inputs\.expect_sha \|\| github\.sha \}\}/,
  'Phase 12 manual validation must checkout the requested exact SHA');
assert.match(phase12, /npm run phase12:verify -- --expect-sha "\$VERIFY_SHA"/,
  'Phase 12 manual validation must invoke its exact-head verifier');

const fast = read('pr-fast-gate.yml');
assert.match(fast, /^  pull_request:/m);
assert.match(fast, /^  workflow_dispatch:\n    inputs:\n      sha:/m, 'fast gate manual dispatch must require exact SHA input');
assert.match(fast, /ref: \$\{\{ inputs\.sha \|\| github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/);
assert.match(fast, /Assert exact target SHA/);
assert.match(fast, /npm run lint/);
assert.match(fast, /npm run module-boundaries:test/);
assert.match(fast, /npm run evidence-writers:test/);
assert.match(fast, /npm run core:test/);

const invariant = read('invariant-gates.yml');
assert.match(invariant, /^  push:\n    branches: \[main\]/m);
assert.match(invariant, /^  workflow_dispatch:\n    inputs:\n      sha:/m, 'full invariant manual dispatch must require exact SHA input');
assert.match(invariant, /ref: \$\{\{ inputs\.sha \|\| github\.sha \}\}/);
assert.match(invariant, /Assert exact target SHA/);

const stage2 = read('stage2-nonphysical-closure.yml');
assert.match(stage2, /^  push:\n    branches: \[main\]/m);
assert.doesNotMatch(stage2, /      - 'js\/\*\*'/, 'Stage 2 closure must not trigger on the whole JS tree');
assert.match(stage2, /      - 'js\/targets\/architecture\/\*\*'/);
assert.match(stage2, /      - 'tests\/stage2\/\*\*'/);

const autofix = read('generated-userscript-autofix.yml');
assert.match(autofix, /github\.event\.pull_request\.base\.ref == 'release'/);
assert.match(autofix, /dev-agent-hardening\/integration\//);
assert.match(autofix, /      - 'package\.json'/);
assert.match(autofix, /      - 'package-lock\.json'/);

const mainSync = read('generated-userscript-main-sync.yml');
assert.match(mainSync, /      - 'package\.json'/);
assert.match(mainSync, /      - 'package-lock\.json'/);

const recovery = read('generated-exact-head-recovery.yml');
assert.doesNotMatch(recovery, /^  workflow_run:/m);
assert.match(recovery, /pr_number:/);
assert.match(recovery, /ref: pr\.base\.ref/);
assert.match(recovery, /inputs: \{ sha: pr\.head\.sha \}/);

const host = read('userscript-host.yml');
assert.match(host, /embed-browser:\n    if: github\.event_name != 'pull_request'/);

console.log('CI development mode contract: PASS');
