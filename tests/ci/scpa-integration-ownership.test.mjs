import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  SCPA_INTEGRATION_BRANCH as branch,
  loadScpaManifest, validateScpaManifest, validateScpaInventory, runCli,
} from '../../tools/validation/scpa-integration-ownership.mjs';
import { loadManifest as load7, validateFiles as validate7 } from '../../tools/validation/phase7-ownership.mjs';
import { loadManifest as load8, validateFiles as validate8 } from '../../tools/validation/phase8-ownership.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const manifest = loadScpaManifest();
const inventory = Object.values(manifest.owners).flat();
const phase7Path = 'js/analysis/query/api.js';
const phase8Path = 'js/decompiler/phase8/sccp.js';
const corePath = 'js/core/identity/world.js';
const subset = [phase7Path, phase8Path, corePath];
const capture = () => { let text = ''; return { write: (chunk) => { text += chunk; }, text: () => text }; };

test('SCPA integration routes its complete explicit inventory through unchanged phase validators', () => {
  assert.equal(validateScpaManifest(manifest).size, inventory.length);
  for (const [phase, load, validate] of [[7, load7, validate7], [8, load8, validate8]]) {
    assert.equal(validate(load(), inventory).valid, false, 'the component validator must still reject the cross-phase union');
    const owned = validateScpaInventory(branch, phase, inventory);
    assert.ok(owned.length > 0 && owned.length < inventory.length);
    assert.equal(validate(load(), owned).valid, true);
    assert.equal(owned.includes(corePath), false, 'core ownership must not be relabeled as Phase 7/8');
  }
  assert.equal(validate7(load7(), [corePath]).valid, false);
  assert.equal(validate8(load8(), [corePath]).valid, false);
});

test('even an otherwise phase-owned path needs explicit integration registration', () => {
  for (const phase of [7, 8]) {
    for (const foreign of ['js/analysis/unregistered.js', 'js/decompiler/phase8/unregistered.js', 'js/semantics/ssa/build.js', 'js/ui/product.js']) {
      assert.throws(() => validateScpaInventory(branch, phase, [...subset, foreign]), /unregistered paths/);
    }
  }
});

test('the integration route cannot be activated by similar branch names or unsupported phases', () => {
  for (const other of ['', 'main', `${branch}-similar`, 'feat/scpa-functional-acceptance']) {
    assert.throws(() => validateScpaInventory(other, 7, subset), /no SCPA integration route/);
  }
  for (const phase of [0, 9, '7', null, NaN]) {
    assert.throws(() => validateScpaInventory(branch, phase, subset), /phase must be 7 or 8/);
  }
});

test('empty inventories, missing phase evidence, and malformed repository paths fail closed', () => {
  for (const files of [[], null, ['../outside.js'], ['/tmp/file'], ['js/analysis/../other.js'], ['js\\analysis\\query.js'], ['js/analysis/query/api.js\n']]) {
    assert.throws(() => validateScpaInventory(branch, 7, files), /exact repository paths/);
  }
  assert.throws(() => validateScpaInventory(branch, 7, [corePath, phase8Path]), /no Phase 7-owned paths/);
  assert.throws(() => validateScpaInventory(branch, 8, [corePath, phase7Path]), /no Phase 8-owned paths/);
});

test('manifest corruption cannot broaden ownership or contradict a phase contract', () => {
  const mutate = (change) => { const copy = structuredClone(manifest); change(copy); return copy; };
  for (const file of ['js/core/**', '../outside.js', '/tmp/file', 'js/core/[identity].js']) {
    assert.throws(() => validateScpaManifest(mutate((copy) => copy.owners.core.push(file))), /exact repository paths/);
  }
  assert.throws(() => validateScpaManifest(mutate((copy) => copy.owners.integration.push(corePath))), /duplicate SCPA ownership/);
  assert.throws(() => validateScpaManifest(mutate((copy) => { copy.owners.unknown = ['unknown.js']; })), /unknown or missing owner/);
  assert.throws(() => validateScpaManifest(mutate((copy) => { copy.branch += '-similar'; })), /invalid SCPA/);
  assert.throws(() => validateScpaManifest(mutate((copy) => {
    copy.owners.core = copy.owners.core.filter((file) => file !== corePath);
    copy.owners.phase7.push(corePath);
  })), /contradicts its phase contract/);
  for (const [file, source, destination] of [
    [corePath, 'core', 'documentation'],
    ['js/semantics/compat/index.js', 'semantic-compatibility', 'phase7'],
    ['js/knowledge/index.js', 'binary-apple-recognition', 'phase7'],
    [phase8Path, 'phase8', 'integration'],
  ]) {
    assert.throws(() => validateScpaManifest(mutate((copy) => {
      copy.owners[source] = copy.owners[source].filter((item) => item !== file);
      copy.owners[destination].push(file);
    })), /owner responsibility mismatch/);
  }
  assert.throws(() => validateScpaManifest(mutate((copy) => {
    delete copy.ownerResponsibilities['semantic-compatibility'];
  })), /document every owner responsibility/);
});

