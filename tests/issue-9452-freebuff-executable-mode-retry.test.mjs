import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { copyIfMissing } from '../scripts/freebuff-setup.mjs';

test('#9452 chmod failure after executable copy remains retry-repairable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuff-9452-'));
  try {
    const src = path.join(root, 'rg-source');
    const dst = path.join(root, 'shared', 'manicode', 'rg');
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(src, '#!/bin/sh\nexit 0\n', { mode: 0o644 });
    fs.chmodSync(src, 0o644);

    let failMode = true;
    const fakeFs = {
      ...fs,
      chmodSync(target, mode) {
        if (failMode && path.resolve(String(target)) === path.resolve(dst) && mode === 0o755) {
          failMode = false;
          throw Object.assign(new Error('simulated chmod failure'), { code: 'EIO' });
        }
        return fs.chmodSync(target, mode);
      },
    };

    assert.throws(
      () => copyIfMissing(src, dst, true, null, { fsImpl: fakeFs }),
      /simulated chmod failure/,
    );
    assert.equal(fs.existsSync(dst), true, 'copy may already be visible after chmod failure');
    assert.equal(fs.statSync(dst).mode & 0o111, 0, 'failed publication is not executable yet');

    assert.equal(copyIfMissing(src, dst, true), true, 'retry must repair incomplete executable state');
    assert.notEqual(fs.statSync(dst).mode & 0o111, 0, 'retry establishes executable invariant');
    assert.equal(copyIfMissing(src, dst, true), false, 'complete executable destination remains idempotent');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('#9452 existing non-executable regular destination is repaired without recopying', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuff-9452-existing-'));
  try {
    const src = path.join(root, 'src');
    const dst = path.join(root, 'dst');
    fs.writeFileSync(src, 'source\n', { mode: 0o644 });
    fs.writeFileSync(dst, 'existing\n', { mode: 0o644 });
    fs.chmodSync(dst, 0o644);

    assert.equal(copyIfMissing(src, dst, true), true);
    assert.equal(fs.readFileSync(dst, 'utf8'), 'existing\n', 'repair must preserve destination-wins content');
    assert.notEqual(fs.statSync(dst).mode & 0o111, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('#9452 executable repair does not chmod through an existing symlink', () => {
  if (process.platform === 'win32') return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuff-9452-symlink-'));
  try {
    const src = path.join(root, 'src');
    const target = path.join(root, 'target');
    const dst = path.join(root, 'dst');
    fs.writeFileSync(src, 'source\n', { mode: 0o644 });
    fs.writeFileSync(target, 'target\n', { mode: 0o644 });
    fs.chmodSync(target, 0o644);
    fs.symlinkSync(target, dst);

    assert.equal(copyIfMissing(src, dst, true), false);
    assert.equal(fs.statSync(target).mode & 0o111, 0, 'existing symlink target must not be chmodded');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
