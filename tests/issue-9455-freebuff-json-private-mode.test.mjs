import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { copyIfMissing } from '../scripts/freebuff-setup.mjs';

test('#9455 JSON chmod failure is not accepted as successful migration and retry repairs it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuff-9455-'));
  try {
    const src = path.join(root, 'credentials-source.json');
    const dst = path.join(root, 'home', '.config', 'manicode', 'credentials.json');
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(src, '{"token":"sentinel"}\n', { mode: 0o644 });
    fs.chmodSync(src, 0o644);

    let failMode = true;
    const fakeFs = {
      ...fs,
      chmodSync(target, mode) {
        if (failMode && path.resolve(String(target)) === path.resolve(dst) && mode === 0o600) {
          failMode = false;
          throw Object.assign(new Error('simulated chmod failure'), { code: 'EIO' });
        }
        return fs.chmodSync(target, mode);
      },
    };

    assert.throws(
      () => copyIfMissing(src, dst, false, null, { fsImpl: fakeFs }),
      /simulated chmod failure/,
    );
    assert.equal(fs.readFileSync(dst, 'utf8'), '{"token":"sentinel"}\n');
    assert.notEqual(fs.statSync(dst).mode & 0o777, 0o600, 'failed mode enforcement is not complete');

    assert.equal(copyIfMissing(src, dst, false), true, 'retry repairs incomplete private mode');
    assert.equal(fs.statSync(dst).mode & 0o777, 0o600);
    assert.equal(copyIfMissing(src, dst, false), false, 'complete private destination is idempotent');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('#9455 existing regular credentials JSON is tightened without overwriting contents', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuff-9455-existing-'));
  try {
    const src = path.join(root, 'src.json');
    const dst = path.join(root, 'credentials.json');
    fs.writeFileSync(src, '{"src":true}\n', { mode: 0o644 });
    fs.writeFileSync(dst, '{"existing":true}\n', { mode: 0o644 });
    fs.chmodSync(dst, 0o644);

    assert.equal(copyIfMissing(src, dst, false), true);
    assert.equal(fs.readFileSync(dst, 'utf8'), '{"existing":true}\n');
    assert.equal(fs.statSync(dst).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('#9455 JSON privacy repair does not chmod through existing symlink', () => {
  if (process.platform === 'win32') return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuff-9455-symlink-'));
  try {
    const src = path.join(root, 'src.json');
    const target = path.join(root, 'target.json');
    const dst = path.join(root, 'credentials.json');
    fs.writeFileSync(src, '{"src":true}\n', { mode: 0o644 });
    fs.writeFileSync(target, '{"target":true}\n', { mode: 0o644 });
    fs.chmodSync(target, 0o644);
    fs.symlinkSync(target, dst);

    assert.equal(copyIfMissing(src, dst, false), false);
    assert.equal(fs.statSync(target).mode & 0o777, 0o644);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
