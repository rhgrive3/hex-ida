// Issue #8971 regression: canonical RuntimeObservation payloads must be admitted
// by an explicit byte/node budget before any owned copy or identity material is
// allocated, and identity must be derived from bounded chunked byte material
// instead of re-widening the payload into a second boxed array plus its decimal
// JSON text. One oversized observation fails closed deterministically; it must
// not abort the worker heap. #6214 immutability and #7108 type-sensitive
// identity are preserved.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

import {
  RuntimeAuthorityTracker,
  createRuntimeAuthorityBinding,
  createRuntimeObservation,
  validateRuntimeObservation,
} from '../../../js/runtime/authority.js';

const AUTHORITY_MODULE = new URL('../../../js/runtime/authority.js', import.meta.url).href;
const ONE_MiB = 1024 * 1024;

const binding = createRuntimeAuthorityBinding({
  providerIdentity: 'provider:8971',
  runtimeInstanceIdentity: 'runtime:8971',
  targetIdentity: 'target:8971',
  binaryIdentity: 'binary:8971',
  moduleIdentity: 'module:8971',
  loadMappingIdentity: 'mapping:8971',
  sessionIdentity: 'session:8971',
  capabilityVersion: '1',
  epoch: 0,
});

function observe(payload, sequence = 0) {
  return createRuntimeObservation({
    binding,
    sequence,
    observedAt: '2026-09-15T00:00:00Z',
    kind: 'buffer-snapshot',
    payload,
  });
}

function heapDeltaOf(run) {
  global.gc?.();
  const before = process.memoryUsage().heapUsed;
  const result = run();
  const peak = process.memoryUsage().heapUsed;
  return { delta: peak - before, result };
}

test('#8971 an over-budget typed view is rejected before canonical allocation', () => {
  for (const [label, make] of [
    ['Uint8Array', (size) => new Uint8Array(size)],
    ['ArrayBuffer', (size) => new ArrayBuffer(size)],
    ['DataView', (size) => new DataView(new ArrayBuffer(size))],
    ['Float64Array', (size) => new Float64Array(size / 8)],
    ['Int16Array', (size) => new Int16Array(size / 2)],
  ]) {
    assert.throws(
      () => observe({ bytes: make(3 * ONE_MiB) }),
      (error) => error instanceof TypeError
        && error.message === 'runtime-observation-payload-bytes-exceed-limit',
      `${label} payloads must fail closed on the byte budget`,
    );
  }
});

test('#8971 the same rejection covers a nested and an already-canonical payload', () => {
  assert.throws(
    () => observe({ frames: [{ bytes: new Uint8Array(3 * ONE_MiB) }] }),
    /runtime-observation-payload-bytes-exceed-limit/,
  );
  // A caller may hand in the canonical transport shape directly; the boxed byte
  // array is charged as bytes, not as an unbounded number of structural nodes.
  assert.throws(
    () => observe({ raw: Object.freeze({ $hexRuntimeBinary: 'Uint8Array', bytes: new Array(3 * ONE_MiB).fill(7) }) }),
    /runtime-observation-payload-bytes-exceed-limit/,
  );
});

test('#8971 an admitted payload keeps bounded identity work (no per-byte JSON text)', () => {
  const payload = new Uint8Array(ONE_MiB);
  payload[0] = 1;
  observe(payload); // warm the module and the shape caches
  const { delta } = heapDeltaOf(() => observe(payload));
  // The pre-fix path materialised the owned boxed array, a second tagged array,
  // and the full decimal JSON of a million bytes inside one call: 37.29 MB of
  // heap growth measured on the base commit. The retained canonical boxed array
  // is the only remaining per-byte cost, and #8971 permits it under an explicit
  // small limit; the identity material itself is chunked.
  assert.ok(delta < 12 * ONE_MiB, `identity+canonicalisation allocated ${delta} bytes for a 1 MiB payload`);
});

