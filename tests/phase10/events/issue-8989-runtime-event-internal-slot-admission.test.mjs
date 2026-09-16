import assert from 'node:assert/strict';
import test from 'node:test';

import { createRuntimeEvent } from '../../../js/runtime/events.js';

const base = {
  runtimeSessionId: 'runtime-8989',
  providerId: 'provider-8989',
  providerVersion: '1',
  sessionEpoch: 1,
  kind: 'instrumentation-observation',
  timestamp: '2026-09-15T00:00:00.000Z',
  completeness: 'complete',
};

function makeEvent(payload, options = { maxBytes: 4096 }) {
  return createRuntimeEvent({ ...base, payload }, options);
}

function sharedArrayBuffer(bytes) {
  const buffer = new SharedArrayBuffer(bytes.length);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function assertUnsupportedRejected(payload) {
  assert.throws(
    () => makeEvent(payload),
    (err) => err?.code === 'runtime-event-unsupported-value',
  );
}

test('#8989 byte-distinct direct SharedArrayBuffer payloads are rejected, not collapsed to {} / one identity', () => {
  assertUnsupportedRejected({ bytes: sharedArrayBuffer([1, 2, 3, 4]) });
  assertUnsupportedRejected({ bytes: sharedArrayBuffer([9, 8, 7, 6]) });
});

test('#8989 a direct SharedArrayBuffer never aliases an empty plain object', () => {
  const plain = makeEvent({ bytes: {} });
  assert.deepEqual(plain.payload.bytes, {});
  assertUnsupportedRejected({ bytes: sharedArrayBuffer([1]) });
});

test('#8989 RegExp payloads fail closed instead of collapsing to {}', () => {
  assertUnsupportedRejected({ matcher: /alpha/g });
  assertUnsupportedRejected({ matcher: /beta/i });
});

test('#8989 nested unsupported internal-slot values follow the same fail-closed policy', () => {
  assertUnsupportedRejected({ wrapper: { inner: sharedArrayBuffer([1, 2]) } });
  assertUnsupportedRejected({ wrapper: { inner: /x/g } });
  assertUnsupportedRejected({ wrapper: [new Error('boom')] });
});

test('#8989 an unsupported payload never mints a valid event id', () => {
  let mintedId = 'NOT-THROWN';
  try {
    makeEvent({ bytes: sharedArrayBuffer([5, 5, 5, 5]) });
  } catch {
    mintedId = null;
  }
  assert.equal(mintedId, null);
});

test('#8989 supported Date / ArrayBuffer / typed view / Map / Set / plain records stay accepted and deterministic', () => {
  const supported = {
    when: new Date('2026-01-02T03:04:05.000Z'),
    buffer: new Uint8Array([1, 2, 3]),
    ab: new Uint8Array([4, 5, 6]).buffer,
    list: [1, 'two', true, null],
    map: new Map([['k', 'v']]),
    set: new Set(['a', 'b']),
    nested: { flag: false, num: 12.5, big: 10n, text: 'ok' },
  };
  const a = makeEvent(supported);
  const b = makeEvent(supported);
  assert.equal(a.eventId, b.eventId);
  assert.equal(a.completeness, 'complete');
  assert.deepEqual(a.payload.buffer, [1, 2, 3]);
  assert.equal(a.payload.nested.text, 'ok');
});

test('#8989 a null-prototype record is still a genuine plain record and is admitted', () => {
  const record = Object.create(null);
  record.a = 1;
  record.b = 'two';
  const event = makeEvent({ header: record });
  assert.equal(event.payload.header.b, 'two');
});

test('#8989 distinct supported plain payloads still produce distinct identities', () => {
  const x = makeEvent({ kind: 'read', addr: 16 });
  const y = makeEvent({ kind: 'read', addr: 32 });
  assert.notEqual(x.eventId, y.eventId);
});
