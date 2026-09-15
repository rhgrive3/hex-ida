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
} from '../js/runtime/authority.js';

const AUTHORITY_MODULE = new URL('../js/runtime/authority.js', import.meta.url).href;
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
  assert.ok(asView.observationId.startsWith('runtime-observation:v2:'), 'representation change is migrated');
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
