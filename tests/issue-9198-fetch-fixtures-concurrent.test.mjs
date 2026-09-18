import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fetchFixture } from '../scripts/fetch-real-fixtures.mjs';

test('#9198 concurrent fetchFixture calls do not collide on PID-only temp paths', async () => {
  const originalFetch = globalThis.fetch;
  const content = Buffer.from('hello-world-concurrent-fixture-data');
  const hash = createHash('sha256').update(content).digest('hex');

  const spec = {
    file: `test-concurrent-${Date.now()}.bin`,
    size: content.length,
    sha256: hash,
    urlEnv: 'HEX_CONCURRENT_TEST_URL',
  };

  process.env.HEX_CONCURRENT_TEST_URL = 'https://fixtures.invalid/test.bin';

  const realFixturesDir = path.resolve('tests/.real-fixtures');
  const targetPath = path.join(realFixturesDir, spec.file);

  try {
    // Ensure clean initial state
    if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);

    // 1 & 2: Two concurrent calls for the same fixture
    let fetchCount = 0;
    globalThis.fetch = async () => {
      fetchCount++;
      async function* generateData() {
        // Slow down slightly to ensure concurrency overlap
        await new Promise((r) => setTimeout(r, 10));
        yield content;
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        body: generateData(),
      };
    };

    const [resA, resB] = await Promise.allSettled([
      fetchFixture('test-concurrent', spec),
      fetchFixture('test-concurrent', spec),
    ]);

    assert.equal(resA.status, 'fulfilled', `call A must succeed: ${resA.reason?.message}`);
    assert.equal(resB.status, 'fulfilled', `call B must succeed: ${resB.reason?.message}`);
    assert.ok(fs.existsSync(targetPath), 'target fixture file must exist');
    assert.equal(fs.statSync(targetPath).size, spec.size);

    // 3 & 6: One download fails while another succeeds - must not cleanup other call's temp file
    fs.unlinkSync(targetPath);
    let callIndex = 0;
    globalThis.fetch = async () => {
      callIndex++;
      const current = callIndex;
      async function* generateData() {
        await new Promise((r) => setTimeout(r, 15));
        if (current === 1) {
          throw new Error('simulated network failure for call 1');
        }
        yield content;
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        body: generateData(),
      };
    };

    const [res1, res2] = await Promise.allSettled([
      fetchFixture('test-concurrent', spec),
      fetchFixture('test-concurrent', spec),
    ]);

    const failRes = res1.status === 'rejected' ? res1 : res2;
    const successRes = res1.status === 'fulfilled' ? res1 : res2;
    assert.notEqual(failRes, successRes, 'one call must fail and the other must succeed');
    assert.equal(failRes.status, 'rejected', 'one call should fail as simulated');
    assert.equal(successRes.status, 'fulfilled', `other call must succeed and not be affected: ${successRes.reason?.message}`);
    assert.ok(fs.existsSync(targetPath), 'target fixture must still exist from successful call');
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.HEX_CONCURRENT_TEST_URL;
    if (fs.existsSync(targetPath)) {
      try { fs.unlinkSync(targetPath); } catch {}
    }
  }
});
