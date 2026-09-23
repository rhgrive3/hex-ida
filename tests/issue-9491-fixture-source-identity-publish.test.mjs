import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import {
  fetchFixture,
  publishFixtureFile,
} from '../scripts/fetch-real-fixtures.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const response = (bytes) => ({ ok: true, status: 200, body: Readable.from([bytes]) });

test('#9491 deterministic leaf swap before publication fails and leaves target untouched', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hex-9491-'));
  const testsRoot = path.join(root, 'tests');
  const cache = path.join(testsRoot, '.real-fixtures');
  const goodBytes = Buffer.from('GOOD-BYTES-123456');
  const badBytes = Buffer.from('BAD-BYTES-ILLEGAL');
  const file = 'fixture.bin';
  const target = path.join(cache, file);
  await fsp.mkdir(cache, { recursive: true });

  process.env.HEX_9491_URL = 'https://fixtures.test/good';
  let capturedSnapshot = null;
  try {
    await assert.rejects(
      () => fetchFixture('issue-9491', {
        file,
        size: goodBytes.length,
        sha256: sha(goodBytes),
        urlEnv: 'HEX_9491_URL',
      }, {
        outputDirPath: cache,
        cacheContainmentRoot: testsRoot,
        timeoutMs: 2000,
        fetchImpl: async () => response(goodBytes),
        verifyImpl: async () => { throw Object.assign(new Error('missing'), { repairable: true }); },
        publishImpl: async (temp, tgt, options) => {
          capturedSnapshot = options.directoryIdentitySnapshot;
          // Atomically replace temp with badBytes before publishing
          const attackerFile = `${temp}.attacker`;
          await fsp.writeFile(attackerFile, badBytes);
          await fsp.rename(attackerFile, temp);
          return publishFixtureFile(temp, tgt, options);
        },
      }),
      (error) => {
        assert.equal(error?.code, 'FIXTURE_SOURCE_IDENTITY_CHANGED');
        return true;
      },
    );

    // Target must not have been created or published with BAD bytes
    await assert.rejects(fsp.stat(target), { code: 'ENOENT' });
    // Directory identity snapshot remained valid throughout the swap
    assert.ok(capturedSnapshot);
  } finally {
    delete process.env.HEX_9491_URL;
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('#9491 same-size malicious replacement is rejected by inode identity check', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hex-9491-samesize-'));
  const testsRoot = path.join(root, 'tests');
  const cache = path.join(testsRoot, '.real-fixtures');
  const goodBytes = Buffer.from('GOOD-BYTES-LENGTH');
  const badBytes = Buffer.from('EVIL-BYTES-LENGTH');
  assert.equal(goodBytes.length, badBytes.length);

  const file = 'fixture.bin';
  const target = path.join(cache, file);
  await fsp.mkdir(cache, { recursive: true });

  process.env.HEX_9491_SAME_URL = 'https://fixtures.test/good';
  try {
    await assert.rejects(
      () => fetchFixture('issue-9491-same', {
        file,
        size: goodBytes.length,
        sha256: sha(goodBytes),
        urlEnv: 'HEX_9491_SAME_URL',
      }, {
        outputDirPath: cache,
        cacheContainmentRoot: testsRoot,
        timeoutMs: 2000,
        fetchImpl: async () => response(goodBytes),
        verifyImpl: async () => { throw Object.assign(new Error('missing'), { repairable: true }); },
        publishImpl: async (temp, tgt, options) => {
          const attackerFile = `${temp}.attacker`;
          await fsp.writeFile(attackerFile, badBytes);
          await fsp.rename(attackerFile, temp);
          return publishFixtureFile(temp, tgt, options);
        },
      }),
      (error) => {
        assert.equal(error?.code, 'FIXTURE_SOURCE_IDENTITY_CHANGED');
        return true;
      },
    );

    await assert.rejects(fsp.stat(target), { code: 'ENOENT' });
  } finally {
    delete process.env.HEX_9491_SAME_URL;
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('#9491 cleanup does not remove swapped file with different identity', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hex-9491-cleanup-'));
  const testsRoot = path.join(root, 'tests');
  const cache = path.join(testsRoot, '.real-fixtures');
  const goodBytes = Buffer.from('GOOD-DATA');
  const badBytes = Buffer.from('SUBSTITUTE');
  const file = 'fixture.bin';
  await fsp.mkdir(cache, { recursive: true });

  process.env.HEX_9491_CLEANUP_URL = 'https://fixtures.test/good';
  let swappedTempPath = null;
  try {
    await assert.rejects(
      () => fetchFixture('issue-9491-cleanup', {
        file,
        size: goodBytes.length,
        sha256: sha(goodBytes),
        urlEnv: 'HEX_9491_CLEANUP_URL',
      }, {
        outputDirPath: cache,
        cacheContainmentRoot: testsRoot,
        timeoutMs: 2000,
        fetchImpl: async () => response(goodBytes),
        verifyImpl: async () => { throw Object.assign(new Error('missing'), { repairable: true }); },
        publishImpl: async (temp, tgt, options) => {
          swappedTempPath = temp;
          const attackerFile = `${temp}.attacker`;
          await fsp.writeFile(attackerFile, badBytes);
          await fsp.rename(attackerFile, temp);
          return publishFixtureFile(temp, tgt, options);
        },
      }),
      (error) => {
        assert.equal(error?.code, 'FIXTURE_SOURCE_IDENTITY_CHANGED');
        return true;
      },
    );

    // The attacker's substitute file at `temp` must NOT be unlinked by cleanup
    assert.ok(swappedTempPath);
    const remaining = await fsp.readFile(swappedTempPath, 'utf8');
    assert.equal(remaining, 'SUBSTITUTE');
  } finally {
    delete process.env.HEX_9491_CLEANUP_URL;
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('#9491 normal download and publication with unchanged identity succeeds', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hex-9491-normal-'));
  const testsRoot = path.join(root, 'tests');
  const cache = path.join(testsRoot, '.real-fixtures');
  const goodBytes = Buffer.from('NORMAL-GOOD-DATA');
  const file = 'fixture.bin';
  const target = path.join(cache, file);
  await fsp.mkdir(cache, { recursive: true });

  process.env.HEX_9491_OK_URL = 'https://fixtures.test/good';
  try {
    await fetchFixture('issue-9491-ok', {
      file,
      size: goodBytes.length,
      sha256: sha(goodBytes),
      urlEnv: 'HEX_9491_OK_URL',
    }, {
      outputDirPath: cache,
      cacheContainmentRoot: testsRoot,
      timeoutMs: 2000,
      fetchImpl: async () => response(goodBytes),
      verifyImpl: async (name, p) => {
        // Only succeed if file actually exists and contains goodBytes
        try {
          const content = await fsp.readFile(p);
          if (content.equals(goodBytes)) return { size: goodBytes.length, sha256: sha(goodBytes) };
          throw Object.assign(new Error('corrupt'), { repairable: true });
        } catch (err) {
          if (err?.code === 'ENOENT') throw Object.assign(new Error('missing'), { repairable: true });
          throw err;
        }
      },
    });

    const targetContent = await fsp.readFile(target);
    assert.deepEqual(targetContent, goodBytes);
  } finally {
    delete process.env.HEX_9491_OK_URL;
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('#9491 preserves Windows destination-conflict backup/restore while enforcing expected source identity', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hex-9491-win-'));
  try {
    const target = path.join(root, 'fixture.bin');
    const temp = path.join(root, 'fixture.partial');
    const attacker = path.join(root, 'attacker.bin');
    await fsp.writeFile(target, 'OLD');
    await fsp.writeFile(temp, 'NEW');
    await fsp.writeFile(attacker, 'ATTACKER');

    const tempStat = await fsp.stat(temp);
    const expectedSourceIdentity = { dev: String(tempStat.dev), ino: String(tempStat.ino) };

    // Swap temp to attacker file before Windows replacement happens
    await fsp.rename(temp, `${temp}.orig`);
    await fsp.rename(attacker, temp);

    let first = true;
    await assert.rejects(
      () => publishFixtureFile(temp, target, {
        platform: 'win32',
        expectedSourceIdentity,
        randomUUIDImpl: () => 'fixed',
        renameImpl: async (from, to) => {
          if (first && from === temp && to === target) {
            first = false;
            throw Object.assign(new Error('destination exists'), { code: 'EPERM' });
          }
          return fsp.rename(from, to);
        },
      }),
      (error) => error?.code === 'FIXTURE_SOURCE_IDENTITY_CHANGED',
    );

    // target was untouched
    assert.equal(await fsp.readFile(target, 'utf8'), 'OLD');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
