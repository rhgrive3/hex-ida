// Regression for #5316: rejectBinaryPayload() only inspected property NAMES
// against a fixed blacklist, so a TypedArray/DataView/ArrayBuffer under any
// other key (payload, data, …) passed the "binary content cannot be sent"
// boundary and sanitizeValue() enumerated its raw bytes into the model
// context. Contract now: the boundary fails closed on binary container VALUE
// types (ArrayBuffer views, ArrayBuffer, SharedArrayBuffer) wherever they
// appear in the request context; ordinary arrays/scalars pass unchanged and
// the legacy name blacklist keeps rejecting the forbidden keys.
import assert from 'node:assert/strict';
import { normalizeAITurnRequest, rejectBinaryPayload, sanitizeValue } from '../js/ai/provider/worker-protocol.js';

function expectBinaryRejected(context) {
  assert.throws(
    () => normalizeAITurnRequest({ mode: 'chat', style: 'analyst', context }),
    (error) => error?.status === 422 && error?.code === 'binary_upload_forbidden',
  );
}

const base = { request: { goal: 'test' } };

// 1. Top-level TypedArray under a non-blacklisted key.
expectBinaryRejected({ ...base, payload: new Uint8Array([0xca, 0xfe, 0xba, 0xbe]) });
// 2. Nested TypedArray (Uint16Array).
expectBinaryRejected({ ...base, nested: { data: new Uint16Array([1]) } });
// 3. DataView and ArrayBuffer.
expectBinaryRejected({ ...base, view: new DataView(new ArrayBuffer(8)) });
expectBinaryRejected({ ...base, buffer: new ArrayBuffer(4) });
// 4. Int8Array/Float64Array/Buffer-like views.
expectBinaryRejected({ ...base, bytes: new Int8Array([1]) });
expectBinaryRejected({ ...base, floats: new Float64Array([1.5]) });
// 5. Legacy forbidden keys keep rejecting (auxiliary defense).
expectBinaryRejected({ ...base, binaryBytes: new Uint8Array([1]) });

// 6. Ordinary analysis-derived data still passes.
{
  const req = normalizeAITurnRequest({
    mode: 'chat',
    style: 'analyst',
    context: {
      ...base,
      numbers: [1, 2, 3],
      labels: ['main', 'sub'],
      facts: { count: 2, deep: { ok: true } },
    },
  });
  assert.deepEqual(req.context.facts, { count: 2, deep: { ok: true } });
  assert.deepEqual(req.context.numbers, [1, 2, 3]);
}

// 7. sanitizeValue never materializes raw binary bytes (defense in depth):
// binary containers drop to null instead of leaking enumerated byte objects.
assert.equal(sanitizeValue(new Uint8Array([1, 2, 3]), 0), null);
assert.equal(sanitizeValue(new ArrayBuffer(4), 0), null);
assert.deepEqual(sanitizeValue({ a: new Uint8Array([9]), b: 'keep' }, 0), { b: 'keep' });
assert.equal(rejectBinaryPayload({ plain: { deep: 'value' } }), undefined, 'plain objects stay accepted');