test('CLI uses exact Git inventory, including deleted foreign files, before emitting phase paths', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scpa-ownership-'));
  function git(...args) {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'ownership-test', GIT_AUTHOR_EMAIL: 'ownership@example.invalid', GIT_COMMITTER_NAME: 'ownership-test', GIT_COMMITTER_EMAIL: 'ownership@example.invalid' } });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  const write = (file, body) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), body); };
  const run = (base, head, phase = '7') => {
    const stdout = capture(), stderr = capture();
    const status = runCli(['--branch', branch, '--phase', phase, '--base-sha', base, '--head-sha', head], { root, stdout, stderr });
    return { status, stdout: stdout.text(), stderr: stderr.text() };
  };
  try {
    git('init', '--quiet');
    for (const file of [...subset, 'unregistered-delete.js']) write(file, 'base\n');
    write('unregistered-rename.js', 'distinct foreign ownership source\n');
    git('add', '.'); git('commit', '--quiet', '-m', 'base');
    const base = git('rev-parse', 'HEAD');
    for (const file of subset) write(file, 'candidate\n');
    git('add', '.'); git('commit', '--quiet', '-m', 'registered candidate');
    const goodHead = git('rev-parse', 'HEAD');
    for (const [phase, expected] of [['7', phase7Path], ['8', phase8Path]]) {
      const result = run(base, goodHead, phase);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), [expected]);
    }
    git('rm', '--quiet', 'unregistered-delete.js'); git('commit', '--quiet', '-m', 'unregistered deletion');
    const rejected = run(base, git('rev-parse', 'HEAD'));
    assert.equal(rejected.status, 1);
    assert.equal(rejected.stdout, '', 'no subset may escape before full-inventory validation');
    assert.match(rejected.stderr, /unregistered-delete\.js/);
    assert.equal(run('HEAD~1', goodHead).status, 1, 'symbolic references are not exact proof identity');
    assert.equal(run(base, goodHead, '07').status, 1);
    git('checkout', '--quiet', '--detach', goodHead);
    git('mv', 'unregistered-rename.js', 'js/core/identity/structured.js');
    git('commit', '--quiet', '-m', 'foreign source renamed to registered destination');
    const renameHead = git('rev-parse', 'HEAD');
    assert.match(git('diff', '--name-status', '--find-renames', goodHead, renameHead), /R100\s+unregistered-rename\.js/);
    for (const phase of ['7', '8']) {
      const renamed = run(base, renameHead, phase);
      assert.equal(renamed.status, 1);
      assert.equal(renamed.stdout, '');
      assert.match(renamed.stderr, /unregistered-rename\.js/, 'rename source deletion must remain in the complete inventory');
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('both CI providers route through whole-inventory validation and preserve the old negative controls', () => {
  const circle = fs.readFileSync(path.join(ROOT, '.circleci/config.yml'), 'utf8');
  for (const phase of [7, 8]) {
    const github = fs.readFileSync(path.join(ROOT, `.github/workflows/phase${phase}-ownership.yml`), 'utf8');
    const start = circle.indexOf(`  phase${phase}-ownership:`);
    const tail = circle.slice(start);
    const end = tail.slice(1).search(/^  [a-z][a-z0-9-]*:/m);
    const circleJob = end < 0 ? tail : tail.slice(0, end + 1);
    for (const workflow of [circleJob, github]) {
      assert.ok(workflow.includes(branch));
      assert.ok(workflow.includes('node --test tests/ci/scpa-integration-ownership.test.mjs'));
      const helper = workflow.indexOf('FILES_JSON="$(node tools/validation/scpa-integration-ownership.mjs');
      assert.ok(helper >= 0);
      const remaining = workflow.slice(helper);
      assert.match(remaining, new RegExp(`--phase ${phase}`));
      assert.ok(remaining.indexOf(`node tools/validation/phase${phase}-ownership.mjs --files-json "$FILES_JSON"`) > 0);
      assert.ok(workflow.includes(phase === 7 ? 'js/semantics/ir/nodes.js' : 'js/semantics/ssa/build.js'));
    }
    for (const file of ['tools/validation/phase5-ownership.mjs', 'tools/validation/scpa-integration-ownership.mjs', 'tools/validation/phase-ownership/scpa-integration.json', 'tests/ci/scpa-integration-ownership.test.mjs']) {
      assert.ok(github.includes(`- '${file}'`), `${file} must trigger the manual fallback definition's PR path contract`);
      assert.ok(circleJob.includes(file.replaceAll('.', '\\.')), `${file} must trigger CircleCI impact detection`);
    }
  }
});

test('CircleCI always checks the registered integration branch, including changes outside phase trigger paths', () => {
  const circle = fs.readFileSync(path.join(ROOT, '.circleci/config.yml'), 'utf8');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scpa-impact-'));
  try {
    for (const phase of [7, 8]) {
      const start = circle.indexOf(`          name: Detect Phase ${phase} ownership impact`);
      const body = circle.slice(start).split('          command: |\n')[1].split('\n      - run:')[0];
      const script = body.split('\n').map((line) => line.replace(/^ {12}/, '')).join('\n');
      const bashEnv = path.join(root, `phase${phase}.env`);
      // Run in an empty directory: the generic impact helper is unavailable.
      // This must nevertheless run the whole-inventory integration gate.
      const result = spawnSync('bash', ['-c', script], { cwd: root, encoding: 'utf8',
        env: { ...process.env, CIRCLE_BRANCH: branch, BASH_ENV: bashEnv } });
      assert.equal(result.status, 0, result.stderr);
      assert.match(fs.readFileSync(bashEnv, 'utf8'), new RegExp(`^export RUN_PHASE${phase}_OWNERSHIP=true$`, 'm'));
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
