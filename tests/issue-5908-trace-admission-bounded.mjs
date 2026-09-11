// Regression for #5908: normalizeRecording() measured maxBytes via
// stableStringify(), which jsonSafe() feeds — and jsonSafe() expands every
// ArrayBuffer/TypedArray into a per-byte number array before stringifying.
// A recording carrying a binary payload far above the byte limit was fully
// materialized before admission rejected it. Binary views are now counted
// directly (rejected cheaply) before the full stringify check runs.
import assert from 'node:assert/strict';
import { createTraceProvider } from '../js/runtime/trace-provider.js';

const BIG = 32 * 1024 * 1024; // far above the tiny maxBytes below; cheap to count, expensive to stringify

{
  const recording = {
    recordingId: 'r-5908',
    binaryId: 'bin-5908',
    sourceProvider: 'probe',
    events: [{ type: 'trace-marker', payload: new Uint8Array(BIG) }],
  };
  // The recording must be rejected on admission, not materialized byte-by-byte:
  // on main jsonSafe() expanded the view into a per-byte number array and
  // stringified the whole thing before the same rejection fired. The fix
  // counts real view bytes, so admission is immediate.
  const started = Date.now();
  assert.throws(
    () => createTraceProvider(recording, { maxBytes: 64 * 1024 }),
    (error) => error?.code === 'resource-limit',
    'an oversized binary payload must fail the byte-limit admission',
  );
  assert.ok(Date.now() - started < 2000,
    `admission must reject without materializing the payload (took ${Date.now() - started}ms)`);
}

{
  // A recording under the limit keeps importing (binary views counted, not expanded).
  const recording = {
    recordingId: 'r-5908-small',
    binaryId: 'bin-5908',
    sourceProvider: 'probe',
    events: [{ type: 'trace-marker', payload: new Uint8Array([1, 2, 3]) }],
  };
  const provider = createTraceProvider(recording, { maxBytes: 64 * 1024 });
  assert.ok(provider, 'an in-limit recording still imports');
}

// Escaped strings must be charged incrementally before stableStringify() can allocate
// a second, fully escaped copy of a value that is already over the byte budget.
{
  const recording = {
    recordingId: 'r-5908-string',
    binaryId: 'bin-5908-string',
    sourceProvider: 'probe',
    events: [{ type: 'trace-marker', payload: '"'.repeat(8 * 1024 * 1024) }],
  };
  const started = Date.now();
  assert.throws(
    () => createTraceProvider(recording, { maxBytes: 64 * 1024 }),
    (error) => error?.code === 'resource-limit',
    'an oversized escaped string must fail bounded admission',
  );
  assert.ok(Date.now() - started < 2000, 'escaped-string admission must remain prompt');
}


// Nested binary values must take the same bounded path as direct payload views.
{
  const recording = {
    recordingId: 'r-5908-nested',
    binaryId: 'bin-5908-nested',
    sourceProvider: 'probe',
    events: [{ type: 'trace-marker', payload: { envelope: { bytes: new Uint8Array(8 * 1024 * 1024) } } }],
  };
  const started = Date.now();
  assert.throws(
    () => createTraceProvider(recording, { maxBytes: 64 * 1024 }),
    (error) => error?.code === 'resource-limit',
    'a nested binary payload must fail bounded admission before stable serialization',
  );
  assert.ok(Date.now() - started < 2000, 'nested binary admission must remain prompt');
}

// Cycles and excessively deep graphs are rejected without entering the serializer.
{
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(
    () => createTraceProvider({ recordingId:'r-5908-cycle', binaryId:'b', sourceProvider:'probe', events:[{ payload: cyclic }] }, { maxBytes: 64 * 1024 }),
    (error) => error?.code === 'trace-invalid-recording' && /cyclic/.test(error.message),
  );

  let deep = {};
  const root = deep;
  for (let index = 0; index < 70; index += 1) {
    deep.next = {};
    deep = deep.next;
  }
  assert.throws(
    () => createTraceProvider({ recordingId:'r-5908-deep', binaryId:'b', sourceProvider:'probe', events:[{ payload: root }] }, { maxBytes: 64 * 1024 }),
    (error) => error?.code === 'resource-limit' && /admission depth/.test(error.message),
  );
}


// Node admission also covers primitive-heavy graphs whose serialized size is
// still below maxBytes; this prevents an arbitrarily large object graph from
// bypassing the structural bound merely by using compact scalar values.
{
  const compact = Array.from({ length: 100_001 }, () => 0);
  assert.throws(
    () => createTraceProvider({ recordingId:'r-5908-nodes', binaryId:'b', sourceProvider:'probe', events:[{ payload: compact }] }, { maxBytes: 2 * 1024 * 1024 }),
    (error) => error?.code === 'resource-limit' && /node limit/.test(error.message),
    'primitive-heavy graphs must also respect bounded node admission',
  );
}
