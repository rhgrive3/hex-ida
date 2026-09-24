import assert from 'node:assert/strict';
import test from 'node:test';

import { fnv64Text, fnv64TextPair } from '../js/core/identity/fnv64.js';
import { stableDigest, stableStringify } from '../js/core/identity/index.js';

const SECOND_LOW = 0xcbf29ce4;
const SECOND_HIGH = 0x84222325;

test('dual FNV text pass is byte-identical to the historical two-pass digest', () => {
  const samples = [
    '',
    'ascii',
    '日本語🔥',
    '\u0000\u0001\ud800\udfff',
    'x'.repeat(1024 * 1024),
  ];
  for (const text of samples) {
    assert.equal(
      fnv64TextPair(text),
      fnv64Text(text) + fnv64Text(text, SECOND_LOW, SECOND_HIGH),
    );
  }
});

test('stableDigest retains its historical canonical text digest', () => {
  const shared = { z: 3, a: [1, 2, 3], big: 12345678901234567890n };
  const value = {
    string: 'identity',
    number: -0,
    nested: shared,
    map: new Map([['b', 2], ['a', 1]]),
    set: new Set(['z', 'a']),
  };
  const text = stableStringify(value);
  const historical = fnv64Text(text) + fnv64Text(text, SECOND_LOW, SECOND_HIGH);
  assert.equal(stableDigest(value), historical);
});
