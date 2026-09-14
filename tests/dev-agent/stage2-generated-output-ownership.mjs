import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/stage2-nonphysical-closure.yml'), 'utf8');

assert.match(workflow, /tools\/validation\/generated-output-policy\.mjs/, 'Stage 2 must use the canonical generated-output ownership policy');
assert.match(workflow, /steps\.generated-policy\.outputs\.mode/, 'Stage 2 must branch on the canonical ownership result');
assert.match(workflow, /enforce\|ephemeral/, 'Stage 2 must accept only the two canonical ownership modes');
assert.match(workflow, /npm run userscript:build/, 'Stage 2 must still build canonical generated artifacts in every required lane');
assert.match(workflow, /userscript\/hex\.user\.template\.js\|userscript\/release-version\.json/, 'Stage 2 ephemeral validation must keep the generated-output allowlist narrow');
assert.match(workflow, /git restore --source=HEAD --worktree -- userscript\/hex\.user\.template\.js userscript\/release-version\.json/, 'Stage 2 component lanes must restore the exact candidate tree after ephemeral validation');
assert.match(workflow, /GENERATED_BUILD_IDENTITY: \$\{\{ steps\.generated-artifacts\.outputs\.build_identity \}\}/, 'Stage 2 proof records must retain the canonical ephemeral build identity');
assert.doesNotMatch(workflow, /if: steps\.generated-policy\.outputs\.mode == 'ephemeral'[\s\S]*skip/i, 'Stage 2 must not skip canonical generation in component lanes');

console.log('Stage 2 generated-output ownership contract: ok');
