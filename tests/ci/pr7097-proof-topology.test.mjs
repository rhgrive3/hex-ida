import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = name => fs.readFileSync(path.join(ROOT, '.github/workflows', name), 'utf8');

// The old UI proof was a path-filtered push-to-main job. Keep the expanded AI
// UI paths while restoring that post-merge trigger; PR-only feedback cannot
// stand in for the protected-main browser proof.
const ui = read('ui-regression.yml');
assert.match(ui, /^  push:\n    branches: \[main\]/m);
assert.doesNotMatch(ui, /^  pull_request:/m);
for (const trigger of [
  'js/ai/control/snapshot.js',
  'js/ai/dev/ui/controls.js',
  'tests/ai-ui-dev-profile.mjs',
]) {
  assert.match(ui, new RegExp(`^\\s*- ['"]${trigger.replaceAll('/', '\\/')}['"]$`, 'm'));
}
assert.match(ui, /  browser-matrix:\n/);
assert.match(ui, /needs: \[chromium, webkit\]/);
assert.match(ui, /CHROMIUM_RESULT: \$\{\{ needs\.chromium\.result \}\}/);
assert.match(ui, /WEBKIT_RESULT: \$\{\{ needs\.webkit\.result \}\}/);

// check:dev is feedback for the combined PR candidate. The final-closure
// dispatch retains the complete product check for release evidence, while
// final admission remains represented by the existing canonical main gates.
const preflight = read('final-closure-preflight.yml');
const development = preflight.split('  development:\n')[1].split('\n  batch:')[0];
const batch = preflight.split('  batch:\n')[1];
assert.match(development, /github\.event_name == 'pull_request'/);
assert.match(development, /npm run check:dev -- --base/);
assert.doesNotMatch(development, /npm run check(?:\s|$)/m);
assert.match(batch, /if: inputs\.mode == 'release'/);
assert.match(batch, /npm run check/);
assert.match(preflight, /Generated, independent verifier and applicable target\/runtime proof remain/);

// Old→new proof mapping for the retained admission lanes: complete invariant
// checks stay on main, and Stage 2 keeps exact-head, generated-output,
// independent-oracle, and runtime validation on its protected-main path.
const invariant = read('invariant-gates.yml');
assert.match(invariant, /^  push:\n    branches: \[main\]/m);
assert.match(invariant, /Require complete repository check/);
assert.match(invariant, /Assert exact target SHA/);
const stage2 = read('stage2-nonphysical-closure.yml');
assert.match(stage2, /npm run userscript:build/);
assert.match(stage2, /node tools\/validation\/stage2\/verify\.mjs --expect-sha "\$SHA" --full/);
assert.match(stage2, /rebuild-independent-oracle\.mjs/);
const stage2Release = read('stage2-release-validation.yml');
assert.match(stage2Release, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
assert.match(stage2Release, /ref: \$\{\{ github\.sha \}\}/);
assert.match(stage2Release, /node tools\/validation\/stage2\/verify\.mjs/);
assert.match(stage2Release, /--physical-evidence/);
assert.match(stage2Release, /args\+=\(--final/);
const recovery = read('generated-exact-head-recovery.yml');
assert.match(recovery, /inputs: \{ sha: pr\.head\.sha \}/);

console.log('PR7097 proof topology: PASS');
