import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { moveIfMissing } from '../scripts/freebuff-setup.mjs';

test('preferred shared move propagates rename failures instead of authorizing fallback', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuff-9419-'));
  try {
    const src = path.join(root, 'preferred.json');
    const dstDir = path.join(root, 'shared');
    const dst = path.join(dstDir, 'history.json');
    fs.mkdirSync(dstDir);
    fs.writeFileSync(src, 'NEW');
    for (const code of ['EIO', 'EXDEV']) {
      let fallbackConsulted = false;
      const io = {
        ...fs,
        renameSync(from, to) {
          if (from === src) throw Object.assign(new Error('move failed'), { code });
          return fs.renameSync(from, to);
        },
      };
      assert.throws(
        () => {
          if (!moveIfMissing(src, dst, root, { fsImpl: io })) fallbackConsulted = true;
        },
        (error) => error?.code === code,
      );
      assert.equal(fallbackConsulted, false);
      assert.equal(fs.readFileSync(src, 'utf8'), 'NEW');
      assert.equal(fs.existsSync(dst), false);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('stable destination inspection failure propagates', () => {
  if (process.platform !== 'linux') return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuff-9419-lstat-'));
  try {
    const src = path.join(root, 'preferred');
    const dstDir = path.join(root, 'shared');
    const dst = path.join(dstDir, 'history');
    fs.mkdirSync(dstDir);
    fs.writeFileSync(src, 'NEW');
    const io = {
      ...fs,
      lstatSync(target) {
        if (String(target).startsWith('/proc/self/fd/') && String(target).endsWith('/history')) {
          throw Object.assign(new Error('destination inspection denied'), { code: 'EACCES' });
        }
        return fs.lstatSync(target);
      },
    };
    assert.throws(() => moveIfMissing(src, dst, root, { fsImpl: io }), (error) => error?.code === 'EACCES');
    assert.equal(fs.readFileSync(src, 'utf8'), 'NEW');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('moveIfMissing keeps benign absence, destination-wins, and success behavior', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuff-9419-benign-'));
  try {
    const dstDir = path.join(root, 'shared');
    fs.mkdirSync(dstDir);
    const dst = path.join(dstDir, 'history');
    assert.equal(moveIfMissing(path.join(root, 'absent'), dst, root), false);

    const src = path.join(root, 'preferred');
    fs.writeFileSync(src, 'NEW');
    fs.writeFileSync(dst, 'EXISTING');
    assert.equal(moveIfMissing(src, dst, root), false);
    assert.equal(fs.readFileSync(dst, 'utf8'), 'EXISTING');
    assert.equal(fs.readFileSync(src, 'utf8'), 'NEW');

    fs.rmSync(dst);
    assert.equal(moveIfMissing(src, dst, root), true);
    assert.equal(fs.readFileSync(dst, 'utf8'), 'NEW');
    assert.equal(fs.existsSync(src), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
