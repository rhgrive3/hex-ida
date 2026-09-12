import assert from 'node:assert/strict';
import {
  createVMEffectBundle,
  createVMEffectFunction,
  validateVMEffectFunction,
} from '../../../js/managed/shared/vm-effects.js';
import { lowerVMEffectsToSemanticIr } from '../../../js/managed/shared/bridge-v2.js';

function bundle({
  methodId = 'method:A',
  frontendId = 'wasm',
  profileId = '2024',
  operationId = 'op:A:0',
} = {}) {
  return createVMEffectBundle({
    frontendId,
    profileId,
    methodId,
    operationId,
    bytecodeOffset: 0,
    mnemonic: 'nop',
    completeness: 'exact',
  });
}

// 1. A function may not adopt effects owned by another method.
assert.throws(
  () => createVMEffectFunction({
    frontendId: 'wasm',
    profileId: '2024',
    methodId: 'method:A',
    bundles: [bundle({ methodId: 'method:B', operationId: 'op:B:0' })],
  }),
  /vm-effect-function-bundle-method-mismatch/,
);

// 2. A function may not adopt effects produced under another frontend.
assert.throws(
  () => createVMEffectFunction({
    frontendId: 'jvm',
    profileId: '2024',
    methodId: 'method:A',
    bundles: [bundle({ frontendId: 'wasm' })],
  }),
  /vm-effect-function-bundle-frontend-mismatch/,
);

// 3. Shared profile identity is part of ownership when both sides publish it.
assert.throws(
  () => createVMEffectFunction({
    frontendId: 'wasm',
    profileId: '2024',
    methodId: 'method:A',
    bundles: [bundle({ profileId: '2025' })],
  }),
  /vm-effect-function-bundle-profile-mismatch/,
);

// 4. Exact parent/child ownership remains valid.
const canonical = createVMEffectFunction({
  frontendId: 'wasm',
  profileId: '2024',
  methodId: 'method:A',
  bundles: [bundle()],
});
assert.equal(validateVMEffectFunction(canonical), true);

// 5. Public validation must reject a persisted/tampered child method identity.
assert.throws(
  () => validateVMEffectFunction({
    ...canonical,
    bundles: [{ ...canonical.bundles[0], methodId: 'method:B' }],
  }),
  /vm-effect-function-bundle-method-mismatch/,
);

// 6. Public validation must reject a persisted/tampered child frontend identity.
assert.throws(
  () => validateVMEffectFunction({
    ...canonical,
    bundles: [{ ...canonical.bundles[0], frontendId: 'jvm' }],
  }),
  /vm-effect-function-bundle-frontend-mismatch/,
);

// 7. Public validation must reject a persisted/tampered shared profile identity.
assert.throws(
  () => validateVMEffectFunction({
    ...canonical,
    bundles: [{ ...canonical.bundles[0], profileId: '2025' }],
  }),
  /vm-effect-function-bundle-profile-mismatch/,
);

// 8. The public bridge must not publish effects from a tampered foreign bundle.
const foreignPersisted = {
  ...canonical,
  bundles: [{ ...canonical.bundles[0], methodId: 'method:B' }],
};
assert.throws(
  () => lowerVMEffectsToSemanticIr(foreignPersisted),
  /vm-effect-function-bundle-method-mismatch/,
);

console.log('issue-4835 vm-effect function/bundle ownership: ok');
