import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildPlan, changedPaths, parseArgs } from '../scripts/run-development-check.mjs';

const plan = options => buildPlan({ exists: () => true, ...options });
test('small fixture changes select a single regression, never historical replay or a full suite', () => {
  const p = plan({ paths: ['tests/phase12/rebuild/f6-pe-layout-cell.test.mjs'] });
  assert.deepEqual(p.commands, [['node', 'tests/phase12/rebuild/f6-pe-layout-cell.test.mjs']]);
  assert.equal(p.releaseEvaluated, false);
});
test('source-only changes without known tests ask for a focused selection', () => {
  assert.equal(plan({ paths: ['js/new-module.js'] }).needsSelection, true);
  assert.equal(plan({ paths: ['js/new-module.js'], tests: ['tests/existing.test.mjs'] }).needsSelection, false);
});
test('changed tests are deduplicated and missing explicit tests are errors', () => {
  assert.equal(plan({ paths: ['tests/a.test.mjs'], tests: ['tests/a.test.mjs'] }).commands.length, 1);
  assert.throws(() => plan({ paths: [], tests: ['../outside.mjs'] }), /Not an executable test/);
  assert.throws(() => buildPlan({ paths: [], tests: ['tests/gone.test.mjs'], exists: () => false }), /Not an executable test/);
});
test('fixture data and support modules are not treated as executable regressions', () => {
  assert.equal(plan({ paths: ['tests/phase12/fixtures/sample.mjs', 'tests/support/reporter.mjs'] }).commands.length, 0);
});
test('existing task ownership selects owned tests without checkpoint prerequisites', () => {
  const p = plan({ paths: ['js/core/scheduler/analysis-scheduler.js'], ownership: {
    tasks: { T059: { allowedPaths: ['js/core/scheduler/**'] } },
  } });
  assert.deepEqual(p.commands, [['node', 'tests/final-closure/run.mjs', '--group', 't059']]);
});
test('documentation-only edits do not schedule expensive checks', () => {
  const p = plan({ paths: ['docs/ENGINEERING_PROCESS_GUARDRAILS.md'] });
  assert.deepEqual(p.commands, []);
  assert.equal(p.needsSelection, false);
});
test('script selection rejects unknown and recursive commands; options are explicit', () => {
  assert.throws(() => plan({ paths: [], scripts: ['check:dev'], packageScripts: { 'check:dev': 'node foo' } }), /recursive/);
  assert.throws(() => plan({ paths: [], scripts: ['missing'] }), /Unknown/);
  assert.throws(() => parseArgs(['--base']), /Missing/);
  assert.throws(() => parseArgs(['--release']), /Unknown/);
});
test('diff discovery includes staged, unstaged, deleted and new paths relative to the chosen base', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-dev-selection-'));
  const git = args => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  try {
    git(['init', '-q']);
    fs.writeFileSync(path.join(root, 'a.mjs'), 'original');
    fs.writeFileSync(path.join(root, 'gone.mjs'), 'original');
    git(['add', '.']);
    git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base']);
    fs.writeFileSync(path.join(root, 'a.mjs'), 'changed');
    git(['add', 'a.mjs']);
    fs.unlinkSync(path.join(root, 'gone.mjs'));
    fs.writeFileSync(path.join(root, 'new.mjs'), 'new');
    assert.deepEqual(changedPaths(root, 'HEAD'), ['a.mjs', 'gone.mjs', 'new.mjs']);
    assert.throws(() => changedPaths(root, 'not-a-ref'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('default PR workflow does not run checkpoint history; broad checks require dispatch', () => {
  const workflow = fs.readFileSync(new URL('../.github/workflows/final-closure-preflight.yml', import.meta.url), 'utf8');
  const development = workflow.split('  development:\n')[1].split('\n  batch:')[0];
  assert.match(development, /npm run check:dev/);
  assert.match(development, /ref: \$\{\{ github.sha \}\}/);
  assert.doesNotMatch(workflow, /--run-checkpoint-verification|--run-component-gates/);
  assert.doesNotMatch(development, /npm run check\s*$|final-closure\/run\.mjs/m);
  assert.match(workflow, /inputs.mode == 'release'/);
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(pkg.scripts.test, /^node tests\/final-closure\/run\.mjs --product && /);
  assert.equal(pkg.scripts['test:legacy-checkpoints'], 'node tests/final-closure/run.mjs');
});

test('changed legacy history contracts do not reschedule historical replay automatically', () => {
  const p = plan({ paths: ['tests/final-closure/preflight.test.mjs', 'tests/development-check.test.mjs'] });
  assert.deepEqual(p.commands, [['node', 'tests/development-check.test.mjs']]);
});
test('owned group and changed member are run once', () => {
  const p = plan({ paths: ['js/a.js', 'tests/final-closure/t059/a.test.mjs'], ownership: {
    tasks: { T059: { allowedPaths: ['js/a.js'] } },
  } });
  assert.equal(p.commands.length, 1);
});
test('product discovery retains every current task regression and future nonlegacy tests', async () => {
  const { discoverFinalClosureTests, LEGACY_CHECKPOINT_TESTS } = await import('./final-closure/run.mjs');
  const selected = discoverFinalClosureTests().filter(p => !LEGACY_CHECKPOINT_TESTS.has(p));
  for (const task of ['t051', 't052', 't057', 't059']) assert.ok(selected.some(p => p.startsWith(task + '/')));
  assert.equal(selected.some(p => LEGACY_CHECKPOINT_TESTS.has(p)), false);
  assert.equal(LEGACY_CHECKPOINT_TESTS.has('future-regression.test.mjs'), false);
});
test('focused CLI propagates child failure and executes in its declared root', async () => {
  const { main } = await import('../scripts/run-development-check.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-dev-failure-'));
  const git = args => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  try {
    git(['init', '-q']);
    fs.mkdirSync(path.join(root, 'tests'));
    fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module","scripts":{}}');
    fs.writeFileSync(path.join(root, 'tests/fails.test.mjs'), 'process.exit(7);');
    fs.writeFileSync(path.join(root, 'tests/cwd.test.mjs'),
      `import assert from 'node:assert/strict'; assert.equal(process.cwd(), ${JSON.stringify(root)});`);
    git(['add', '.']);
    git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base']);
    assert.equal(await main(['--test', 'tests/fails.test.mjs'], root), 7);
    assert.equal(await main(['--test', 'tests/cwd.test.mjs'], root), 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('CI requires explicit test selection for workflow/config-only edits', () => {
  for (const p of ['.github/workflows/another.yml', 'wrangler.jsonc', 'tools/profile.json']) {
    assert.equal(plan({ paths: [p] }).needsSelection, true);
  }
});
test('workflow preserves repository trust and manual batch rejects meta-script shortcuts', () => {
  const workflow = fs.readFileSync(new URL('../.github/workflows/final-closure-preflight.yml', import.meta.url), 'utf8');
  assert.match(workflow, /head.repo.full_name == github.repository/);
  assert.match(workflow, /base.repo.full_name == github.repository/);
  assert.match(workflow, /run-development-check.mjs --script "\$SUBSYSTEM"/);
  for (const name of ['check:dev', 'check:one', 'check:parallel']) {
    assert.throws(() => plan({ paths: [], scripts: [name], packageScripts: { [name]: 'node whatever' } }), /recursive/);
  }
});
