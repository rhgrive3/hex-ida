import assert from 'node:assert/strict';
import test from 'node:test';

import {
  hasProvenRuntimeStaticIdentity,
  normalizeRuntimeModuleBinding,
} from '../../../js/runtime/module-binding.js';

function module(overrides = {}) {
  return {
    bindingKey: 'main',
    runtimeBase: 0x1000n,
    runtimeSize: 0x100n,
    staticBase: 0x4000n,
    binaryId: 'bin_A',
    identityState: 'exact',
    ...overrides,
  };
}

for (const binaryId of [['bin_A'], { id: 'bin_A' }, 7, true, '', '   ']) {
  test(`P10 #4553 rejects malformed binary identity ${typeof binaryId}`, () => {
    const input = module({ binaryId });
    assert.equal(hasProvenRuntimeStaticIdentity(input), false);
    const binding = normalizeRuntimeModuleBinding(input);
    assert.equal(binding.identityState, 'unresolved');
    assert.equal(binding.binaryId, null);
    assert.equal(binding.sliceId, null);
    assert.equal(binding.imageId, null);
  });
}

for (const [field, value] of [
  ['sliceId', ['slice_A']],
  ['sliceId', { id: 'slice_A' }],
  ['sliceId', 1],
  ['sliceId', '   '],
  ['imageId', ['image_A']],
  ['imageId', { id: 'image_A' }],
  ['imageId', false],
  ['imageId', ''],
]) {
  test(`P10 #4553 malformed optional ${field} cannot retain static authority`, () => {
    const input = module({ [field]: value });
    assert.equal(hasProvenRuntimeStaticIdentity(input), false);
    const binding = normalizeRuntimeModuleBinding(input);
    assert.equal(binding.identityState, 'unresolved');
    assert.equal(binding.binaryId, null);
    assert.equal(binding.sliceId, null);
    assert.equal(binding.imageId, null);
  });
}

test('P10 #4553 canonical exact/resolved identities retain authority', () => {
  for (const identityState of ['exact', 'resolved']) {
    const input = module({
      identityState,
      sliceId: 'slice_A',
      imageId: 'image_A',
    });
    assert.equal(hasProvenRuntimeStaticIdentity(input), true);
    const binding = normalizeRuntimeModuleBinding(input);
    assert.equal(binding.identityState, identityState);
    assert.equal(binding.binaryId, 'bin_A');
    assert.equal(binding.sliceId, 'slice_A');
    assert.equal(binding.imageId, 'image_A');
  }
});

test('P10 #4553 canonical identity evidence still proves a canonical binary identity', () => {
  const input = module({
    identityState: undefined,
    identityEvidenceIds: ['ev:module:1'],
  });
  assert.equal(hasProvenRuntimeStaticIdentity(input), true);
  const binding = normalizeRuntimeModuleBinding(input);
  assert.equal(binding.identityState, 'resolved');
  assert.equal(binding.binaryId, 'bin_A');
  assert.deepEqual(binding.identityEvidenceIds, ['ev:module:1']);
});

test('P10 #4553 unresolved canonical IDs remain fail closed without proof', () => {
  const input = module({ identityState: 'unresolved' });
  assert.equal(hasProvenRuntimeStaticIdentity(input), false);
  const binding = normalizeRuntimeModuleBinding(input);
  assert.equal(binding.identityState, 'unresolved');
  assert.equal(binding.binaryId, null);
});

test('P10 #4553 does not invoke identity coercion hooks', () => {
  let coercions = 0;
  const hostile = {
    toString() { coercions += 1; return 'bin_A'; },
    valueOf() { coercions += 1; return 'bin_A'; },
  };
  assert.equal(hasProvenRuntimeStaticIdentity(module({ binaryId: hostile })), false);
  normalizeRuntimeModuleBinding(module({ binaryId: hostile }));
  assert.equal(coercions, 0);
});

for (const [field, drifts] of [
  ['binaryId', ['bin_A', ['bin_A']]],
  ['binaryId', ['bin_A', { id: 'bin_A' }]],
  ['sliceId', ['slice_A', ['slice_A']]],
  ['imageId', ['image_A', { id: 'image_A' }]],
]) {
  test(`P10 #4553 stateful ${field} getter drift cannot retain trusted authority`, () => {
    let reads = 0;
    const input = {
      ...module({ identityState: 'exact' }),
      get [field]() { return drifts[Math.min(reads++, drifts.length - 1)]; },
    };
    assert.equal(hasProvenRuntimeStaticIdentity(input), true);
    const binding = normalizeRuntimeModuleBinding(input);
    assert.equal(binding.identityState, 'unresolved');
    assert.equal(binding.binaryId, null);
    assert.equal(binding.sliceId, null);
    assert.equal(binding.imageId, null);
  });
}

test('P10 #4553 validation and publication observe one consistent identity snapshot', () => {
  let binaryIdReads = 0;
  let sliceIdReads = 0;
  const input = {
    ...module({ identityState: 'exact', imageId: 'image_A' }),
    get binaryId() { binaryIdReads += 1; return 'bin_A'; },
    get sliceId() { sliceIdReads += 1; return 'slice_A'; },
  };
  const binding = normalizeRuntimeModuleBinding(input);
  assert.equal(binding.identityState, 'exact');
  assert.equal(binding.binaryId, 'bin_A');
  assert.equal(binding.sliceId, 'slice_A');
  assert.equal(binding.imageId, 'image_A');
  assert.equal(binaryIdReads, 1);
  assert.equal(sliceIdReads, 1);
});
