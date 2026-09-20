import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { ensureFixtureCacheDirectory, fetchFixture } from '../scripts/fetch-real-fixtures.mjs';

function sha(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

test('#9302 rejects a symlinked fixture cache before creating external partial/final files', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-9302-'));
  const testsRoot = path.join(root, 'tests');
  const victim = path.join(root, 'victim');
  const cache = path.join(testsRoot, '.real-fixtures');
  const file = 'fixture.bin';
  const sentinel = path.join(victim, file);
  try {
    fs.mkdirSync(testsRoot);
    fs.mkdirSync(victim);
    fs.writeFileSync(sentinel, 'KEEP\n');
    fs.symlinkSync(victim, cache);
    await assert.rejects(
      () => fetchFixture('issue-9302', { file, size:4, sha256:sha(Buffer.from('DATA')), urlEnv:'HEX_9302_URL' }, {
        outputDirPath:cache, cacheContainmentRoot:testsRoot,
        verifyImpl:async () => { throw new Error('verification must not run through a symlinked cache'); },
        fetchImpl:async () => { throw new Error('network must not run through a symlinked cache'); },
      }),
      /fixture cache path component is not a real directory/,
    );
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'KEEP\n');
    assert.deepEqual(fs.readdirSync(victim), [file]);
  } finally {
    delete process.env.HEX_9302_URL;
    fs.rmSync(root, { recursive:true, force:true });
  }
});

test('#9302 rejects a symlinked ancestor beneath the containment root', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-9302-ancestor-'));
  try {
    const testsRoot = path.join(root, 'tests');
    const victim = path.join(root, 'victim');
    fs.mkdirSync(testsRoot);
    fs.mkdirSync(victim);
    fs.symlinkSync(victim, path.join(testsRoot, 'nested'));
    await assert.rejects(
      () => ensureFixtureCacheDirectory(path.join(testsRoot, 'nested', '.real-fixtures'), { containmentRoot:testsRoot, create:true }),
      /not a real directory/,
    );
    assert.deepEqual(fs.readdirSync(victim), []);
  } finally {
    fs.rmSync(root, { recursive:true, force:true });
  }
});

test('#9302 a normal real cache directory still downloads and publishes pinned bytes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-9302-normal-'));
  const testsRoot = path.join(root, 'tests');
  const cache = path.join(testsRoot, '.real-fixtures');
  const bytes = Buffer.from('SAFE');
  const file = 'fixture.bin';
  process.env.HEX_9302_URL = 'https://fixtures.test/safe';
  try {
    fs.mkdirSync(testsRoot);
    await fetchFixture('issue-9302-normal', { file, size:bytes.length, sha256:sha(bytes), urlEnv:'HEX_9302_URL' }, {
      outputDirPath:cache, cacheContainmentRoot:testsRoot, timeoutMs:500,
      fetchImpl:async () => ({ ok:true, status:200, body:Readable.from([bytes]) }),
    });
    assert.deepEqual(fs.readFileSync(path.join(cache, file)), bytes);
    assert.equal(fs.lstatSync(cache).isDirectory(), true);
    assert.equal(fs.lstatSync(cache).isSymbolicLink(), false);
  } finally {
    delete process.env.HEX_9302_URL;
    fs.rmSync(root, { recursive:true, force:true });
  }
});
