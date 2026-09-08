// Regression for #5939: the remote packet byte budget must mean the same
// UTF-8 byte length with or without TextEncoder. The previous
// TextEncoder-less fallback (`json.length * 2`) measured UTF-16 code units,
// which (a) rejected valid sub-1MiB ASCII packets (~2x overcount) and
// (b) accepted CJK packets whose real UTF-8 size exceeds 1 MiB (~0.67x
// undercount for 3-byte characters).
import assert from 'node:assert/strict';
import { RemoteProtocolClient, validateRemotePacket } from '../js/debug/remote-protocol.js';
import { DEBUG_PROTOCOL_VERSION } from '../js/debug/adapter.js';

const LIMIT = 1024 * 1024;
const hello = (payload) => ({ version: DEBUG_PROTOCOL_VERSION, type: 'hello', payload });

function withoutGlobals(names, run) {
  const descriptors = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of names) delete globalThis[name];
  try { return run(); }
  finally {
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
}

const withoutTextEncoder = (run) => withoutGlobals(['TextEncoder'], run);
const withoutUtf8Helpers = (run) => withoutGlobals(['TextEncoder', 'Buffer'], run);
const packetBytes = (packet) => new TextEncoder().encode(JSON.stringify(packet)).byteLength;

// With TextEncoder (normal runtime): the boundary stays UTF-8-accurate.
assert.doesNotThrow(() => validateRemotePacket(hello('A'.repeat(600_000))), 'a ~600KB ASCII packet is valid on any runtime');
assert.throws(() => validateRemotePacket(hello('あ'.repeat(400_000))), (error) => error?.code === 'packet-too-large', 'a ~1.2MB CJK packet is oversized on any runtime');

// Without TextEncoder (Node Buffer fallback): identical semantics.
withoutTextEncoder(() => {
  assert.doesNotThrow(
    () => validateRemotePacket(hello('A'.repeat(600_000))),
    'a ~600KB ASCII packet must not be falsely rejected when TextEncoder is absent',
  );
  assert.doesNotThrow(
    () => validateRemotePacket(hello('あ'.repeat(300_000))),
    'a ~900KB CJK packet stays within the UTF-8 budget without TextEncoder',
  );
  assert.throws(
    () => validateRemotePacket(hello('あ'.repeat(400_000))),
    (error) => error?.code === 'packet-too-large',
    'a ~1.2MB CJK packet must be rejected when TextEncoder is absent',
  );
});

// Browser-style fallback: no TextEncoder and no Buffer. Exercise the manual
// code-point scanner directly for 3-byte and 4-byte characters.
withoutUtf8Helpers(() => {
  assert.doesNotThrow(() => validateRemotePacket(hello('あ'.repeat(300_000))));
  assert.throws(
    () => validateRemotePacket(hello('あ'.repeat(400_000))),
    (error) => error?.code === 'packet-too-large',
  );
  assert.doesNotThrow(
    () => validateRemotePacket(hello('😀'.repeat(200_000))),
    'a ~800KB 4-byte packet stays within the budget; surrogate pairs are one code point',
  );
  assert.throws(
    () => validateRemotePacket(hello('😀'.repeat(280_000))),
    (error) => error?.code === 'packet-too-large',
    'a ~1.1MB 4-byte packet must be rejected by the manual fallback',
  );
});

// Pin the security boundary itself: exactly 1 MiB is admitted, +1 byte is not.
// The JSON envelope is ASCII, so replacing its empty payload adds one byte per A.
{
  const emptyBytes = packetBytes(hello(''));
  const exact = hello('A'.repeat(LIMIT - emptyBytes));
  const over = hello('A'.repeat(LIMIT - emptyBytes + 1));
  assert.equal(packetBytes(exact), LIMIT);
  assert.equal(packetBytes(over), LIMIT + 1);
  withoutUtf8Helpers(() => {
    assert.doesNotThrow(() => validateRemotePacket(exact), 'exactly 1 MiB must be accepted');
    assert.throws(
      () => validateRemotePacket(over),
      (error) => error?.code === 'packet-too-large',
      '1 MiB + 1 byte must fail closed',
    );
  });
}

// Well-formed JSON.stringify escapes lone surrogates. Even so, pin that the
// resulting wire bytes have identical acceptance without either UTF-8 helper.
{
  const under = hello('\ud800'.repeat(170_000));
  const over = hello('\ud800'.repeat(175_000));
  assert.ok(packetBytes(under) < LIMIT);
  assert.ok(packetBytes(over) > LIMIT);
  withoutUtf8Helpers(() => {
    assert.doesNotThrow(() => validateRemotePacket(under), 'lone-surrogate JSON below the wire budget is valid');
    assert.throws(
      () => validateRemotePacket(over),
      (error) => error?.code === 'packet-too-large',
      'lone-surrogate JSON above the wire budget must be rejected',
    );
  });
}

// Event-rate accounting uses the same exact byte authority. With a 1 KiB
// window, one ~1.2 KiB CJK event must be dropped immediately in the manual
// browser fallback; the old UTF-16 approximation (~0.8 KiB) admitted it.
withoutUtf8Helpers(() => {
  const client = new RemoteProtocolClient(
    { send: async () => {} },
    { maxEventBytesPerSecond: 1024, monotonicNow: () => 0 },
  );
  const event = {
    version: DEBUG_PROTOCOL_VERSION,
    type: 'event',
    epoch: 0,
    event: 'output',
    data: 'あ'.repeat(400),
  };
  assert.equal(client.receive(event), false, 'oversized event-byte window must reject on the first event');
  assert.equal(client.droppedEvents, 1);
  client.close();
});

console.log('issue #5939 remote protocol UTF-8 byte budget: PASS');
