import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CANONICAL_GENERATED_OUTPUT_PATHS,
  generatedOutputMode,
  resolveCanonicalGeneratedOutputCommit,
} from '../../tools/validation/generated-output-policy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(ROOT, 'scripts/sync-generated-userscript.mjs');
const [TEMPLATE, RELEASE] = CANONICAL_GENERATED_OUTPUT_PATHS;

assert.deepEqual(CANONICAL_GENERATED_OUTPUT_PATHS, [
  'userscript/hex.user.template.js',
  'userscript/release-version.json',
]);

// During active development main-targeting PRs may keep generated output ephemeral;
// release remains the explicit committed generated-output transaction.
assert.equal(resolveCanonicalGeneratedOutputCommit({ eventName: 'push', refName: 'main', changedPaths: [TEMPLATE, RELEASE] }).canCommit, false);
assert.equal(resolveCanonicalGeneratedOutputCommit({ eventName: 'workflow_dispatch', refName: 'main', changedPaths: [RELEASE] }).canCommit, false);
assert.equal(resolveCanonicalGeneratedOutputCommit({ eventName: 'push', refName: 'release', changedPaths: [TEMPLATE] }).canCommit, true);
assert.equal(resolveCanonicalGeneratedOutputCommit({ eventName: 'workflow_dispatch', refName: 'release', changedPaths: [RELEASE] }).canCommit, true);
assert.equal(resolveCanonicalGeneratedOutputCommit({ eventName: 'push', refName: 'release', changedPaths: [TEMPLATE, 'js/app.js'] }).canCommit, false);
assert.equal(resolveCanonicalGeneratedOutputCommit({ eventName: 'push', refName: 'release', changedPaths: [TEMPLATE], deletedPaths: [RELEASE] }).canCommit, false);

assert.equal(generatedOutputMode({ eventName: 'pull_request', headRef: 'fix/a', baseRef: 'main' }), 'ephemeral');
assert.equal(generatedOutputMode({ eventName: 'pull_request', headRef: 'fix/a', baseRef: 'release' }), 'enforce');
assert.equal(generatedOutputMode({ eventName: 'pull_request', headRef: 'fix/a', baseRef: 'develop' }), 'ephemeral');
assert.equal(generatedOutputMode({ eventName: 'pull_request', headRef: 'dev-agent-hardening/integration/a', baseRef: 'develop' }), 'enforce');

const mainSyncWorkflow = fs.readFileSync(path.join(ROOT, '.github/workflows/generated-userscript-main-sync.yml'), 'utf8');
assert.match(mainSyncWorkflow, /^name: Generated userscript main sync$/m);
assert.match(mainSyncWorkflow, /^permissions:\n  contents: read$/m);
assert.doesNotMatch(mainSyncWorkflow, /^permissions:\n  contents: write$/m);
assert.match(mainSyncWorkflow, /persist-credentials: false/);
assert.match(mainSyncWorkflow, /npm run userscript:build/);
assert.match(mainSyncWorkflow, /git ls-files --error-unmatch --[\s\\]+userscript\/hex\.user\.template\.js[\s\\]+userscript\/release-version\.json/);
assert.match(mainSyncWorkflow, /git diff --exit-code -- userscript\/hex\.user\.template\.js userscript\/release-version\.json/);
assert.doesNotMatch(mainSyncWorkflow, /sync-generated-userscript\.mjs --rebuild/, 'main workflow must never direct-push generated output');

const readOnlySyncWorkflow = fs.readFileSync(path.join(ROOT, '.github/workflows/generated-sync.yml'), 'utf8');
assert.match(readOnlySyncWorkflow, /^permissions:\n  contents: read$/m);
assert.match(readOnlySyncWorkflow, /steps\.generated-policy\.outputs\.mode == 'enforce'/);
assert.match(readOnlySyncWorkflow, /git ls-files --error-unmatch --[\s\\]+userscript\/hex\.user\.template\.js[\s\\]+userscript\/release-version\.json/);
assert.match(readOnlySyncWorkflow, /git diff --exit-code -- userscript\/hex\.user\.template\.js userscript\/release-version\.json/);
assert.doesNotMatch(readOnlySyncWorkflow, /published by the push-only Generated userscript main sync workflow/);

const autofixWorkflow = fs.readFileSync(path.join(ROOT, '.github/workflows/generated-userscript-autofix.yml'), 'utf8');
assert.match(autofixWorkflow, /^permissions:\n  contents: write$/m);
assert.match(autofixWorkflow, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/);
assert.match(autofixWorkflow, /HEAD_REF: \$\{\{ github\.event\.pull_request\.head\.ref \}\}/);
assert.match(autofixWorkflow, /HEAD:\$\{HEAD_REF\}/);
assert.doesNotMatch(autofixWorkflow, /HEAD:refs\/heads\/main/);
assert.match(autofixWorkflow, /tools\/validation\/generated-output-policy\.mjs/);
assert.match(autofixWorkflow, /\.github\/workflows\/generated-userscript-main-sync\.yml/);