test('#8971 a 8 MiB observation under a 128 MiB heap fails closed instead of aborting', () => {
  const probe = `
    import(${JSON.stringify(AUTHORITY_MODULE)}).then((m) => {
      const binding = m.createRuntimeAuthorityBinding({
        providerIdentity: 'provider:oom', runtimeInstanceIdentity: 'runtime:oom',
        targetIdentity: 'target:oom', binaryIdentity: 'binary:oom', moduleIdentity: 'module:oom',
        loadMappingIdentity: 'mapping:oom', sessionIdentity: 'session:oom', capabilityVersion: '1', epoch: 0,
      });
      try {
        m.createRuntimeObservation({
          binding, sequence: 0, observedAt: '2026-09-15T00:00:00Z', kind: 'buffer-snapshot',
          payload: new Uint8Array(8 * 1024 * 1024),
        });
        process.stdout.write('accepted');
      } catch (error) {
        process.stdout.write(String(error?.message));
      }
    });
  `;
  const run = spawnSync(process.execPath, ['--max-old-space-size=128', '--input-type=module', '-e', probe], {
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, `bounded-heap worker died: ${run.stderr?.slice(-400)}`);
  assert.equal(run.stdout, 'runtime-observation-payload-bytes-exceed-limit');
});

test('#8971 #6214 immutability holds for an admitted binary payload', () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const observation = observe({ bytes });
  bytes[0] = 99;
  assert.deepEqual(observation.payload.bytes.bytes, [1, 2, 3, 4]);
  assert.throws(() => { observation.payload.bytes.bytes[0] = 7; }, TypeError);
  assert.equal(validateRuntimeObservation(binding, observation).ok, true);
});

test('#8971 identity stays type- and content-sensitive (#7108)', () => {
  const asView = observe({ bytes: new Uint8Array([1, 2, 3, 0]) });
  const asViewTwin = observe({ bytes: new Uint8Array([1, 2, 3, 0]) });
  assert.equal(asView.observationId, asViewTwin.observationId, 'same content keeps a stable id');
  const otherType = observe({ bytes: new Int8Array([1, 2, 3, 0]) });
  assert.notEqual(asView.observationId, otherType.observationId, 'binary type must be identity-bearing');
  const plainArray = observe({ bytes: [1, 2, 3, 0] });
  assert.notEqual(asView.observationId, plainArray.observationId, 'a typed view is not a plain array');
  const flipped = observe({ bytes: new Uint8Array([1, 2, 3, 1]) });
  assert.notEqual(asView.observationId, flipped.observationId, 'one byte must change the id');
  const padded = observe({ bytes: new Uint8Array([1, 2, 3, 0, 0]) });
  assert.notEqual(asView.observationId, padded.observationId, 'payload length must be identity-bearing');
  const chunkSplit = observe({ bytes: new Uint8Array(100 * 1024 + 5) });
  const chunkSplitTwin = observe({ bytes: new Uint8Array(100 * 1024 + 5) });
  assert.equal(chunkSplit.observationId, chunkSplitTwin.observationId, 'chunked folding stays deterministic');
  assert.ok(asView.observationId.startsWith('runtime-observation:v3:'), 'representation change is migrated');
});

test('#8971 tampering with an admitted payload is still detected', () => {
  const observation = observe({ bytes: new Uint8Array([9, 8, 7]) });
  const forged = structuredClone({ ...observation });
  forged.payload.bytes.bytes[0] = 1;
  assert.equal(validateRuntimeObservation(binding, forged).ok, false);
});

test('#8971 aggregate retained bytes are bounded, not only the record count', () => {
  const tracker = new RuntimeAuthorityTracker(binding, {
    maxObservations: 128,
    maxRetainedPayloadBytes: 3 * ONE_MiB,
  });
  const chunk = new Uint8Array(ONE_MiB);
  let accepted = 0;
  for (let sequence = 0; sequence < 8; sequence += 1) {
    const verdict = tracker.accept({
      observedAt: '2026-09-15T00:00:00Z',
      kind: 'memory-read',
      sequence,
      payload: { bytes: chunk },
    });
    if (verdict.status === 'accepted') accepted += 1;
    else assert.equal(verdict.reason, 'runtime-tracker-retained-payload-bytes-exceeded');
  }
  assert.ok(accepted >= 1 && accepted < 8, `expected a bounded run, accepted ${accepted}`);
  assert.ok(tracker.retainedPayloadBytes <= 3 * ONE_MiB);
  assert.equal(tracker.observations.length, accepted);
});

test('#8971 count-only eviction still releases the retained byte budget', () => {
  const tracker = new RuntimeAuthorityTracker(binding, {
    maxObservations: 2,
    maxRetainedPayloadBytes: 8 * ONE_MiB,
  });
  const chunk = new Uint8Array(ONE_MiB);
  for (let sequence = 0; sequence < 5; sequence += 1) {
    const verdict = tracker.accept({
      observedAt: '2026-09-15T00:00:00Z', kind: 'memory-read', sequence, payload: { bytes: chunk },
    });
    assert.equal(verdict.status, 'accepted', JSON.stringify(verdict));
  }
  assert.equal(tracker.observations.length, 2);
  assert.equal(tracker.retainedPayloadBytes, 2 * ONE_MiB);
  const snapshot = tracker.snapshot();
  assert.equal(snapshot.observations.length, 2);
  assert.equal(validateRuntimeObservation(binding, snapshot.observations[1]).ok, true);
});

