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

assert.deepEqual(CANONICAL_GENERATED_OUTPUT_PATHS, [TEMPLATE, RELEASE]);
assert.equal(resolveCanonicalGeneratedOutputCommit({ eventName: 'push', refName: 'main', changedPaths: [TEMPLATE, RELEASE] }).canCommit, true);
assert.deepEqual(resolveCanonicalGeneratedOutputCommit({ eventName: 'push', refName: 'main', changedPaths: [TEMPLATE] }).paths, [TEMPLATE]);
assert.equal(resolveCanonicalGeneratedOutputCommit({ eventName: 'push', refName: 'release', changedPaths: [RELEASE] }).canCommit, true);
assert.equal(resolveCanonicalGeneratedOutputCommit({ eventName: 'push', refName: 'feature/x', changedPaths: [TEMPLATE] }).canCommit, false);
assert.equal(resolveCanonicalGeneratedOutputCommit({ eventName: 'pull_request', refName: 'main', changedPaths: [TEMPLATE] }).canCommit, false);
assert.equal(resolveCanonicalGeneratedOutputCommit({ eventName: 'pull_request', refName: 'main', changedPaths: [TEMPLATE] }).permitted, false);
assert.equal(resolveCanonicalGeneratedOutputCommit({ eventName: 'push', refName: 'main', changedPaths: [] }).permitted, true);
assert.equal(resolveCanonicalGeneratedOutputCommit({ eventName: 'workflow_dispatch', changedPaths: [TEMPLATE] }).canCommit, true);
assert.equal(resolveCanonicalGeneratedOutputCommit({ eventName: 'push', refName: 'main', changedPaths: [TEMPLATE, 'js/app.js'] }).canCommit, false);
assert.deepEqual(resolveCanonicalGeneratedOutputCommit({ eventName: 'push', refName: 'main', changedPaths: [TEMPLATE, 'js/app.js'] }).offList, ['js/app.js']);
assert.equal(resolveCanonicalGeneratedOutputCommit({ eventName: 'push', refName: 'main', changedPaths: [TEMPLATE], deletedPaths: [RELEASE] }).canCommit, false);
assert.equal(resolveCanonicalGeneratedOutputCommit({ eventName: 'push', refName: 'main', changedPaths: [] }).canCommit, false);
assert.deepEqual(resolveCanonicalGeneratedOutputCommit({ eventName: 'push', refName: 'main', changedPaths: [TEMPLATE.replaceAll('/', '\\')] }).paths, [TEMPLATE]);

function sh(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error('git ' + args.join(' ') + ': ' + (result.stderr || result.stdout));
  return result.stdout.trim();
}

function runSync(env, args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: work,
    encoding: 'utf8',
    env: { ...process.env, npm_config_prefix: '', GITHUB_EVENT_NAME: 'push', GITHUB_REF_NAME: 'main', ...env },
  });
}

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-usersync-'));
const origin = path.join(sandbox, 'origin.git');
const work = path.join(sandbox, 'work');
sh(sandbox, ['init', '--bare', '--initial-branch=main', 'origin.git']);
sh(sandbox, ['clone', origin, 'work']);
fs.mkdirSync(path.join(work, 'userscript'), { recursive: true });
fs.mkdirSync(path.join(work, 'scripts'), { recursive: true });
fs.mkdirSync(path.join(work, 'js'), { recursive: true });
fs.writeFileSync(path.join(work, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { 'userscript:build': 'node scripts/build-userscript.mjs' } }, null, 2) + '\n');
fs.writeFileSync(path.join(work, 'scripts/build-userscript.mjs'), [
  'import fs from "node:fs";',
  'const next = Number(fs.readFileSync("userscript/hex.user.template.js","utf8")) + 1;',
  'fs.writeFileSync("userscript/hex.user.template.js", String(next));',
  'fs.writeFileSync("userscript/release-version.json", JSON.stringify({ serial: next }) + "\\n");',
  '',
].join('\n'));
fs.writeFileSync(path.join(work, TEMPLATE), '1');
fs.writeFileSync(path.join(work, RELEASE), '{"serial": 1}\n');
fs.writeFileSync(path.join(work, 'js/app.js'), 'export const answer = 42;\n');
sh(work, ['add', '-A']);
sh(work, ['-c', 'user.name=tester', '-c', 'user.email=tester@example.invalid', 'commit', '-m', 'seed']);
sh(work, ['push', '-u', 'origin', 'HEAD:refs/heads/main']);