function sh(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-usersync-'));
try {
  const origin = path.join(sandbox, 'origin.git');
  const work = path.join(sandbox, 'work');
  sh(sandbox, ['init', '--bare', '--initial-branch=main', 'origin.git']);
  sh(sandbox, ['clone', origin, 'work']);
  fs.mkdirSync(path.join(work, 'userscript'), { recursive: true });
  fs.mkdirSync(path.join(work, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(work, 'tools/validation'), { recursive: true });
  fs.mkdirSync(path.join(work, 'js'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'scripts/sync-generated-userscript.mjs'), path.join(work, 'scripts/sync-generated-userscript.mjs'));
  fs.copyFileSync(path.join(ROOT, 'tools/validation/generated-output-policy.mjs'), path.join(work, 'tools/validation/generated-output-policy.mjs'));
  fs.writeFileSync(path.join(work, 'package.json'), JSON.stringify({
    name: 'fixture',
    scripts: { 'userscript:build': 'node scripts/build-userscript.mjs' },
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(work, 'scripts/build-userscript.mjs'), [
    'import fs from "node:fs";',
    'const next = Number(fs.readFileSync("userscript/hex.user.template.js", "utf8")) + 1;',
    'fs.writeFileSync("userscript/hex.user.template.js", String(next));',
    'fs.writeFileSync("userscript/release-version.json", JSON.stringify({ serial: next }) + "\\n");',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(work, TEMPLATE), '1');
  fs.writeFileSync(path.join(work, RELEASE), '{"serial":1}\n');
  fs.writeFileSync(path.join(work, 'js/app.js'), 'export const answer = 42;\n');
  sh(work, ['add', '-A']);
  sh(work, ['-c', 'user.name=tester', '-c', 'user.email=tester@example.invalid', 'commit', '-m', 'seed']);
  sh(work, ['push', '-u', 'origin', 'HEAD:refs/heads/main']);

  const deletedOutputWork = path.join(sandbox, 'deleted-output');
  sh(sandbox, ['clone', origin, 'deleted-output']);
  sh(deletedOutputWork, ['rm', '--', RELEASE]);
  sh(deletedOutputWork, ['-c', 'user.name=tester', '-c', 'user.email=tester@example.invalid', 'commit', '-m', 'delete canonical output']);
  const rebuildDeletedOutput = spawnSync(process.execPath, ['scripts/build-userscript.mjs'], { cwd: deletedOutputWork, encoding: 'utf8' });
  assert.equal(rebuildDeletedOutput.status, 0, rebuildDeletedOutput.stderr);
  sh(deletedOutputWork, ['restore', '--', TEMPLATE]);
  const legacyExactDiff = spawnSync('git', ['diff', '--exit-code', '--', TEMPLATE, RELEASE], { cwd: deletedOutputWork, encoding: 'utf8' });
  assert.equal(legacyExactDiff.status, 0, 'legacy exact diff must demonstrate the untracked-output blind spot');
  const trackedOutputGuard = spawnSync('git', ['ls-files', '--error-unmatch', '--', TEMPLATE, RELEASE], { cwd: deletedOutputWork, encoding: 'utf8' });
  assert.notEqual(trackedOutputGuard.status, 0, 'recreated-but-untracked canonical output must fail closed');
  assert.match(sh(deletedOutputWork, ['status', '--porcelain', '--untracked-files=all']), /\?\? userscript\/release-version\.json/);

  function runSync(refName, args = []) {
    return spawnSync(process.execPath, ['scripts/sync-generated-userscript.mjs', ...args], {
      cwd: work,
      encoding: 'utf8',
      env: { ...process.env, npm_config_prefix: '', GITHUB_EVENT_NAME: 'push', GITHUB_REF_NAME: refName },
    });
  }

  const mainSha = sh(origin, ['rev-parse', 'main']);
  let result = runSync('main', ['--rebuild']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /context not permitted/);
  assert.equal(sh(origin, ['rev-parse', 'main']), mainSha, 'publisher must never advance protected main');
  sh(work, ['restore', '--', TEMPLATE, RELEASE]);

  sh(work, ['switch', '-c', 'release']);
  sh(work, ['push', '-u', 'origin', 'HEAD:refs/heads/release']);
  const releaseSha = sh(origin, ['rev-parse', 'release']);
  result = runSync('release', ['--rebuild']);
  assert.equal(result.status, 0, result.stderr);
  assert.notEqual(sh(origin, ['rev-parse', 'release']), releaseSha, 'explicit release branch may publish canonical output');
  assert.equal(sh(origin, ['show', `release:${TEMPLATE}`]).trim(), '2');

  fs.writeFileSync(path.join(work, 'js/app.js'), 'export const answer = 43;\n');
  result = runSync('release', ['--rebuild']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /non-canonical changes present/);
  sh(work, ['restore', '--', 'js/app.js', TEMPLATE, RELEASE]);

  const work2 = path.join(sandbox, 'work2');
  sh(sandbox, ['clone', '--branch', 'release', origin, 'work2']);
  fs.writeFileSync(path.join(work2, 'README.md'), 'late\n');
  sh(work2, ['add', '-A']);
  sh(work2, ['-c', 'user.name=late', '-c', 'user.email=late@example.invalid', 'commit', '-m', 'late release change']);
  sh(work2, ['push', 'origin', 'HEAD:refs/heads/release']);

  result = runSync('release', ['--rebuild']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /push raced with release/);
  assert.equal(sh(origin, ['show', 'release:README.md']).trim(), 'late');
  assert.equal(sh(work, ['status', '--porcelain', '--untracked-files=all']), '');
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}

console.log('sync generated userscript protected-main policy: ok');
