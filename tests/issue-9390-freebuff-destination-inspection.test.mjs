import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { copyIfMissing } from '../scripts/freebuff-setup.mjs';

test('copyIfMissing propagates non-ENOENT destination inspection failures', () => {
  for (const code of ['EIO', 'EACCES']) {
    const io = {
      ...fs,
      mkdirSync() {},
      lstatSync() {
        throw Object.assign(new Error(`simulated ${code}`), { code });
      },
    };
    assert.throws(
      () => copyIfMissing('/tmp/src', '/tmp/dst', false, null, { fsImpl: io }),
      (error) => error?.code === code,
    );
  }
});

test('copyIfMissing still treats existing destination as destination-wins', () => {
  let copied = false;
  const io = {
    ...fs,
    mkdirSync() {},
    lstatSync() {
      return { isSymbolicLink: () => false };
    },
    copyFileSync() {
      copied = true;
    },
  };
  assert.equal(copyIfMissing('/tmp/src', '/tmp/dst', false, null, { fsImpl: io }), false);
  assert.equal(copied, false);
});

test('copyIfMissing preserves ENOENT plus COPYFILE_EXCL race semantics', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuff-9390-'));
  try {
    const src = path.join(dir, 'src');
    const dst = path.join(dir, 'dst');
    fs.writeFileSync(src, 'source');

    assert.equal(copyIfMissing(src, dst), true);
    assert.equal(fs.readFileSync(dst, 'utf8'), 'source');
    assert.equal(copyIfMissing(src, dst), false);

    const io = {
      ...fs,
      lstatSync(target) {
        if (target === dst) throw Object.assign(new Error('absent'), { code: 'ENOENT' });
        return fs.lstatSync(target);
      },
      copyFileSync() {
        throw Object.assign(new Error('winner'), { code: 'EEXIST' });
      },
    };
    assert.equal(copyIfMissing(src, dst, false, null, { fsImpl: io }), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('copyIfMissing propagates stable FD-relative destination inspection failure', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuff-9390-stable-'));
  try {
    const parent = path.join(dir, 'home');
    fs.mkdirSync(parent);
    const dst = path.join(parent, 'credentials.json');
    const io = {
      ...fs,
      lstatSync(target) {
        if (String(target).startsWith('/proc/self/fd/')) {
          throw Object.assign(new Error('simulated EIO'), { code: 'EIO' });
        }
        return fs.lstatSync(target);
      },
    };
    assert.throws(
      () => copyIfMissing('/tmp/source', dst, false, parent, { fsImpl: io }),
      (error) => error?.code === 'EIO',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
