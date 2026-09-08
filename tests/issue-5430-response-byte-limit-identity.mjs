// Regression for #5430: the response byte limit may only be set by a
// primitive finite positive number. Structured values (arrays/objects) and
// booleans fall back to the default 2MiB instead of becoming the authority.
import assert from 'node:assert/strict';
import { requestJSON } from '../js/ai/transport.js';

const threeMiB = 'x'.repeat(3 * 1024 * 1024);
const fakeFetch = (text) => async () => ({
  ok: true, status: 200,
  headers: { get: (name) => (name === 'content-length' ? String(text.length) : null) },
  body: null,
  text: async () => text,
});

// Valid primitive numbers keep the existing clamp/floor semantics.
{
  const payload = await requestJSON('/api/ai', {}, {
    maxResponseBytes: 4 * 1024 * 1024,
    fetchImpl: fakeFetch(JSON.stringify({ ok: true, pad: threeMiB })),
  });
  assert.equal(payload.ok, true, 'a valid 4MiB limit accepts a 3MiB response');
}
{
  await assert.rejects(
    requestJSON('/api/ai', {}, { maxResponseBytes: 1024, fetchImpl: fakeFetch(JSON.stringify({ ok: true, pad: threeMiB })) }),
    (error) => error.type === 'context_too_large' && error.details?.maxBytes === 1024,
    'a valid 1KiB limit keeps clamping at 1024',
  );
}

// Structured and boolean values never become the authority: the default
// 2MiB limit rejects the 3MiB response.
for (const forged of [['16777216'], { bytes: 16777216 }, true, '16777216', null]) {
  await assert.rejects(
    requestJSON('/api/ai', {}, { maxResponseBytes: forged, fetchImpl: fakeFetch(JSON.stringify({ ok: true, pad: threeMiB })) }),
    (error) => error.type === 'context_too_large' && error.details?.maxBytes === 2 * 1024 * 1024,
    `structured maxResponseBytes ${JSON.stringify(forged)} must fall back to the default limit`,
  );
}

console.log('issue #5430 response byte limit identity regressions PASS');
