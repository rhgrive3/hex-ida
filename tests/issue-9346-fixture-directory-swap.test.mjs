import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import {
  assertFixtureCacheDirectoryIdentity,
  captureFixtureCacheDirectoryIdentity,
  ensureFixtureCacheDirectory,
  fetchFixture,
} from '../scripts/fetch-real-fixtures.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const response = (bytes) => ({ ok:true, status:200, body:Readable.from([bytes]) });

async function swapDirectory(directory, outside) {
  const saved = `${directory}.saved`;
  await fsp.rename(directory, saved);
  await fsp.symlink(outside, directory);
  return saved;
}

async function restoreDirectory(directory, saved) {
  await fsp.unlink(directory).catch(() => {});
  await fsp.rename(saved, directory).catch(() => {});
}

for (const phase of ['pre-create', 'pre-publish']) {
  test(`#9346 ${phase} ancestor swap fails closed without external fixture mutation`, async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hex-9346-'));
    const testsRoot = path.join(root, 'tests');
    const cache = path.join(testsRoot, '.real-fixtures');
    const outside = path.join(root, 'outside');
    const bytes = Buffer.from('SAFE');
    const file = 'fixture.bin';
    const externalSentinel = path.join(outside, file);
    await fsp.mkdir(testsRoot);
    await fsp.mkdir(outside);
    await fsp.writeFile(externalSentinel, 'KEEP');
    process.env.HEX_9346_URL = 'https://fixtures.test/safe';
    let ensureCalls = 0;
    let saved = null;
    try {
      await assert.rejects(() => fetchFixture('issue-9346', {
        file, size:bytes.length, sha256:sha(bytes), urlEnv:'HEX_9346_URL',
      }, {
        outputDirPath:cache,
        cacheContainmentRoot:testsRoot,
        timeoutMs:1000,
        fetchImpl:async () => response(bytes),
        verifyImpl:async () => { throw Object.assign(new Error('missing'), { repairable:true }); },
        ensureCacheDirImpl:async (...args) => {
          ensureCalls++;
          const result = await ensureFixtureCacheDirectory(...args);
          const trigger = phase === 'pre-create' ? 3 : 4;
          if (ensureCalls === trigger) saved = await swapDirectory(cache, outside);
          return result;
        },
      }), /identity changed/);
      assert.equal(await fsp.readFile(externalSentinel, 'utf8'), 'KEEP');
      assert.deepEqual((await fsp.readdir(outside)).sort(), [file]);
    } finally {
      delete process.env.HEX_9346_URL;
      if (saved) await restoreDirectory(cache, saved);
      await fsp.rm(root, { recursive:true, force:true });
    }
  });
}

test('#9346 nested cache identity detects an exchanged intermediate component', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hex-9346-nested-'));
  const testsRoot = path.join(root, 'tests');
  const cache = path.join(testsRoot, 'nested', '.real-fixtures');
  const outside = path.join(root, 'outside');
  await fsp.mkdir(cache, { recursive:true });
  await fsp.mkdir(outside);
  let saved;
  try {
    const snapshot = await captureFixtureCacheDirectoryIdentity(cache, { containmentRoot:testsRoot });
    saved = await swapDirectory(path.join(testsRoot, 'nested'), outside);
    await assert.rejects(() => assertFixtureCacheDirectoryIdentity(snapshot), /identity changed/);
  } finally {
    if (saved) await restoreDirectory(path.join(testsRoot, 'nested'), saved);
    await fsp.rm(root, { recursive:true, force:true });
  }
});
