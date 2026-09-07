// Regression for #7127: validated provider output must be a detached immutable
// snapshot. deepFreeze alone cannot stop Map/Set/TypedArray internals from
// mutating afterwards, which allowed a post-validation maxBytes bypass.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { stableStringify } from '../js/core/identity/index.js';
import { validatePhase12ProviderResult } from '../js/phase12/provider-boundary.js';

const bytes = (value) => new TextEncoder().encode(stableStringify(value)).byteLength;

function rawWith(carrier) {
  return {
    schemaVersion: 'provider-v1',
    provenance: { source: 'external' },
    targetIdentity: 'target-1',
    completeness: 'complete',
    items: [{ id: 'entry-1', targetIdentity: 'target-1', value: carrier }],
  };
}

test('#7127 mutating the source Map after validation cannot inflate the result', () => {
  const carrier = new Map([['small', 'ok']]);
  const checked = validatePhase12ProviderResult(rawWith(carrier), { targetIdentity: 'target-1', maxBytes: 512 });
  assert.equal(checked.ok, true);
  const before = bytes(checked.value);
  carrier.set('inflated', 'x'.repeat(1_000_000));
  assert.equal(bytes(checked.value), before, 'the validated snapshot must be detached from the source Map');
  assert.ok(before <= 512 + 256, 'validated size stays inside the budget');
});

test('#7127 the detached snapshot itself rejects mutation attempts', () => {
  const carrier = new Map([['small', 'ok']]);
  const checked = validatePhase12ProviderResult(rawWith(carrier), { targetIdentity: 'target-1', maxBytes: 512 });
  assert.throws(() => { checked.value.items[0].id = 'forged'; }, TypeError);
  // The Map facade cannot be frozen, but the exposed copy is detached: mutating
  // it must not flow anywhere.
  const exposedMap = checked.value.items[0].value;
  assert.equal(exposedMap instanceof Map, true);
  exposedMap.set('post-validation', true);
  assert.equal(carrier.has('post-validation'), false);
});

test('#7127 typed-array payloads are detached too', () => {
  const payload = new Uint8Array([1, 2, 3]);
  const checked = validatePhase12ProviderResult(rawWith(payload), { targetIdentity: 'target-1', maxBytes: 512 });
  assert.equal(checked.ok, true);
  const exposed = checked.value.items[0].value;
  exposed[0] = 99;
  assert.equal(payload[0], 1);
});