test('#8971 node budget rejects structural expansion beyond the admission contract', () => {
  assert.throws(
    () => observe({ wide: Array.from({ length: 200_000 }, (_, index) => index % 7) }),
    (error) => error instanceof TypeError && error.message === 'runtime-observation-payload-nodes-exceed-limit',
  );
});

test('#8971 an invalid byte budget option fails closed', () => {
  assert.throws(
    () => new RuntimeAuthorityTracker(binding, { maxRetainedPayloadBytes: 0 }),
    /runtime-max-retained-payload-bytes-invalid/,
  );
});


test('#8971 multi-MiB-class admitted binary storage is packed and snapshot reads do not recreate boxed bytes', () => {
  const bytes = new Uint8Array(ONE_MiB);
  bytes[0] = 0x5a;
  bytes[bytes.length - 1] = 0xa5;
  const observation = observe({ bytes });
  const canonical = observation.payload.bytes;
  assert.equal(canonical.$hexRuntimeBinary, 'Uint8Array');
  assert.equal(canonical.encoding, 'base64-chunks-v1');
  assert.equal(canonical.byteLength, ONE_MiB);
  assert.ok(Array.isArray(canonical.chunks));
  assert.ok(canonical.chunks.length < 256, `expected bounded chunk references, got ${canonical.chunks.length}`);
  assert.equal(Object.prototype.hasOwnProperty.call(canonical, 'bytes'), false,
    'large canonical payloads must not retain one JS Number per byte');
  bytes.fill(0);
  assert.equal(validateRuntimeObservation(binding, observation).ok, true,
    'caller mutation after publication cannot alter packed canonical content');

  const tracker = new RuntimeAuthorityTracker(binding, { maxRetainedPayloadBytes: 2 * ONE_MiB });
  assert.equal(tracker.accept(observation).status, 'accepted');
  for (const copy of [tracker.observations[0], tracker.snapshot().observations[0]]) {
    assert.equal(copy.payload.bytes.encoding, 'base64-chunks-v1');
    assert.equal(Object.prototype.hasOwnProperty.call(copy.payload.bytes, 'bytes'), false,
      'public read/snapshot must not widen packed bytes back into boxed arrays');
    assert.equal(copy.payload.bytes.chunks.length, canonical.chunks.length);
  }
});

test('#8971 packed binary tampering remains identity-detectable', () => {
  const observation = observe({ bytes: new Uint8Array(ONE_MiB) });
  const forged = structuredClone(observation);
  forged.payload.bytes.chunks[0] = forged.payload.bytes.chunks[0].replace(/^A/, 'B');
  const checked = validateRuntimeObservation(binding, forged);
  assert.equal(checked.ok, false);
  assert.ok(['runtime-observation-binary-invalid', 'runtime-observation-identity-invalid'].includes(checked.reason), checked.reason);
});

test('#8971 imported schema observations are payload-admitted before tracker cloning', () => {
  const honest = structuredClone(observe({ ok: true }, 1));
  honest.payload = {
    raw: {
      $hexRuntimeBinary: 'Uint8Array',
      // Sparse is deliberate: the byteLength alone must reject before any
      // element walk/copy of an imported canonical record.
      bytes: new Array(3 * ONE_MiB),
    },
  };
  const tracker = new RuntimeAuthorityTracker(binding);
  const result = tracker.accept(honest);
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'runtime-observation-payload-bytes-exceed-limit');
});

test('#8971 cancellation has authority during chunked canonicalization/identity work', () => {
  let polls = 0;
  assert.throws(
    () => createRuntimeObservation({
      binding,
      sequence: 2,
      observedAt: '2026-09-15T00:00:00Z',
      kind: 'memory-read',
      payload: { bytes: new Uint8Array(ONE_MiB) },
    }, { isCancelled: () => ++polls > 8 }),
    (error) => error instanceof TypeError && error.message === 'runtime-observation-cancelled',
  );
  assert.ok(polls > 8, 'long binary work must poll cancellation more than once');
});

