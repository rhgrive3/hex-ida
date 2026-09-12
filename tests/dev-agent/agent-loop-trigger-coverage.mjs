import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { dirname, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

// Use Node's module parser, including re-exports and multiline imports, rather
// than an import regex that could silently miss a new static dependency.
if (typeof vm.SourceTextModule !== 'function') {
  assert.ok(!process.execArgv.includes('--experimental-vm-modules'), 'module parser must be available');
  const result = spawnSync(process.execPath, [
    '--no-warnings', '--experimental-vm-modules', fileURLToPath(import.meta.url),
  ], { stdio: 'inherit', env: process.env });
  process.exit(result.status ?? 1);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const entry = 'tests/dev-agent/agent-loop-resilience.mjs';
const self = 'tests/dev-agent/agent-loop-trigger-coverage.mjs';
const workflowPath = '.github/workflows/agent-loop-resilience.yml';
const circlePath = '.circleci/config.yml';
const read = (file) => readFileSync(resolve(root, file), 'utf8');
const workflow = read(workflowPath);
const circle = read(circlePath);
const job = circle.match(/^  agent-loop-resilience:\n([\s\S]*?)(?=^  [\w-]+:|^workflows:)/m)?.[1];
assert.ok(job, 'CircleCI must retain the automatic resilience job');
const route = job.match(/bash scripts\/ci\/circleci-impact\.sh (\S+) '([^']+)'/);
assert.ok(route, 'CircleCI resilience impact routing must be readable');
assert.equal(route[1], 'main-and-branch', 'resilience must validate both main deltas and branch diffs');

function githubPaths(event) {
  const block = workflow.match(new RegExp(`^  ${event}:\\n([\\s\\S]*?)(?=^  [\\w-]+:|^\\S)`, 'm'))?.[1];
  assert.ok(block?.includes('    paths:\n'), `${event} must retain an explicit path policy`);
  return [...block.matchAll(/^      - '([^']+)'$/gm)].map((match) => match[1]);
}

function globMatches(pattern, file) {
  // This policy deliberately uses only literal paths and directory/** globs.
  // Reject other syntax instead of approximating GitHub's matching semantics.
  const prefix = pattern.endsWith('/**') ? pattern.slice(0, -2) : null;
  assert.doesNotMatch(prefix ?? pattern, /[!*?\[\]{}]/, `unsupported path policy: ${pattern}`);
  return prefix === null ? file === pattern : file.startsWith(prefix);
}

function circleMatches(file) {
  const result = spawnSync('grep', ['-Eq', route[2]], { input: `${file}\n`, encoding: 'utf8' });
  assert.ok(result.status === 0 || result.status === 1, result.stderr || 'CircleCI path regex is invalid');
  return result.status === 0;
}

const policies = [
  ...['pull_request', 'push'].map((event) => {
    const paths = githubPaths(event);
    return [event, (file) => paths.some((pattern) => globMatches(pattern, file))];
  }),
  ['CircleCI', circleMatches],
];

function dependencyGraph(readSource = read) {
  const files = new Set();
  function visit(file) {
    if (files.has(file)) return;
    files.add(file);
    const module = new vm.SourceTextModule(readSource(file), { identifier: file });
    for (const specifier of module.dependencySpecifiers) {
      if (isBuiltin(specifier)) continue;
      assert.ok(specifier.startsWith('.'), `untracked package dependency ${specifier} from ${file}`);
      const dependency = relative(root, resolve(root, dirname(file), specifier));
      assert.ok(!dependency.startsWith('..'), `dependency outside repository: ${dependency}`);
      visit(dependency);
    }
  }
  visit(entry);
  return files;
}

function assertCoverage(files) {
  for (const [provider, matches] of policies) {
    for (const file of files) assert.ok(matches(file), `${provider} omits dependency ${file}`);
  }
}

const graph = dependencyGraph();
for (const file of ['js/userscript/chatgpt-adapter.js', 'js/ai/dev/workers/contracts.js', 'js/userscript/chatgpt-selectors.js']) {
  assert.ok(graph.has(file), `counterexample must remain in the actual dependency graph: ${file}`);
}
assertCoverage(graph);

// Existing source, test and workflow changes still route to both providers.
assertCoverage([entry, self, workflowPath, 'js/userscript/dev/single-tab/single-conversation-worker-coordinator.js']);
for (const [provider, matches] of policies) {
  for (const file of ['docs/unrelated.md', 'js/decompiler/unrelated.js', 'js/userscript-extra/unrelated.js']) {
    assert.equal(matches(file), false, `${provider} must retain unrelated-change skipping: ${file}`);
  }
}
assert.equal(circleMatches(circlePath), true);
assert.equal(circleMatches('scripts/ci/circleci-impact.sh'), true);
assert.equal(circleMatches('tests/ci/circleci-impact.test.mjs'), true);

// A future import edge outside the watched directories must fail even when it
// is transitive. No repository fixture is written or production code executed.
const future = 'js/shared/future-resilience-dependency.js';
for (const parent of [entry, 'js/userscript/chatgpt-adapter.js']) {
  const specifier = parent === entry ? `../../${future}` : '../shared/future-resilience-dependency.js';
  const mutated = dependencyGraph((file) => file === future ? 'export const sentinel = true;' :
    read(file) + (file === parent ? `\nexport { sentinel } from '${specifier}';\n` : ''));
  assert.ok(mutated.has(future), 'parser must discover the injected import edge');
  for (const [provider, matches] of policies) {
    assert.equal(matches(future), false, `${provider} must expose the simulated dependency drift`);
  }
  assert.throws(() => assertCoverage(mutated), /omits dependency js\/shared\/future-resilience-dependency\.js/);
}

// Coverage cannot guard itself behind the impact decision it is validating.
const coverageStep = job.indexOf(`command: node ${self}`);
const impactStep = job.indexOf('name: Detect agent-loop impact');
assert.ok(coverageStep >= 0 && coverageStep < impactStep, 'dependency coverage must run before impact filtering');
assert.match(read('tests/ci-development-mode.mjs'), /^import '\.\/dev-agent\/agent-loop-trigger-coverage\.mjs';$/m,
  'canonical CI policy entry must discover coverage');
const fastWorkflow = read('.github/workflows/pr-fast-gate.yml');
const fastPullRequest = fastWorkflow.match(/^  pull_request:\n((?:^    .*\n|^\n)*)/m)?.[1];
assert.ok(fastPullRequest, 'PR fast gate must retain automatic regression discovery');
assert.doesNotMatch(fastPullRequest, /^    paths(?:-ignore)?:/m, 'coverage cannot share an impact filter');
assert.match(fastWorkflow, /run: node tests\/ci-development-mode\.mjs/, 'unfiltered PR fast gate must execute coverage');
assert.match(workflow, /^  workflow_dispatch:/m, 'manual GitHub fallback is retained');
assert.match(workflow, /^    branches: \[main\]$/m, 'automatic GitHub pushes stay main-only');
assert.match(workflow, /^    if: \$\{\{ github\.event_name == 'workflow_dispatch' \}\}$/m,
  'automatic execution stays offloaded to CircleCI without allocating a GitHub runner');
assert.match(job, /^    resource_class: small$/m, 'resilience retains the existing runner allocation');
assert.match(job, /node tests\/dev-agent\/agent-loop-resilience\.mjs/, 'actual runtime regressions remain wired');
console.log(`agent-loop trigger coverage: PASS (${graph.size} repository modules; both GitHub events and CircleCI; direct/transitive drift rejected)`);
