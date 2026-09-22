import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { digestFixtureHandle, verify } from '../scripts/fetch-real-fixtures.mjs';

function specFor(bytes) {
  return {
    size: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  };
}

test('#9454 rejects leaf swapped to symlink after lstat but before open', async () => {
  if (process.platform === 'win32') return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-9454-symlink-'));
  try {
    const bytes = Buffer.from('pinned-fixture\n');
    const fixture = path.join(root, 'x.bin');
    const outside = path.join(root, 'outside.bin');
    fs.writeFileSync(fixture, bytes);
    fs.writeFileSync(outside, bytes);
    const spec = specFor(bytes);

    await assert.rejects(
      () => verify('x', fixture, spec, {
        async openImpl(target, flags) {
          fs.renameSync(fixture, path.join(root, 'original.bin'));
          fs.symlinkSync(outside, fixture);
          return fs.promises.open(target, flags);
        },
      }),
      /fixture identity changed before hashing/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('#9454 rejects regular-file substitution between validation and open', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-9454-regular-'));
  try {
    const bytes = Buffer.from('same-pinned-bytes\n');
    const fixture = path.join(root, 'x.bin');
    const replacement = path.join(root, 'replacement.bin');
    fs.writeFileSync(fixture, bytes);
    fs.writeFileSync(replacement, bytes);
    const spec = specFor(bytes);

    await assert.rejects(
      () => verify('x', fixture, spec, {
        async openImpl(target, flags) {
          fs.renameSync(fixture, path.join(root, 'original.bin'));
          fs.renameSync(replacement, fixture);
          return fs.promises.open(target, flags);
        },
      }),
      /fixture identity changed before hashing/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('#9454 rejects leaf replacement after bound-handle hashing', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-9454-posthash-'));
  try {
    const bytes = Buffer.from('post-hash-fixture\n');
    const fixture = path.join(root, 'x.bin');
    fs.writeFileSync(fixture, bytes);
    const spec = specFor(bytes);

    await assert.rejects(
      () => verify('x', fixture, spec, {
        async digestHandleImpl(handle) {
          const digest = await digestFixtureHandle(handle);
          fs.renameSync(fixture, path.join(root, 'original.bin'));
          fs.writeFileSync(fixture, bytes);
          return digest;
        },
      }),
      /fixture identity changed during hashing/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('#9454 unchanged regular pinned fixture verifies from one bound handle', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-9454-ok-'));
  try {
    const bytes = Buffer.from('ordinary-fixture\n');
    const fixture = path.join(root, 'x.bin');
    fs.writeFileSync(fixture, bytes);
    const spec = specFor(bytes);
    const digest = await verify('x', fixture, spec);
    assert.deepEqual(digest, spec);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('#9454 symlink present before verification remains rejected', async () => {
  if (process.platform === 'win32') return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-9454-preexisting-'));
  try {
    const bytes = Buffer.from('fixture\n');
    const target = path.join(root, 'target.bin');
    const fixture = path.join(root, 'x.bin');
    fs.writeFileSync(target, bytes);
    fs.symlinkSync(target, fixture);
    await assert.rejects(
      () => verify('x', fixture, specFor(bytes)),
      /must not be a symbolic link/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
