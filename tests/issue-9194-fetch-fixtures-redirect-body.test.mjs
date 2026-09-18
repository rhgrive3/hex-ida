import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchWithHttpsRedirects } from '../scripts/fetch-real-fixtures.mjs';

test('#9194 fetchWithHttpsRedirects releases intermediate response bodies on redirect', async () => {
  const originalFetch = globalThis.fetch;

  try {
    // 1. 302 (with body) -> 200
    const cancelled1 = [];
    let hop1 = 0;
    globalThis.fetch = async () => {
      hop1++;
      if (hop1 === 1) {
        return {
          status: 302,
          headers: new Headers({ location: 'https://example.test/h2' }),
          body: { cancel: async () => { cancelled1.push(1); } },
        };
      }
      return {
        status: 200,
        headers: new Headers(),
        body: { dummy: true },
      };
    };

    const res1 = await fetchWithHttpsRedirects('https://example.test/h1', 5);
    assert.equal(res1.status, 200);
    assert.deepEqual(cancelled1, [1], 'intermediate 302 body must be cancelled');
    assert.deepEqual(res1.body, { dummy: true }, 'final response body must not be cancelled');

    // 2. 301, 303, 307, 308 statuses
    for (const status of [301, 303, 307, 308]) {
      const cancelled = [];
      let hop = 0;
      globalThis.fetch = async () => {
        hop++;
        if (hop === 1) {
          return {
            status,
            headers: new Headers({ location: 'https://example.test/dest' }),
            body: { cancel: async () => { cancelled.push(status); } },
          };
        }
        return {
          status: 200,
          headers: new Headers(),
          body: { final: true },
        };
      };
      const res = await fetchWithHttpsRedirects('https://example.test/init', 5);
      assert.equal(res.status, 200);
      assert.deepEqual(cancelled, [status], `status ${status} body must be cancelled`);
    }

    // 3. Multi-hop: 302 -> 302 -> 200
    const cancelledMulti = [];
    let hopMulti = 0;
    globalThis.fetch = async () => {
      hopMulti++;
      if (hopMulti <= 2) {
        const id = hopMulti;
        return {
          status: 302,
          headers: new Headers({ location: `https://example.test/step${id + 1}` }),
          body: { cancel: async () => { cancelledMulti.push(id); } },
        };
      }
      return {
        status: 200,
        headers: new Headers(),
        body: { done: true },
      };
    };

    const resMulti = await fetchWithHttpsRedirects('https://example.test/step1', 5);
    assert.equal(resMulti.status, 200);
    assert.deepEqual(cancelledMulti, [1, 2], 'both intermediate bodies must be cancelled in order');

    // 4. Redirect limit exceeded: releases body before throwing
    const cancelledLimit = [];
    globalThis.fetch = async () => ({
      status: 302,
      headers: new Headers({ location: 'https://example.test/loop' }),
      body: { cancel: async () => { cancelledLimit.push('limit'); } },
    });

    await assert.rejects(
      () => fetchWithHttpsRedirects('https://example.test/loop', 2),
      /Too many HTTP redirects/,
    );
    assert.ok(cancelledLimit.length > 0, 'body must be cancelled on redirect limit error');

    // 5. Missing Location header: releases body before throwing
    const cancelledNoLoc = [];
    globalThis.fetch = async () => ({
      status: 302,
      headers: new Headers(),
      body: { cancel: async () => { cancelledNoLoc.push('no-loc'); } },
    });

    await assert.rejects(
      () => fetchWithHttpsRedirects('https://example.test/start', 5),
      /Redirect missing Location header/,
    );
    assert.deepEqual(cancelledNoLoc, ['no-loc'], 'body must be cancelled when location is missing');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
