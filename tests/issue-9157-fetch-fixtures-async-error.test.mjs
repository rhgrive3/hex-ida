import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { fetchFixture } from '../scripts/fetch-real-fixtures.mjs';

test('#9157 fetchFixture cleans up partial file and catches async stream write failure', async () => {
  const originalCreateWriteStream = fs.createWriteStream;
  const originalFetch = globalThis.fetch;

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-issue-9157-'));
  const testSpec = {
    file: 'dummy-fixture.bin',
    size: 100,
    sha256: 'deadbeef',
    urlEnv: 'HEX_DUMMY_URL',
  };

  process.env.HEX_DUMMY_URL = 'https://example.invalid/fixture.bin';

  try {
    // Mock fetch returning an async stream
    globalThis.fetch = async () => {
      async function* generateData() {
        yield Buffer.alloc(50, 0x41);
        // Wait briefly so stream error can occur during active streaming
        await new Promise((r) => setTimeout(r, 10));
        yield Buffer.alloc(50, 0x42);
      }
      return {
        ok: true,
        status: 200,
        body: generateData(),
      };
    };

    // Inject stream failure on createWriteStream
    let createdTempPath = null;
    fs.createWriteStream = (filePath, opts) => {
      createdTempPath = filePath;
      const stream = originalCreateWriteStream(filePath, opts);
      // Emit an asynchronous error shortly after creation
      setTimeout(() => {
        stream.emit('error', new Error('ENOSPC: test simulated disk full'));
      }, 5);
      return stream;
    };

    await assert.rejects(
      () => fetchFixture('test-fixture', testSpec),
      (err) => {
        assert.match(err.message, /ENOSPC|test simulated disk full/);
        return true;
      },
    );

    // Verify partial file was cleaned up and not left behind
    assert.ok(createdTempPath, 'temporary stream file was created');
    assert.equal(fs.existsSync(createdTempPath), false, 'partial file must be cleaned up on error');
  } finally {
    fs.createWriteStream = originalCreateWriteStream;
    globalThis.fetch = originalFetch;
    delete process.env.HEX_DUMMY_URL;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
