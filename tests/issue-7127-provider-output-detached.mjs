// Regression for #7127: validated provider output must be a detached snapshot.
// Uncloneable values fail closed instead of retaining provider-owned mutable
// Map/Set/typed/buffer references past the validation boundary.
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

function checkedValue(carrier) {
  const checked = validatePhase12ProviderResult(rawWith(carrier), { targetIdentity: 'target-1', maxBytes: 512 });
  assert.equal(checked.ok, true);
  return checked.value.items[0].value;
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

test('#7127 the detached snapshot itself rejects plain-object mutation and does not alias Map state', () => {
  const carrier = new Map([['small', 'ok']]);
  const checked = validatePhase12ProviderResult(rawWith(carrier), { targetIdentity: 'target-1', maxBytes: 512 });
  assert.equal(checked.ok, true);
  assert.throws(() => { checked.value.items[0].id = 'forged'; }, TypeError);
  const exposedMap = checked.value.items[0].value;
  assert.equal(exposedMap instanceof Map, true);
  exposedMap.set('post-validation', true);
  assert.equal(carrier.has('post-validation'), false);
});

test('#7127 typed-array payloads are detached too', () => {
  const payload = new Uint8Array([1, 2, 3]);
  const exposed = checkedValue(payload);
  exposed[0] = 99;
  assert.equal(payload[0], 1);
});

test('#7127 Set and Date payloads are detached', () => {
  const sourceSet = new Set(['a']);
  const exposedSet = checkedValue(sourceSet);
  exposedSet.add('b');
  assert.equal(sourceSet.has('b'), false);

  const sourceDate = new Date('2026-09-08T00:00:00Z');
  const exposedDate = checkedValue(sourceDate);
  exposedDate.setUTCFullYear(2030);
  assert.equal(sourceDate.getUTCFullYear(), 2026);
});

test('#7127 DataView and ArrayBuffer payloads are detached', () => {
  const sourceViewBuffer = new ArrayBuffer(4);
  const sourceView = new DataView(sourceViewBuffer);
  sourceView.setUint8(0, 7);
  const exposedView = checkedValue(sourceView);
  exposedView.setUint8(0, 99);
  assert.equal(sourceView.getUint8(0), 7);

  const sourceBuffer = new Uint8Array([1, 2, 3]).buffer;
  const exposedBuffer = checkedValue(sourceBuffer);
  new Uint8Array(exposedBuffer)[0] = 88;
  assert.equal(new Uint8Array(sourceBuffer)[0], 1);
});

for (const [name, mutable] of [
  ['Map', new Map([['small', 'ok']])],
  ['TypedArray', new Uint8Array([1, 2, 3])],
]) {
  test(`#7127 function+${name} payload fails closed when structuredClone cannot detach it`, () => {
    const checked = validatePhase12ProviderResult(rawWith({ fn() {}, mutable }), { targetIdentity: 'target-1', maxBytes: 512 });
    assert.equal(checked.ok, false);
    assert.equal(checked.code, 'provider-output-unclonable');
  });
}