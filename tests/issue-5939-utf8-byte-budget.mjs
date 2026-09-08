// Regression for #5939: the remote packet byte budget must mean the same
// UTF-8 byte length with or without TextEncoder. The previous
// TextEncoder-less fallback (`json.length * 2`) measured UTF-16 code units,
// which (a) rejected valid sub-1MiB ASCII packets (~2x overcount) and
// (b) accepted CJK packets whose real UTF-8 size exceeds 1 MiB (~0.67x
// undercount for 3-byte characters).
import assert from 'node:assert/strict';
import { validateRemotePacket } from '../js/debug/remote-protocol.js';
import { DEBUG_PROTOCOL_VERSION } from '../js/debug/adapter.js';

const hello = (payload) => ({ version: DEBUG_PROTOCOL_VERSION, type: 'hello', payload });

function withoutTextEncoder(run) {
  const saved = globalThis.TextEncoder;
  delete globalThis.TextEncoder;
  try { return run(); }
  finally { globalThis.TextEncoder = saved; }
}

// With TextEncoder (normal runtime): the boundary stays UTF-8-accurate.
assert.doesNotThrow(() => validateRemotePacket(hello('A'.repeat(600_000))), 'a ~600KB ASCII packet is valid on any runtime');
assert.throws(() => validateRemotePacket(hello('あ'.repeat(400_000))), (error) => error?.code === 'packet-too-large', 'a ~1.2MB CJK packet is oversized on any runtime');

// Without TextEncoder: identical semantics to the TextEncoder runtime.
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
  assert.throws(
    () => validateRemotePacket(hello('😀'.repeat(280_000))),
    (error) => error?.code === 'packet-too-large',
    'a 4-byte-per-character packet (~1.1MB) must be rejected when TextEncoder is absent',
  );
  assert.doesNotThrow(
    () => validateRemotePacket(hello('😀'.repeat(200_000))),
    'a ~800KB 4-byte packet stays within the budget; surrogate pairs are one code point',
  );
});

console.log('issue #5939 remote protocol UTF-8 byte budget: PASS');
