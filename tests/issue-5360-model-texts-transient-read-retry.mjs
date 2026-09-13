// Regression for #5360: resolveModelTexts() deliberately converts a transient
// backend.readAt() failure into "no text", but ensureTextsForKey() then set
// `textsResolved = true` unconditionally. The cached analysis entry was marked
// permanently resolved, so the strings lost to the first failure were never
// retried. Text resolution now reports completeness: only a fully resolved
// model is final, and an incomplete one stays retryable.
import assert from 'node:assert/strict';

import { analyzeFunctionCached, clearAnalysisCache, modelTextsCompleteFor, resolveModelTexts } from '../js/analyze.js';
import { CHUNK_ROWS } from '../js/backend.js';

const TEXT_BYTES = new TextEncoder().encode('hello\0');

function textResult() {
  return { found: true, terminated: true, text: 'hello', bytes: TEXT_BYTES };
}

// 1. Unit: a failed read makes the resolution incomplete; a later attempt can
//    complete it instead of being permanently suppressed.
{
  const model = { addressRefs: [{ row: 0, addr: 0x2000n, value: null }], semantic: [], calls: [], facts: { stringRefs: [] } };
  let fail = true;
  const backend = {
    readAt: async () => {
      if (fail) throw new Error('transient-backend-failure');
      return textResult();
    },
  };

  const first = await resolveModelTexts(backend, model, 96, {});
  assert.equal(modelTextsCompleteFor(first), false, 'a failed read is not a resolved model');
  assert.equal(model.addressRefs[0].text, undefined);

  fail = false;
  const second = await resolveModelTexts(backend, model, 96, {});
  assert.equal(modelTextsCompleteFor(second), true, 'a clean retry resolves the model');
  assert.equal(model.addressRefs[0].text, 'hello');
}

// 2. A model with nothing to resolve is complete.
{
  const empty = { addressRefs: [], semantic: [], calls: [], facts: { stringRefs: [] } };
  const resolved = await resolveModelTexts({}, empty, 96, {});
  assert.equal(modelTextsCompleteFor(resolved), true);
}

// 3. Integration: the cached analysis entry stays unresolved after a transient
//    failure and the next analyzeFunctionCached() call actually retries.
{
  clearAnalysisCache();
  const mn = ['adrp', 'add', 'ret'];
  const ops = ['x8, #0x200000000', 'x0, x8, #0x20', ''];
  let reads = 0;
  const backend = {
    fetchChunk: async (_regionId, chunk) => (chunk === 0 ? { mn, ops } : { mn: [], ops: [] }),
    readAt: async () => {
      reads += 1;
      if (reads === 1) throw new Error('temporary-backend-failure');
      return textResult();
    },
  };
  const region = { id: 'r5360', vmAddr: 0x100000000n, size: BigInt(CHUNK_ROWS * 4), revision: 1 };

  const first = await analyzeFunctionCached(backend, region, 0, 2, null, null, { texts: true });
  assert.equal(first.model.addressRefs.length, 1, 'fixture produces one address reference');
  assert.equal(first.textsResolved, false,
    'a transient read failure must not be recorded as texts-resolved');

  const second = await analyzeFunctionCached(backend, region, 0, 2, null, null, { texts: true });
  assert.equal(second, first, 'the cached analysis entry is reused for the retry');
  assert.equal(second.textsResolved, true, 'the retry resolves the previously failed read');
  assert.equal(second.model.addressRefs[0].text, 'hello');
}

// 4. Fail closed: while the backend keeps failing, the entry never claims to be
//    resolved, and every request retries instead of caching the loss forever.
{
  clearAnalysisCache();
  const mn = ['adrp', 'add', 'ret'];
  const ops = ['x8, #0x200000000', 'x0, x8, #0x20', ''];
  let reads = 0;
  const backend = {
    fetchChunk: async (_regionId, chunk) => (chunk === 0 ? { mn, ops } : { mn: [], ops: [] }),
    readAt: async () => {
      reads += 1;
      throw new Error('permanent-backend-failure');
    },
  };
  const region = { id: 'r5360-permanent', vmAddr: 0x100000000n, size: BigInt(CHUNK_ROWS * 4), revision: 1 };

  const first = await analyzeFunctionCached(backend, region, 0, 2, null, null, { texts: true });
  assert.equal(first.textsResolved, false);
  const second = await analyzeFunctionCached(backend, region, 0, 2, null, null, { texts: true });
  assert.equal(second.textsResolved, false);
  assert.equal(reads > 1, true, 'an unresolved entry keeps retrying instead of being frozen');
  assert.equal(second.model.addressRefs[0].text, undefined);
}

console.log('issue #5360 model texts transient read retry regression passed');
