import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { copyIfMissing } from '../scripts/freebuff-setup.mjs';

test('migration copy accepts only a stable regular source inside sourceRoot', () => {
  if (process.platform !== 'linux') return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuff-9427-'));
  try {
    const sourceRoot = path.join(root, 'legacy');
    const destinationRoot = path.join(root, 'dest');
    fs.mkdirSync(path.join(sourceRoot, 'nested'), { recursive: true });
    fs.mkdirSync(destinationRoot, { recursive: true });
    const src = path.join(sourceRoot, 'nested', 'settings.json');
    const dst = path.join(destinationRoot, 'settings.json');
    fs.writeFileSync(src, '{"inside":true}\n');

    assert.equal(copyIfMissing(src, dst, false, destinationRoot, { sourceRoot }), true);
    assert.equal(fs.readFileSync(dst, 'utf8'), '{"inside":true}\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('absolute and relative escaping source symlinks are rejected without importing bytes', () => {
  if (process.platform !== 'linux') return;
  for (const relative of [false, true]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuff-9427-escape-'));
    try {
      const sourceRoot = path.join(root, 'legacy');
      const destinationRoot = path.join(root, 'dest');
      const outside = path.join(root, 'outside-settings.json');
      fs.mkdirSync(sourceRoot);
      fs.mkdirSync(destinationRoot);
      fs.writeFileSync(outside, 'OUTSIDE-SENTINEL\n');
      const src = path.join(sourceRoot, 'settings.json');
      fs.symlinkSync(relative ? path.relative(sourceRoot, outside) : outside, src);
      const dst = path.join(destinationRoot, 'settings.json');

      assert.throws(
        () => copyIfMissing(src, dst, false, destinationRoot, { sourceRoot }),
        /migration source is not a real file/,
      );
      assert.equal(fs.existsSync(dst), false);
      assert.equal(fs.readFileSync(outside, 'utf8'), 'OUTSIDE-SENTINEL\n');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('source symlink chain is rejected and existing destination still wins', () => {
  if (process.platform !== 'linux') return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuff-9427-chain-'));
  try {
    const sourceRoot = path.join(root, 'legacy');
    const destinationRoot = path.join(root, 'dest');
    fs.mkdirSync(sourceRoot);
    fs.mkdirSync(destinationRoot);
    const outside = path.join(root, 'outside');
    fs.writeFileSync(outside, 'OUTSIDE\n');
    const hop = path.join(sourceRoot, 'hop');
    const src = path.join(sourceRoot, 'settings.json');
    fs.symlinkSync(outside, hop);
    fs.symlinkSync('hop', src);
    const dst = path.join(destinationRoot, 'settings.json');

    assert.throws(() => copyIfMissing(src, dst, false, destinationRoot, { sourceRoot }), /migration source is not a real file/);
    assert.equal(fs.existsSync(dst), false);

    fs.writeFileSync(dst, 'DESTINATION-WINS\n');
    assert.equal(copyIfMissing(src, dst, false, destinationRoot, { sourceRoot }), false);
    assert.equal(fs.readFileSync(dst, 'utf8'), 'DESTINATION-WINS\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('migration callers declare source roots for repo-home, legacy-home, and shared fallback', () => {
  const source = fs.readFileSync(new URL('../scripts/freebuff-setup.mjs', import.meta.url), 'utf8');
  assert.match(source, /sourceRoot: repoHome/);
  assert.match(source, /sourceRoot: legacy/);
  assert.match(source, /sourceRoot: path\.join\(LEGACY_ROOT, 'shared'\)/);
});
