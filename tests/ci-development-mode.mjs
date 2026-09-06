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

const fast = read('pr-fast-gate.yml');
assert.match(fast, /^  pull_request:/m);
assert.match(fast, /npm run lint/);
assert.match(fast, /npm run module-boundaries:test/);
assert.match(fast, /npm run evidence-writers:test/);
assert.match(fast, /npm run core:test/);

const invariant = read('invariant-gates.yml');
assert.match(invariant, /^  push:\n    branches: \[main\]/m);
assert.match(invariant, /^  workflow_dispatch:/m);

const stage2 = read('stage2-nonphysical-closure.yml');
assert.match(stage2, /^  push:\n    branches: \[main\]/m);
assert.doesNotMatch(stage2, /      - 'js\/\*\*'/, 'Stage 2 closure must not trigger on the whole JS tree');
assert.match(stage2, /      - 'js\/targets\/architecture\/\*\*'/);
assert.match(stage2, /      - 'tests\/stage2\/\*\*'/);

const autofix = read('generated-userscript-autofix.yml');
assert.match(autofix, /github\.event\.pull_request\.base\.ref == 'release'/);
assert.match(autofix, /dev-agent-hardening\/integration\//);

const recovery = read('generated-exact-head-recovery.yml');
assert.doesNotMatch(recovery, /^  workflow_run:/m);
assert.match(recovery, /pr_number:/);

const host = read('userscript-host.yml');
assert.match(host, /embed-browser:\n    if: github\.event_name != 'pull_request'/);

console.log('CI development mode contract: PASS');
