import assert from 'node:assert/strict';
import {
  MANAGED_FRONTEND_IDS,
  createManagedTargetProfile,
  validateManagedTargetProfile,
} from '../../../js/managed/shared/profile.js';

console.log('[phase11] running managed profile scalar boundary regression for #4485...');

const validInput = {
  frontendId: 'WASM',
  frontendSemanticVersion: '1.0.0',
  formatVersion: '1',
  vmSpecEdition: 'core-3.0',
  featureSet: ['simd', 'multi-memory'],
  runtimeVersionHint: 'runtime-1',
  validationPolicy: 'strict',
  options: { allowExperimental: false },
};
const profile = createManagedTargetProfile(validInput);
assert.equal(profile.frontendId, 'wasm');
assert.equal(profile.id, 'managed-profile:wasm:1:core-3.0');
assert.deepEqual(profile.featureSet, ['multi-memory', 'simd']);
assert.equal(validateManagedTargetProfile(profile), true);

for (const frontendId of [['wasm'], { value: 'wasm' }, true, 1]) {
  assert.throws(
    () => createManagedTargetProfile({ frontendId }),
    /managed-profile-frontend-id-required/,
    `structured frontendId must be rejected: ${JSON.stringify(frontendId)}`,
  );
}

for (const field of ['frontendSemanticVersion', 'validationPolicy']) {
  for (const value of [['1.0.0'], { value: '1.0.0' }, true, 1]) {
    assert.throws(
      () => createManagedTargetProfile({ frontendId: 'wasm', [field]: value }),
      field === 'frontendSemanticVersion'
        ? /managed-profile-version-required/
        : /managed-profile-validation-policy-required/,
      `structured ${field} must be rejected: ${JSON.stringify(value)}`,
    );
  }
}

for (const field of ['formatVersion', 'vmSpecEdition']) {
  for (const value of [['1'], { value: '1' }, true, -1, 1.5]) {
    assert.throws(
      () => createManagedTargetProfile({ frontendId: 'wasm', [field]: value }),
      field === 'formatVersion'
        ? /managed-profile-format-version-required/
        : /managed-profile-spec-edition-required/,
      `structured ${field} must be rejected: ${JSON.stringify(value)}`,
    );
  }
}
assert.equal(createManagedTargetProfile({ frontendId: 'wasm', formatVersion: 7, vmSpecEdition: 3 }).id, 'managed-profile:wasm:7:3');

for (const value of [['runtime-1'], { value: 'runtime-1' }, true, 1, '']) {
  assert.throws(
    () => createManagedTargetProfile({ frontendId: 'wasm', runtimeVersionHint: value }),
    /managed-profile-runtime-version-hint-invalid/,
    `structured runtimeVersionHint must be rejected: ${JSON.stringify(value)}`,
  );
}

for (const value of [['simd'], { value: 'simd' }, true, 1]) {
  assert.throws(
    () => createManagedTargetProfile({ frontendId: 'wasm', featureSet: [value] }),
    /managed-profile-invalid-feature/,
    `structured featureSet entry must be rejected: ${JSON.stringify(value)}`,
  );
}
assert.throws(() => createManagedTargetProfile({ frontendId: 'wasm', featureSet: { value: 'simd' } }), /managed-profile-invalid-feature-set/);

for (const frontendId of MANAGED_FRONTEND_IDS) {
  const frontendProfile = createManagedTargetProfile({ frontendId });
  assert.equal(frontendProfile.frontendId, frontendId);
  assert.equal(validateManagedTargetProfile(frontendProfile), true);
}

const malformedProfiles = [
  { id: 'managed-profile:wasm:1:default', frontendId: ['wasm'] },
  { id: 'managed-profile:wasm:1:default', frontendId: 'wasm', frontendSemanticVersion: ['1.0.0'] },
  { id: 'managed-profile:wasm:1:default', frontendId: 'wasm', formatVersion: { value: '1' } },
  { id: 'managed-profile:wasm:1:default', frontendId: 'wasm', vmSpecEdition: ['default'] },
  { id: 'managed-profile:wasm:1:default', frontendId: 'wasm', featureSet: [['simd']] },
  { id: 'managed-profile:wasm:1:default', frontendId: 'wasm', runtimeVersionHint: { value: 'runtime-1' } },
  { id: 'managed-profile:wasm:1:default', frontendId: 'wasm', validationPolicy: ['strict'] },
];
for (const malformedProfile of malformedProfiles) {
  assert.throws(
    () => validateManagedTargetProfile(malformedProfile),
    TypeError,
    `malformed profile must not validate: ${JSON.stringify(malformedProfile)}`,
  );
}

console.log('  ok #4485 managed profile scalar boundary regression passed');
