// Regression for #5904: the agent-loop-resilience workflow's paths filter
// missed the suite's direct production dependencies — the coordinator imports
// `js/ai/dev/workers/contracts.js` and `js/userscript/chatgpt-adapter.js`
// from outside `js/userscript/dev/**`, so PRs touching only those files
// skipped the resilience regressions. The filter must list every direct
// dependency of the suite.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = readFileSync(new URL('../.github/workflows/agent-loop-resilience.yml', import.meta.url), 'utf8');

const REQUIRED_DIRECT_DEPENDENCIES = [
  'js/ai/dev/workers/contracts.js',
  'js/userscript/chatgpt-adapter.js',
];

for (const dependency of REQUIRED_DIRECT_DEPENDENCIES) {
  assert.match(workflow, new RegExp(`^\\s*-\\s+'${dependency.replace(/\./g, '\\.')}'$`, 'm'),
    `the paths filter must include the suite's direct dependency ${dependency}`);
}

// The filter block that runs on pull_request must be the one carrying the
// dependencies (both trigger blocks are identical; count coverage per block).
const pathBlocks = workflow.split(/paths:/).length - 1;
assert.ok(pathBlocks >= 2, 'pull_request and push triggers each carry a paths filter');
const occurrences = REQUIRED_DIRECT_DEPENDENCIES.map((dependency) => ({
  dependency,
  count: workflow.split(`'${dependency}'`).length - 1,
}));
for (const { dependency, count } of occurrences) {
  assert.ok(count >= 2, `${dependency} must be covered by both the pull_request and push filters`);
}
