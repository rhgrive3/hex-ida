import assert from 'node:assert/strict';
import test from 'node:test';

import { stableStringify } from '../../../js/core/identity/index.js';
import {
  RuntimeEventNormalizer,
  createRuntimeEvent,
} from '../../../js/runtime/events.js';

const context = {
  runtimeSessionId: 'runtime-4384',
  providerId: 'provider-4384',
  providerVersion: '1',
  sessionEpoch: 1,
};
const encoder = new TextEncoder();
const eventBytes = (event) => encoder.encode(stableStringify(event)).byteLength;
const batchEventBytes = (batch) => batch.events.reduce((total, event) => total + eventBytes(event), 0);
const input = (sequence, payload = {}) => ({
  ...context,
  streamId: 'stream-4384',
  sequence,
  kind: 'trace-marker',
  payload,
  completeness: 'partial',
});

test('#4384 counts the dropped-events marker against maxEvents', () => {
  const normalizer = new RuntimeEventNormalizer(context, { maxEvents: 1, maxBytes: 1024 * 1024 });
  assert.ok(normalizer.push(input(1)));
  assert.equal(normalizer.push(input(2)), null);

  const batch = normalizer.flush();
  assert.equal(batch.events.length, 1);
  assert.equal(batch.events[0].kind, 'dropped-events');
  assert.equal(batch.dropped, 2);
  assert.equal(batch.events[0].payload.dropped, 2);
  assert.equal(batch.completeness, 'truncated');
  assert.equal(normalizer.queuedBytes, 0);

  assert.ok(normalizer.push(input(1)), 'an event evicted for the marker must remain retryable');
});

test('#4384 counts the final marker against the canonical UTF-8 byte budget', () => {
  const first = createRuntimeEvent(input(1, { text: 'a'.repeat(200) }));
  const second = createRuntimeEvent(input(2, { text: 'b'.repeat(200) }));
  const maxBytes = eventBytes(first) + eventBytes(second);
  assert.ok(maxBytes >= 1024);

  const normalizer = new RuntimeEventNormalizer(context, { maxEvents: 10, maxBytes });
  assert.ok(normalizer.push(input(1, { text: 'a'.repeat(200) })));
  assert.ok(normalizer.push(input(2, { text: 'b'.repeat(200) })));
  assert.equal(normalizer.queuedBytes, maxBytes);
  assert.equal(normalizer.push(input(3)), null);

  const batch = normalizer.flush();
  assert.equal(batch.events[0].kind, 'dropped-events');
  assert.equal(batch.events[0].payload.dropped, batch.dropped);
  assert.equal(batch.dropped, 2);
  assert.equal(batch.events.length, 2);
  assert.equal(batch.events[1].sequence, 1, 'oldest retained event remains authoritative');
  assert.ok(batchEventBytes(batch) <= maxBytes);
});

test('#4384 keeps no-drop flush semantics unchanged', () => {
  const normalizer = new RuntimeEventNormalizer(context, { maxEvents: 1, maxBytes: 1024 * 1024 });
  assert.ok(normalizer.push(input(1)));

  const batch = normalizer.flush();
  assert.equal(batch.dropped, 0);
  assert.equal(batch.completeness, 'partial');
  assert.equal(batch.events.length, 1);
  assert.equal(batch.events[0].kind, 'trace-marker');
});

test('#4384 fails closed when even the loss marker exceeds maxBytes', () => {
  const oversizedContext = {
    ...context,
    runtimeSessionId: `runtime-${'x'.repeat(2048)}`,
  };
  const normalizer = new RuntimeEventNormalizer(oversizedContext, { maxEvents: 1, maxBytes: 1024 });
  assert.equal(normalizer.push({ ...oversizedContext, kind: 'trace-marker', payload: {} }), null);

  const batch = normalizer.flush();
  assert.equal(batch.events.length, 0);
  assert.equal(batch.dropped, 1);
  assert.equal(batch.completeness, 'truncated');
  assert.ok(batchEventBytes(batch) <= 1024);
});
