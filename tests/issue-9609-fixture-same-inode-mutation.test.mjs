import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { digestFixtureHandle, verify } from '../scripts/fetch-real-fixtures.mjs';

function specFor(bytes) {
  return { size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}

test('#9609 rejects same-inode same-size mutation after the first digest', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-9609-same-size-'));
  try {
    const good = Buffer.from('GOOD');
    const bad = Buffer.from('BADD');
    const fixture = path.join(root, 'x.bin');
    fs.writeFileSync(fixture, good);
    const before = fs.lstatSync(fixture);
    let calls = 0;
    await assert.rejects(
      () => verify('x', fixture, specFor(good), {
        async digestHandleImpl(handle) {
          const digest = await digestFixtureHandle(handle);
          if (++calls === 1) fs.writeFileSync(fixture, bad);
          return digest;
        },
      }),
      /fixture contents changed during hashing/,
    );
    const after = fs.lstatSync(fixture);
    assert.equal(String(after.dev), String(before.dev));
    assert.equal(String(after.ino), String(before.ino));
    assert.equal(after.size, before.size);
    assert.deepEqual(fs.readFileSync(fixture), bad);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('#9609 rejects same-inode size-changing mutation after the first digest', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-9609-size-change-'));
  try {
    const good = Buffer.from('GOOD');
    const fixture = path.join(root, 'x.bin');
    fs.writeFileSync(fixture, good);
    let calls = 0;
    await assert.rejects(
      () => verify('x', fixture, specFor(good), {
        async digestHandleImpl(handle) {
          const digest = await digestFixtureHandle(handle);
          if (++calls === 1) fs.appendFileSync(fixture, '!');
          return digest;
        },
      }),
      /fixture contents changed during hashing/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('#9609 unchanged pinned fixture still verifies', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-9609-ok-'));
  try {
    const bytes = Buffer.from('stable-fixture');
    const fixture = path.join(root, 'x.bin');
    fs.writeFileSync(fixture, bytes);
    assert.deepEqual(await verify('x', fixture, specFor(bytes)), specFor(bytes));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
