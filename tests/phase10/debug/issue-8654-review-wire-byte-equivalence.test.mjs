import assert from 'node:assert/strict';
import test from 'node:test';

import { DEBUG_PROTOCOL_VERSION } from '../../../js/debug/adapter.js';
import { assertWireBytesAtMost, validateRemotePacket } from '../../../js/debug/remote-protocol.js';
import { validateProviderPacket } from '../../../js/runtime/provider-protocol.js';

const MAX_PACKET_BYTES = 1024 * 1024;

function eventWithData(data) {
  return { version: DEBUG_PROTOCOL_VERSION, type: 'event', epoch: 0, event: 'probe', data };
}

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

test('#8654 review: high-cardinality tiny primitives are not false-rejected by pre-admission', () => {
  const packet = eventWithData(Array(50_000).fill(0));
  assert.ok(jsonBytes(packet) < MAX_PACKET_BYTES, 'control packet must genuinely fit the canonical wire budget');
  assert.doesNotThrow(() => assertWireBytesAtMost(packet, MAX_PACKET_BYTES));
  assert.doesNotThrow(() => validateRemotePacket(packet));
});

test('#8654 review: escaped controls reject before JSON materialization', () => {
  const packet = eventWithData({ body: '\u0000'.repeat(300_000) });
  assert.ok(jsonBytes(packet) > MAX_PACKET_BYTES, 'control payload must exceed the canonical wire budget after JSON escaping');
  const original = JSON.stringify;
  JSON.stringify = () => { throw new Error('late-json-materialization-reached'); };
  try {
    assert.throws(() => validateRemotePacket(packet), (error) => error?.code === 'packet-too-large');
  } finally {
    JSON.stringify = original;
  }
});

test('#8654 review: escape-heavy exact 1 MiB is admitted and limit+1 is rejected', () => {
  const base = eventWithData({ body: '' });
  const overhead = jsonBytes(base);
  const controls = Math.floor((MAX_PACKET_BYTES - overhead) / 6);
  const tail = MAX_PACKET_BYTES - overhead - (controls * 6);
  const exact = eventWithData({ body: '\u0000'.repeat(controls) + 'a'.repeat(tail) });
  const over = eventWithData({ body: exact.data.body + 'a' });
  assert.equal(jsonBytes(exact), MAX_PACKET_BYTES);
  assert.equal(jsonBytes(over), MAX_PACKET_BYTES + 1);
  assert.doesNotThrow(() => validateRemotePacket(exact));
  assert.throws(() => validateRemotePacket(over), (error) => error?.code === 'packet-too-large');
});

test('#8654 review: non-ASCII and lone-surrogate JSON bytes match the wire authority', () => {
  const payload = { text: 'é😀\\"\b\t\n\f\r\u0000\ud800x\udc00' };
  const packet = eventWithData(payload);
  const exact = jsonBytes(packet);
  assert.doesNotThrow(() => assertWireBytesAtMost(packet, exact));
  assert.throws(() => assertWireBytesAtMost(packet, exact - 1), (error) => error?.code === 'packet-too-large');
});

test('#8654 review: provider native tagged values are counted in encoded form', () => {
  const packet = {
    protocol: 'hex-runtime-provider',
    version: 1,
    type: 'hello',
    providerId: 'provider-x',
    providerVersion: '1',
    facets: [],
    capabilities: { bigint: 12345678901234567890n, bytes: new Uint8Array([0, 1, 2, 254, 255]) },
  };
  assert.doesNotThrow(() => validateProviderPacket(packet));
});