assert.match(runSync({}, []).stdout, /no canonical diff to commit/);

const cleanSha = sh(origin, ['rev-parse', 'main']);
assert.equal(runSync({}, ['--rebuild']).status, 0);
assert.notEqual(sh(origin, ['rev-parse', 'main']), cleanSha, 'sync commit must advance main');
assert.equal(sh(origin, ['show', 'main:' + TEMPLATE]).trim(), '2');
assert.equal(sh(work, ['status', '--porcelain', '--untracked-files=all']), '', 'worktree must be clean after sync');
assert.equal(sh(work, ['log', '-1', '--format=%an']), 'github-actions[bot]');

fs.writeFileSync(path.join(work, 'js/app.js'), 'export const answer = 43;\n');
fs.writeFileSync(path.join(work, TEMPLATE), '3');
const preRejected = sh(origin, ['rev-parse', 'main']);
const rejected = runSync({}, ['--rebuild']);
assert.equal(rejected.status, 1);
assert.match(rejected.stderr, /non-canonical changes present/);
assert.equal(sh(origin, ['rev-parse', 'main']), preRejected, 'off-list changes must not touch main');
sh(work, ['checkout', '--', 'js/app.js', TEMPLATE]);

fs.writeFileSync(path.join(work, TEMPLATE), '4');
const wrongContext = runSync({ GITHUB_EVENT_NAME: 'pull_request' }, []);
assert.equal(wrongContext.status, 1);
assert.match(wrongContext.stderr, /context not permitted/);
sh(work, ['checkout', '--', TEMPLATE]);

sh(work, ['rm', '-f', RELEASE]);
const deleted = runSync({}, []);
assert.equal(deleted.status, 1);
assert.match(deleted.stderr, /missing from the worktree|deleted canonical/);
sh(work, ['checkout', 'HEAD', '--', RELEASE]);

const work2 = path.join(sandbox, 'work2');
sh(sandbox, ['clone', origin, 'work2']);
fs.writeFileSync(path.join(work2, 'README.md'), 'late\n');
sh(work2, ['add', '-A']);
sh(work2, ['-c', 'user.name=late', '-c', 'user.email=late@example.invalid', 'commit', '-m', 'late merge']);
sh(work2, ['push', 'origin', 'HEAD:refs/heads/main']);
fs.writeFileSync(path.join(work, TEMPLATE), '9');
const raced = runSync({}, ['--rebuild']);
assert.equal(raced.status, 0);
assert.match(raced.stdout, /push rejected/);
assert.equal(sh(origin, ['show', 'main:README.md']).trim(), 'late');
const originTemplate = Number(sh(origin, ['show', 'main:' + TEMPLATE]).trim());
assert.ok(originTemplate > 9, 'canonical output must be rebuilt after the rebase retry');
assert.equal(sh(origin, ['show', 'main:' + TEMPLATE]).trim(), sh(work, ['show', 'HEAD:' + TEMPLATE]).trim());

const preDispatchSha = sh(origin, ['rev-parse', 'main']);
const dispatchIdle = runSync({ GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF_NAME: '' }, ['--dispatch-paths=' + TEMPLATE + ',' + RELEASE]);
assert.equal(dispatchIdle.status, 0);
assert.match(dispatchIdle.stdout, /no canonical diff to commit/);
assert.equal(sh(origin, ['rev-parse', 'main']), preDispatchSha);
const dispatchHeal = runSync({ GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF_NAME: '' }, ['--rebuild', '--dispatch-paths=' + TEMPLATE + ',' + RELEASE]);
assert.equal(dispatchHeal.status, 0);
assert.notEqual(sh(origin, ['rev-parse', 'main']), preDispatchSha, 'manual dispatch must advance main with a canonical sync');

console.log('sync generated userscript: ok');