test('#8971 deadline authority stops long identity work deterministically', () => {
  let tick = 0;
  assert.throws(
    () => createRuntimeObservation({
      binding,
      sequence: 3,
      observedAt: '2026-09-15T00:00:00Z',
      kind: 'memory-read',
      payload: { bytes: new Uint8Array(ONE_MiB) },
    }, { deadlineAt: 8, now: () => tick++ }),
    (error) => error instanceof TypeError && error.message === 'runtime-observation-deadline-exceeded',
  );
});

test('#8971 tracker accept exposes the same cancellation authority for fresh and imported observations', () => {
  const tracker = new RuntimeAuthorityTracker(binding);
  let freshPolls = 0;
  const fresh = tracker.accept({
    sequence: 4,
    observedAt: '2026-09-15T00:00:00Z',
    kind: 'memory-read',
    payload: { bytes: new Uint8Array(ONE_MiB) },
  }, { isCancelled: () => ++freshPolls > 6 });
  assert.deepEqual(fresh, { status: 'rejected', reason: 'runtime-observation-cancelled' });

  const imported = observe({ bytes: new Uint8Array(ONE_MiB) }, 5);
  const cancelled = tracker.accept(imported, { signal: { aborted: true } });
  assert.deepEqual(cancelled, { status: 'rejected', reason: 'runtime-observation-cancelled' });
});


test('#8971 1/2/4/8 MiB bounded-heap scaling has no boxed-array amplification', () => {
  const probe = `
    import(${JSON.stringify(AUTHORITY_MODULE)}).then((m) => {
      const binding = m.createRuntimeAuthorityBinding({
        providerIdentity: 'provider:scale', runtimeInstanceIdentity: 'runtime:scale',
        targetIdentity: 'target:scale', binaryIdentity: 'binary:scale', moduleIdentity: 'module:scale',
        loadMappingIdentity: 'mapping:scale', sessionIdentity: 'session:scale', capabilityVersion: '1', epoch: 0,
      });
      const results = [];
      for (const mib of [1, 2, 4, 8]) {
        const before = process.memoryUsage().heapUsed;
        try {
          const observation = m.createRuntimeObservation({
            binding, sequence: mib, observedAt: '2026-09-15T00:00:00Z', kind: 'memory-read',
            payload: new Uint8Array(mib * 1024 * 1024),
          });
          results.push([mib, 'accepted', observation.payload.encoding || 'boxed', process.memoryUsage().heapUsed - before]);
        } catch (error) {
          results.push([mib, String(error?.message), null, process.memoryUsage().heapUsed - before]);
        }
      }
      process.stdout.write(JSON.stringify(results));
    });
  `;
  const run = spawnSync(process.execPath, ['--max-old-space-size=128', '--input-type=module', '-e', probe], {
    encoding: 'utf8', timeout: 15_000,
  });
  assert.equal(run.status, 0, `bounded scaling worker died: ${run.stderr?.slice(-400)}`);
  const results = JSON.parse(run.stdout);
  assert.deepEqual(results.map((row) => row.slice(0, 3)), [
    [1, 'accepted', 'base64-chunks-v1'],
    [2, 'accepted', 'base64-chunks-v1'],
    [4, 'runtime-observation-payload-bytes-exceed-limit', null],
    [8, 'runtime-observation-payload-bytes-exceed-limit', null],
  ]);
  for (const [mib, status, , heapDelta] of results) {
    if (status === 'accepted') assert.ok(heapDelta < 20 * ONE_MiB, `${mib} MiB retained ${heapDelta} heap bytes`);
  }
});

test('#8971 packed storage preserves binary constructor identity across large view kinds', () => {
  const source = new ArrayBuffer(ONE_MiB);
  const variants = [
    ['ArrayBuffer', source],
    ['DataView', new DataView(source)],
    ['Float64Array', new Float64Array(source)],
    ['Uint8Array', new Uint8Array(source)],
  ];
  const observations = variants.map(([type, value], index) => [type, observe({ bytes: value }, 20 + index)]);
  for (const [type, observation] of observations) {
    assert.equal(observation.payload.bytes.$hexRuntimeBinary, type);
    assert.equal(observation.payload.bytes.encoding, 'base64-chunks-v1');
    assert.equal(observation.payload.bytes.byteLength, ONE_MiB);
  }
  assert.equal(new Set(observations.map(([, observation]) => observation.observationId)).size, variants.length,
    'constructor type remains identity-bearing for packed content');
});
