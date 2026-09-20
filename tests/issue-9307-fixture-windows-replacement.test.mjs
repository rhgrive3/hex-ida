import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { publishFixtureFile } from '../scripts/fetch-real-fixtures.mjs';

for (const code of ['EIO', 'ENOSPC']) {
  test(`#9307 ${code} publication failure never deletes an existing target`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hex-9307-'));
    try {
      const target = path.join(root, 'fixture.bin');
      const temp = path.join(root, 'fixture.partial');
      await fs.writeFile(target, 'OLD');
      await fs.writeFile(temp, 'NEW');
      const injected = Object.assign(new Error(`${code}: injected rename failure`), { code });
      let calls = 0;
      await assert.rejects(
        () => publishFixtureFile(temp, target, {
          platform: 'win32',
          renameImpl: async (from, to) => {
            calls++;
            if (from === temp && to === target) throw injected;
            return fs.rename(from, to);
          },
        }),
        (error) => error === injected,
      );
      assert.equal(calls, 1);
      assert.equal(await fs.readFile(target, 'utf8'), 'OLD');
      assert.equal(await fs.readFile(temp, 'utf8'), 'NEW');
    } finally {
      await fs.rm(root, { recursive:true, force:true });
    }
  });
}

test('#9307 genuine Windows destination-conflict path replaces transactionally', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hex-9307-replace-'));
  try {
    const target = path.join(root, 'fixture.bin');
    const temp = path.join(root, 'fixture.partial');
    await fs.writeFile(target, 'OLD');
    await fs.writeFile(temp, 'NEW');
    let first = true;
    await publishFixtureFile(temp, target, {
      platform: 'win32',
      randomUUIDImpl: () => 'fixed',
      renameImpl: async (from, to) => {
        if (first && from === temp && to === target) {
          first = false;
          throw Object.assign(new Error('destination exists'), { code:'EPERM' });
        }
        return fs.rename(from, to);
      },
    });
    assert.equal(await fs.readFile(target, 'utf8'), 'NEW');
    await assert.rejects(fs.stat(temp), { code:'ENOENT' });
    assert.deepEqual((await fs.readdir(root)).sort(), ['fixture.bin']);
  } finally {
    await fs.rm(root, { recursive:true, force:true });
  }
});

test('#9307 replacement retry failure restores the original cached target', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hex-9307-restore-'));
  try {
    const target = path.join(root, 'fixture.bin');
    const temp = path.join(root, 'fixture.partial');
    await fs.writeFile(target, 'OLD');
    await fs.writeFile(temp, 'NEW');
    let tempAttempts = 0;
    await assert.rejects(
      () => publishFixtureFile(temp, target, {
        platform:'win32',
        randomUUIDImpl:() => 'fixed',
        renameImpl:async (from, to) => {
          if (from === temp && to === target) {
            tempAttempts++;
            const code = tempAttempts === 1 ? 'EPERM' : 'EIO';
            throw Object.assign(new Error(`${code}: injected`), { code });
          }
          return fs.rename(from, to);
        },
      }),
      (error) => error?.code === 'EIO',
    );
    assert.equal(await fs.readFile(target, 'utf8'), 'OLD');
    assert.equal(await fs.readFile(temp, 'utf8'), 'NEW');
    assert.deepEqual((await fs.readdir(root)).sort(), ['fixture.bin', 'fixture.partial']);
  } finally {
    await fs.rm(root, { recursive:true, force:true });
  }
});
