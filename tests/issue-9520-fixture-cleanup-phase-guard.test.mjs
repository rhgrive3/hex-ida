import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { publishFixtureFile } from '../scripts/fetch-real-fixtures.mjs';

// Forces the destination-conflict fallback on the first temp -> target rename.
function conflictOnce(temp, target, code = 'EEXIST') {
  let first = true;
  return async (from, to) => {
    if (first && from === temp && to === target) {
      first = false;
      throw Object.assign(new Error('destination exists'), { code });
    }
    return fs.rename(from, to);
  };
}

async function fixtureDir(prefix) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const target = path.join(root, 'fixture.bin');
  const temp = path.join(root, 'fixture.partial');
  await fs.writeFile(target, 'OLD');
  await fs.writeFile(temp, 'NEW');
  return { root, target, temp, sourceIdentity: await fs.lstat(temp) };
}

const backups = async (root) => (await fs.readdir(root)).filter((name) => name.includes('.replace-backup-'));

test('#9520 successful source-bound replacement removes the backup and keeps the target', async () => {
  const { root, target, temp, sourceIdentity } = await fixtureDir('hex-9520-ok-');
  try {
    const cleanupErrors = [];
    await publishFixtureFile(temp, target, {
      renameImpl: conflictOnce(temp, target),
      expectedSourceIdentity: sourceIdentity,
      onCleanupError: (error) => cleanupErrors.push(error),
    });
    assert.deepEqual(cleanupErrors, []);
    assert.equal(await fs.readFile(target, 'utf8'), 'NEW');
    assert.deepEqual(await backups(root), []);
    await assert.rejects(fs.lstat(temp), { code: 'ENOENT' });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('#9520 issue counterexample: injected fake filesystem reaches rm(backup)', async () => {
  const temp = '/fake/fixture.partial';
  const target = '/fake/fixture.bin';
  const files = new Map([
    [temp, { dev: 1, ino: 10 }],
    [target, { dev: 1, ino: 20 }],
  ]);
  const stat = (entry) => ({ ...entry, isFile: () => true, isSymbolicLink: () => false });
  let firstPublish = true;
  const removed = [];
  const cleanupErrors = [];
  await publishFixtureFile(temp, target, {
    expectedSourceIdentity: { dev: 1, ino: 10 },
    randomUUIDImpl: () => 'fixed',
    lstatImpl: async (file) => {
      if (!files.has(file)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return stat(files.get(file));
    },
    renameImpl: async (from, to) => {
      if (firstPublish && from === temp && to === target) {
        firstPublish = false;
        throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      }
      files.set(to, files.get(from));
      files.delete(from);
    },
    rmImpl: async (file) => { removed.push(file); files.delete(file); },
    onCleanupError: (error) => cleanupErrors.push(error),
  });
  assert.deepEqual(cleanupErrors, []);
  assert.deepEqual(removed, [`${target}.replace-backup-${process.pid}-fixed`]);
  assert.deepEqual(files.get(target), { dev: 1, ino: 10 });
  assert.equal(files.has(temp), false);
});

test('#9520 pre-publication source substitution is still rejected and restores the original target', async () => {
  const { root, target, temp, sourceIdentity } = await fixtureDir('hex-9520-swap-');
  try {
    let first = true;
    await assert.rejects(
      publishFixtureFile(temp, target, {
        expectedSourceIdentity: sourceIdentity,
        renameImpl: async (from, to) => {
          if (first && from === temp && to === target) {
            first = false;
            throw Object.assign(new Error('destination exists'), { code: 'EEXIST' });
          }
          if (from === target && to.includes('.replace-backup-')) {
            await fs.rename(target, to);
            // Substitute the source leaf after the backup is taken.
            await fs.writeFile(`${temp}.evil`, 'EVIL');
            await fs.rename(`${temp}.evil`, temp);
            return;
          }
          return fs.rename(from, to);
        },
      }),
      { code: 'FIXTURE_SOURCE_IDENTITY_CHANGED' },
    );
    assert.equal(await fs.readFile(target, 'utf8'), 'OLD');
    assert.deepEqual(await backups(root), []);
    assert.equal(await fs.readFile(temp, 'utf8'), 'EVIL');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('#9520 directory identity change during cleanup fails closed without removing the backup', async () => {
  const { root, target, temp, sourceIdentity } = await fixtureDir('hex-9520-dir-');
  try {
    let published = false;
    const removed = [];
    const cleanupErrors = [];
    const rename = conflictOnce(temp, target);
    await publishFixtureFile(temp, target, {
      expectedSourceIdentity: sourceIdentity,
      directoryIdentitySnapshot: { token: 'dir' },
      assertDirectoryIdentityImpl: async () => {
        if (published) throw Object.assign(new Error('cache directory replaced'), { code: 'FIXTURE_CACHE_DIRECTORY_CHANGED' });
      },
      renameImpl: async (from, to) => {
        await rename(from, to);
        if (from === temp && to === target) published = true;
      },
      rmImpl: async (file, options) => { removed.push(file); return fs.rm(file, options); },
      onCleanupError: (error) => cleanupErrors.push(error),
    });
    assert.deepEqual(removed, []);
    assert.equal(cleanupErrors.length, 1);
    assert.equal(cleanupErrors[0].code, 'FIXTURE_CACHE_DIRECTORY_CHANGED');
    assert.equal(await fs.readFile(target, 'utf8'), 'NEW');
    assert.equal((await backups(root)).length, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('#9520 backup replaced by another object is not removed', async () => {
  const { root, target, temp, sourceIdentity } = await fixtureDir('hex-9520-backup-swap-');
  try {
    const removed = [];
    const cleanupErrors = [];
    const rename = conflictOnce(temp, target);
    await publishFixtureFile(temp, target, {
      expectedSourceIdentity: sourceIdentity,
      renameImpl: async (from, to) => {
        await rename(from, to);
        if (from === temp && to === target) {
          const [backup] = await backups(root);
          // Create the replacement while the backup still exists so the
          // filesystem cannot hand the freed inode number straight back.
          const other = path.join(root, 'other.tmp');
          await fs.writeFile(other, 'OTHER');
          await fs.rename(other, path.join(root, backup));
        }
      },
      rmImpl: async (file, options) => { removed.push(file); return fs.rm(file, options); },
      onCleanupError: (error) => cleanupErrors.push(error),
    });
    assert.deepEqual(removed, []);
    assert.equal(cleanupErrors[0]?.code, 'FIXTURE_BACKUP_IDENTITY_CHANGED');
    assert.equal(await fs.readFile(target, 'utf8'), 'NEW');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('#9520 an actual rm failure is still reported', async () => {
  const { root, target, temp, sourceIdentity } = await fixtureDir('hex-9520-rm-');
  try {
    const cleanupErrors = [];
    await publishFixtureFile(temp, target, {
      expectedSourceIdentity: sourceIdentity,
      renameImpl: conflictOnce(temp, target),
      rmImpl: async () => { throw Object.assign(new Error('cleanup I/O failure'), { code: 'EIO' }); },
      onCleanupError: (error) => cleanupErrors.push(error),
    });
    assert.equal(cleanupErrors.length, 1);
    assert.equal(cleanupErrors[0].code, 'EIO');
    assert.equal(await fs.readFile(target, 'utf8'), 'NEW');
    assert.equal((await backups(root)).length, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('#9520 failed replacement rename rolls the original target back', async () => {
  const { root, target, temp, sourceIdentity } = await fixtureDir('hex-9520-rollback-');
  try {
    let calls = 0;
    await assert.rejects(
      publishFixtureFile(temp, target, {
        expectedSourceIdentity: sourceIdentity,
        renameImpl: async (from, to) => {
          calls += 1;
          if (from === temp && to === target) {
            throw Object.assign(new Error(calls === 1 ? 'exists' : 'replacement failed'), { code: calls === 1 ? 'EEXIST' : 'EIO' });
          }
          return fs.rename(from, to);
        },
      }),
      { code: 'EIO' },
    );
    assert.equal(await fs.readFile(target, 'utf8'), 'OLD');
    assert.equal(await fs.readFile(temp, 'utf8'), 'NEW');
    assert.deepEqual(await backups(root), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
