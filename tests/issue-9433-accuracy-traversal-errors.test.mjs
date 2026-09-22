import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { partitionFiles, partitionDigest } from '../scripts/accuracy-partition-cache-key.mjs';

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'accuracy-9433-'));
  fs.mkdirSync(path.join(root, 'js', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(root, 'js', 'ok.js'), 'export const ok = true;\n');
  fs.writeFileSync(path.join(root, 'js', 'sub', 'selected.js'), 'export const selected = true;\n');
  return root;
}

for (const code of ['EIO', 'EACCES']) {
  test(`accuracy traversal fails closed when nested realpath raises ${code}`, () => {
    const root = makeRoot();
    const target = path.resolve(root, 'js', 'sub');
    const original = fs.realpathSync;
    try {
      fs.realpathSync = (value, ...args) => {
        if (path.resolve(String(value)) === target) {
          throw Object.assign(new Error(`simulated ${code}`), { code });
        }
        return original(value, ...args);
      };
      assert.throws(() => partitionFiles(root, 'core'), /cannot establish directory identity/);
      assert.throws(() => partitionDigest(root, 'core'), /cannot establish directory identity/);
    } finally {
      fs.realpathSync = original;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test('ordinary nested directory remains part of partition digest', () => {
  const root = makeRoot();
  try {
    const files = partitionFiles(root, 'core');
    assert.ok(files.includes('js/sub/selected.js'));
    const before = partitionDigest(root, 'core');
    fs.writeFileSync(path.join(root, 'js', 'sub', 'selected.js'), 'export const selected = false;\n');
    const after = partitionDigest(root, 'core');
    assert.notEqual(after, before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('broken symlink remains represented instead of becoming a traversal error', () => {
  if (process.platform === 'win32') return;
  const root = makeRoot();
  try {
    const link = path.join(root, 'js', 'broken.js');
    fs.symlinkSync(path.join(root, 'does-not-exist.js'), link);
    const files = partitionFiles(root, 'core');
    assert.ok(files.includes('js/broken.js'));
    assert.match(partitionDigest(root, 'core'), /^[0-9a-f]{64}$/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
