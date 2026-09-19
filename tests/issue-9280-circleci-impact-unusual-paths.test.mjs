import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const router = path.resolve('scripts/ci/circleci-impact.sh');

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function route(repo, head, branch, mode = 'main-and-branch', pattern = '^js/ui/') {
  git(repo, 'checkout', '--detach', head);
  const result = spawnSync('bash', [router, mode, pattern], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, CIRCLE_BRANCH: branch },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

test('#9280 quoted/unusual Git pathnames cannot false-skip gated prefixes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-9280-'));
  const repo = path.join(root, 'repo');
  const remote = path.join(root, 'remote.git');
  try {
    fs.mkdirSync(repo);
    git(repo, 'init', '-b', 'main');
    git(repo, 'config', 'user.name', 'Impact Test');
    git(repo, 'config', 'user.email', 'impact@example.invalid');
    fs.writeFileSync(path.join(repo, 'README.md'), 'base\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'base');
    const base = git(repo, 'rev-parse', 'HEAD');

    for (const [index, suffix] of ['probe\ncase.js', 'probe\tcase.js', 'probe\\case.js'].entries()) {
      const target = path.join(repo, 'js', 'ui', suffix);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, `${index}\n`);
      git(repo, 'add', '--', path.relative(repo, target));
      git(repo, 'commit', '-m', `unusual gated path ${index}`);
      const head = git(repo, 'rev-parse', 'HEAD');
      assert.equal(route(repo, head, 'main'), 'true');
    }

    const docs = path.join(repo, 'docs', 'probe\ncase.md');
    fs.mkdirSync(path.dirname(docs), { recursive: true });
    fs.writeFileSync(docs, 'docs\n');
    git(repo, 'add', '--', path.relative(repo, docs));
    git(repo, 'commit', '-m', 'unusual docs path');
    const docsHead = git(repo, 'rev-parse', 'HEAD');
    assert.equal(route(repo, docsHead, 'main'), 'false');

    git(repo, 'checkout', '-B', 'main', base);
    execFileSync('git', ['clone', '--bare', repo, remote], { encoding: 'utf8' });
    git(repo, 'remote', 'add', 'origin', remote);
    git(repo, 'checkout', '-b', 'feature');
    const featurePath = path.join(repo, 'js', 'ui', 'feature\nprobe.js');
    fs.mkdirSync(path.dirname(featurePath), { recursive: true });
    fs.writeFileSync(featurePath, 'feature\n');
    git(repo, 'add', '--', path.relative(repo, featurePath));
    git(repo, 'commit', '-m', 'feature unusual gated path');
    git(repo, 'push', '-u', 'origin', 'feature');
    const featureHead = git(repo, 'rev-parse', 'HEAD');
    assert.equal(route(repo, featureHead, 'feature'), 'true');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
