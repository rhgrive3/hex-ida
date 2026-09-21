import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { Readable } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { fetchFixture } from '../scripts/fetch-real-fixtures.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

function response(bytes) {
  return { ok:true, status:200, body:Readable.from([bytes]) };
}

for (const code of ['EIO', 'EACCES']) {
  test(`#9340 post-download ${code} recheck fails closed before publication`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hex-9340-'));
    const cache = path.join(root, 'cache');
    await fs.mkdir(cache);
    const bytes = Buffer.from('DATA');
    const file = 'fixture.bin';
    const target = path.join(cache, file);
    await fs.writeFile(target, 'STALE');
    const spec = { file, size:bytes.length, sha256:sha(bytes), urlEnv:'HEX_9340_URL' };
    const old = process.env.HEX_9340_URL;
    process.env.HEX_9340_URL = 'https://example.invalid/fixture.bin';
    let verifyCalls = 0;
    let publishCalls = 0;
    const recheckError = Object.assign(new Error(`${code}: injected recheck failure`), { code });
    try {
      await assert.rejects(
        () => fetchFixture('issue-9340', spec, {
          outputDirPath:cache,
          cacheContainmentRoot:root,
          fetchImpl:async () => response(bytes),
          verifyImpl:async () => {
            verifyCalls++;
            if (verifyCalls === 1) throw Object.assign(new Error('stale fixture'), { repairable:true });
            throw recheckError;
          },
          publishImpl:async () => { publishCalls++; },
        }),
        (error) => error === recheckError,
      );
      assert.equal(verifyCalls, 2);
      assert.equal(publishCalls, 0);
      assert.equal(await fs.readFile(target, 'utf8'), 'STALE');
      assert.deepEqual((await fs.readdir(cache)).sort(), [file]);
    } finally {
      if (old == null) delete process.env.HEX_9340_URL; else process.env.HEX_9340_URL = old;
      await fs.rm(root, { recursive:true, force:true });
    }
  });
}

test('#9340 successful race-win recheck discards the downloaded temp without publishing', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hex-9340-race-'));
  const cache = path.join(root, 'cache');
  await fs.mkdir(cache);
  const bytes = Buffer.from('DATA');
  const file = 'fixture.bin';
  const target = path.join(cache, file);
  await fs.writeFile(target, bytes);
  const spec = { file, size:bytes.length, sha256:sha(bytes), urlEnv:'HEX_9340_URL' };
  const old = process.env.HEX_9340_URL;
  process.env.HEX_9340_URL = 'https://example.invalid/fixture.bin';
  let verifyCalls = 0;
  let publishCalls = 0;
  try {
    await fetchFixture('issue-9340-race', spec, {
      outputDirPath:cache,
      cacheContainmentRoot:root,
      fetchImpl:async () => response(bytes),
      verifyImpl:async () => {
        verifyCalls++;
        if (verifyCalls === 1) throw Object.assign(new Error('stale fixture'), { repairable:true });
        return { size:bytes.length, sha256:sha(bytes) };
      },
      publishImpl:async () => { publishCalls++; },
    });
    assert.equal(verifyCalls, 2);
    assert.equal(publishCalls, 0);
    assert.deepEqual((await fs.readdir(cache)).sort(), [file]);
  } finally {
    if (old == null) delete process.env.HEX_9340_URL; else process.env.HEX_9340_URL = old;
    await fs.rm(root, { recursive:true, force:true });
  }
});

test('#9340 repairable post-download recheck still authorizes publication', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hex-9340-repair-'));
  const cache = path.join(root, 'cache');
  await fs.mkdir(cache);
  const bytes = Buffer.from('DATA');
  const file = 'fixture.bin';
  const target = path.join(cache, file);
  await fs.writeFile(target, 'OLD!');
  const spec = { file, size:bytes.length, sha256:sha(bytes), urlEnv:'HEX_9340_URL' };
  const old = process.env.HEX_9340_URL;
  process.env.HEX_9340_URL = 'https://example.invalid/fixture.bin';
  let verifyCalls = 0;
  let publishCalls = 0;
  try {
    await fetchFixture('issue-9340-repair', spec, {
      outputDirPath:cache,
      cacheContainmentRoot:root,
      fetchImpl:async () => response(bytes),
      verifyImpl:async () => {
        verifyCalls++;
        throw Object.assign(new Error('repairable fixture state'), { repairable:true });
      },
      publishImpl:async (temp, destination) => {
        publishCalls++;
        await fs.rename(temp, destination);
      },
    });
    assert.equal(verifyCalls, 2);
    assert.equal(publishCalls, 1);
    assert.deepEqual(await fs.readFile(target), bytes);
  } finally {
    if (old == null) delete process.env.HEX_9340_URL; else process.env.HEX_9340_URL = old;
    await fs.rm(root, { recursive:true, force:true });
  }
});
