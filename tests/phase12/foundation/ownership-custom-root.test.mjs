import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { inventoryFromGit } from '../../../tools/validation/phase12/ownership.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phase12-ownership-root-'));

function git(args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || `git ${args.join(' ')} failed`);
  return result.stdout.trim();
}

try {
  git(['init', '--quiet']);
  git(['config', 'user.name', 'Phase12 Test']);
  git(['config', 'user.email', 'phase12-test@example.invalid']);

  fs.writeFileSync(path.join(root, 'base.txt'), 'base\n');
  git(['add', 'base.txt']);
  git(['commit', '--quiet', '-m', 'base']);
  const baseSha = git(['rev-parse', 'HEAD']);

  fs.writeFileSync(path.join(root, 'head.txt'), 'head\n');
  git(['add', 'head.txt']);
  git(['commit', '--quiet', '-m', 'head']);
  const headSha = git(['rev-parse', 'HEAD']);

  assert.deepEqual(inventoryFromGit(baseSha, headSha, root), ['head.txt']);
  assert.throws(() => inventoryFromGit('0'.repeat(40), headSha, root));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('phase12 ownership custom-root regression: PASS');
