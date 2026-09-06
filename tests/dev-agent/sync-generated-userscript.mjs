import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CANONICAL_GENERATED_OUTPUT_PATHS,
  resolveCanonicalGeneratedOutputCommit,
} from '../../tools/validation/generated-output-policy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(ROOT, 'scripts/sync-generated-userscript.mjs');
const [TEMPLATE, RELEASE] = CANONICAL_GENERATED_OUTPUT_PATHS;

assert.deepEqual(CANONICAL_GENERATED_OUTPUT_PATHS, [
  'userscript/hex.user.template.js',
  'userscript/release-version.json',
]);
assert.equal(resolveCanonicalGeneratedOutputCommit({ eventName: 'push', refName: 'main', changedPaths: [TEMPLATE, RELEASE] }).canCommit, true);
assert.equal(resolveCanonicalGeneratedOutputCommit({ eventName: 'push', refName: 'release', changedPaths: [TEMPLATE] }).canCommit, true);
assert.equal(resolveCanonicalGeneratedOutputCommit({ eventName: 'workflow_dispatch', refName: 'main', changedPaths: [RELEASE] }).canCommit, true);
assert.equal(resolveCanonicalGeneratedOutputCommit({ eventName: 'workflow_dispatch', refName: 'feature/x', changedPaths: [RELEASE] }).canCommit, false);
assert.equal(resolveCanonicalGeneratedOutputCommit({ eventName: 'pull_request', refName: 'main', changedPaths: [TEMPLATE] }).canCommit, false);
assert.equal(resolveCanonicalGeneratedOutputCommit({ eventName: 'push', refName: 'feature/x', changedPaths: [TEMPLATE] }).canCommit, false);
assert.equal(resolveCanonicalGeneratedOutputCommit({ eventName: 'push', refName: 'main', changedPaths: [TEMPLATE, 'js/app.js'] }).canCommit, false);
assert.deepEqual(resolveCanonicalGeneratedOutputCommit({ eventName: 'push', refName: 'main', changedPaths: [TEMPLATE, 'js/app.js'] }).offList, ['js/app.js']);
assert.equal(resolveCanonicalGeneratedOutputCommit({ eventName: 'push', refName: 'main', changedPaths: [TEMPLATE], deletedPaths: [RELEASE] }).canCommit, false);
assert.equal(resolveCanonicalGeneratedOutputCommit({ eventName: 'push', refName: 'main', changedPaths: [] }).canCommit, false);
assert.deepEqual(resolveCanonicalGeneratedOutputCommit({ eventName: 'push', refName: 'main', changedPaths: [`./${TEMPLATE}`] }).paths, [TEMPLATE]);
assert.deepEqual(resolveCanonicalGeneratedOutputCommit({ eventName: 'push', refName: 'main', changedPaths: [TEMPLATE.replaceAll('/', '\\')] }).paths, [TEMPLATE]);

const mainSyncWorkflow = fs.readFileSync(path.join(ROOT, '.github/workflows/generated-userscript-main-sync.yml'), 'utf8');
assert.match(mainSyncWorkflow, /^name: Generated userscript main sync$/m);
assert.match(mainSyncWorkflow, /^  push:$/m);
assert.match(mainSyncWorkflow, /^  workflow_dispatch:$/m);
assert.doesNotMatch(mainSyncWorkflow, /^  pull_request:/m, 'write-capable main sync must never run in pull_request context');
assert.match(mainSyncWorkflow, /^permissions:\n  contents: write$/m);
assert.match(mainSyncWorkflow, /persist-credentials: true/);
assert.match(mainSyncWorkflow, /node tests\/dev-agent\/sync-generated-userscript\.mjs/);
assert.match(mainSyncWorkflow, /node scripts\/sync-generated-userscript\.mjs --rebuild/);

const readOnlySyncWorkflow = fs.readFileSync(path.join(ROOT, '.github/workflows/generated-sync.yml'), 'utf8');
assert.match(readOnlySyncWorkflow, /^permissions:\n  contents: read$/m);
assert.match(readOnlySyncWorkflow, /github\.event_name != 'push'/, 'PR/manual exact-head verification must keep strict committed-output equality');
assert.match(readOnlySyncWorkflow, /github\.event_name == 'push'/, 'main push verifier must validate build side effects without racing the publisher');
assert.match(readOnlySyncWorkflow, /userscript:build changed files outside the generated-output allowlist/);

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
  fs.mkdirSync(path.join(work, 'js'), { recursive: true });
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

  function runSync(env = {}, args = []) {
    return spawnSync(process.execPath, [SCRIPT, ...args], {
      cwd: work,
      encoding: 'utf8',
      env: {
        ...process.env,
        npm_config_prefix: '',
        GITHUB_EVENT_NAME: 'push',
        GITHUB_REF_NAME: 'main',
        ...env,
      },
    });
  }

  let result = runSync();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /already match source/);

  const cleanSha = sh(origin, ['rev-parse', 'main']);
  result = runSync({}, ['--rebuild']);
  assert.equal(result.status, 0, result.stderr);
  assert.notEqual(sh(origin, ['rev-parse', 'main']), cleanSha, 'canonical build must advance main');
  assert.equal(sh(origin, ['show', `main:${TEMPLATE}`]).trim(), '2');
  assert.equal(sh(work, ['status', '--porcelain', '--untracked-files=all']), '', 'successful publisher leaves a clean worktree');
  assert.equal(sh(work, ['log', '-1', '--format=%an']), 'github-actions[bot]');

  fs.writeFileSync(path.join(work, 'js/app.js'), 'export const answer = 43;\n');
  result = runSync({}, ['--rebuild']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /non-canonical changes present/);
  sh(work, ['checkout', '--', 'js/app.js', TEMPLATE, RELEASE]);

  fs.writeFileSync(path.join(work, TEMPLATE), '4');
  result = runSync({ GITHUB_EVENT_NAME: 'pull_request' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /context not permitted/);
  sh(work, ['checkout', '--', TEMPLATE]);

  sh(work, ['rm', '-f', RELEASE]);
  result = runSync();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing from the worktree|deleted canonical output/);
  sh(work, ['checkout', 'HEAD', '--', RELEASE]);

  const work2 = path.join(sandbox, 'work2');
  sh(sandbox, ['clone', origin, 'work2']);
  fs.writeFileSync(path.join(work2, 'README.md'), 'late\n');
  sh(work2, ['add', '-A']);
  sh(work2, ['-c', 'user.name=late', '-c', 'user.email=late@example.invalid', 'commit', '-m', 'late merge']);
  sh(work2, ['push', 'origin', 'HEAD:refs/heads/main']);

  fs.writeFileSync(path.join(work, TEMPLATE), '9');
  result = runSync({}, ['--rebuild']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /push raced with main/);
  assert.equal(sh(origin, ['show', 'main:README.md']).trim(), 'late', 'publisher must retain concurrent source commits');
  assert.ok(Number(sh(origin, ['show', `main:${TEMPLATE}`]).trim()) >= 3, 'publisher must rebuild after resetting to the new main tip');
  assert.equal(sh(work, ['status', '--porcelain', '--untracked-files=all']), '', 'race recovery leaves a clean worktree');
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}

console.log('sync generated userscript: ok');
