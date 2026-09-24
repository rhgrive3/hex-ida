import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fetchFixture } from '../scripts/fetch-real-fixtures.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('#9523 cleanup failure cannot replace primary SHA validation failure', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hex-9523-'));
  const testsRoot = path.join(root, 'tests');
  const cache = path.join(testsRoot, '.real-fixtures');
  await fsp.mkdir(cache, { recursive: true });
  const bytes = Buffer.from('WRONG-HASH-BYTES');
  const expected = Buffer.alloc(bytes.length, 0x45);
  assert.equal(bytes.length, expected.length);
  process.env.HEX_9523_URL = 'https://fixtures.test/issue-9523';
  let identityChecks = 0;
  try {
    await assert.rejects(
      () => fetchFixture('issue-9523', {
        file: 'fixture.bin',
        size: bytes.length,
        sha256: sha(expected),
        urlEnv: 'HEX_9523_URL',
      }, {
        outputDirPath: cache,
        cacheContainmentRoot: testsRoot,
        timeoutMs: 2000,
        fetchImpl: async () => ({ ok: true, status: 200, body: Readable.from([bytes]) }),
        verifyImpl: async () => { throw Object.assign(new Error('missing'), { repairable: true }); },
        assertCacheIdentityImpl: async () => {
          identityChecks += 1;
          if (identityChecks === 2) throw Object.assign(new Error('simulated cleanup I/O failure'), { code: 'EIO' });
        },
      }),
      (error) => {
        assert.match(error.message, /SHA-256 mismatch/);
        assert.equal(error.cleanupError?.code, 'EIO');
        return true;
      },
    );
  } finally {
    delete process.env.HEX_9523_URL;
    await fsp.rm(root, { recursive: true, force: true });
  }
});
