import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchFixture, releaseBody } from '../scripts/fetch-real-fixtures.mjs';

test('#9204 releaseBody handles cancel, destroy, and null safely', async () => {
  let cancelled = false;
  await releaseBody({ body: { cancel: async () => { cancelled = true; } } });
  assert.equal(cancelled, true);

  let destroyed = false;
  await releaseBody({ body: { destroy: () => { destroyed = true; } } });
  assert.equal(destroyed, true);

  // Null/missing body
  await releaseBody(null);
  await releaseBody({});
  await releaseBody({ body: null });
});

test('#9204 fetchFixture releases final HTTP error response body before throw', async () => {
  const originalFetch = globalThis.fetch;
  const envKey = 'HEX_TEST_FIXTURE_9204_URL';
  process.env[envKey] = 'https://example.test/fixture.bin';

  const spec = {
    file: 'test-9204.bin',
    size: 100,
    sha256: '0000000000000000000000000000000000000000000000000000000000000000',
    urlEnv: envKey,
  };

  try {
    // 1. HTTP 500 with body having .cancel()
    let cancelled500 = 0;
    globalThis.fetch = async () => ({
      ok: false,
      status: 500,
      headers: new Headers(),
      body: {
        cancel: async () => {
          cancelled500++;
        },
      },
    });

    await assert.rejects(
      async () => {
        await fetchFixture('test-500', spec);
      },
      /test-500: download failed with HTTP 500/,
    );
    assert.equal(cancelled500, 1, 'HTTP 500 response body must be cancelled');

    // 2. HTTP 404 with body having .destroy()
    let destroyed404 = 0;
    globalThis.fetch = async () => ({
      ok: false,
      status: 404,
      headers: new Headers(),
      body: {
        destroy: () => {
          destroyed404++;
        },
      },
    });

    await assert.rejects(
      async () => {
        await fetchFixture('test-404', spec);
      },
      /test-404: download failed with HTTP 404/,
    );
    assert.equal(destroyed404, 1, 'HTTP 404 response body must be destroyed');

    // 3. HTTP 502 with null body
    globalThis.fetch = async () => ({
      ok: false,
      status: 502,
      headers: new Headers(),
      body: null,
    });

    await assert.rejects(
      async () => {
        await fetchFixture('test-502', spec);
      },
      /test-502: download failed with HTTP 502/,
    );

    // 4. Intermediate 302 redirect -> final 500 error
    let cancelledRedirect = 0;
    let cancelledFinal = 0;
    let hop = 0;
    globalThis.fetch = async () => {
      hop++;
      if (hop === 1) {
        return {
          status: 302,
          headers: new Headers({ location: 'https://example.test/final.bin' }),
          body: {
            cancel: async () => {
              cancelledRedirect++;
            },
          },
        };
      }
      return {
        ok: false,
        status: 500,
        headers: new Headers(),
        body: {
          cancel: async () => {
            cancelledFinal++;
          },
        },
      };
    };

    await assert.rejects(
      async () => {
        await fetchFixture('test-redirect-500', spec);
      },
      /test-redirect-500: download failed with HTTP 500/,
    );
    assert.equal(cancelledRedirect, 1, 'Intermediate 302 redirect body must be cancelled');
    assert.equal(cancelledFinal, 1, 'Final 500 response body must be cancelled');
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env[envKey];
  }
});
