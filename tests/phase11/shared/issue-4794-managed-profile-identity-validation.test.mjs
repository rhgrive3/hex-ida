import assert from 'node:assert/strict';
import test from 'node:test';

import { createManagedTargetProfileId } from '../../../js/managed/shared/identity.js';
import { createManagedTargetProfile, validateManagedTargetProfile } from '../../../js/managed/shared/profile.js';

// #4794 — validateManagedTargetProfile must re-derive the creator's canonical
// identity over the full published content instead of only checking that
// `frontendId` is supported and `id` is a string, so a profile whose id does
// not match its content (forged frontendId/formatVersion/vmSpecEdition or an
// arbitrary id) fails closed.

const rederive = (p) => createManagedTargetProfileId(
  p.frontendId,
  p.formatVersion,
  p.vmSpecEdition,
  {
    frontendSemanticVersion: p.frontendSemanticVersion,
    featureSet: p.featureSet,
    runtimeVersionHint: p.runtimeVersionHint ?? null,
    validationPolicy: p.validationPolicy,
    decodingOptionsHash: p.decodingOptionsHash,
  },
);

test('#4794 a profile produced by the creator validates', () => {
  const profile = createManagedTargetProfile({
    frontendId: 'wasm',
    formatVersion: '1',
    vmSpecEdition: '2024',
  });
  assert.equal(validateManagedTargetProfile(profile), true);
});

test('#4794 swapping only frontendId under a stale id is rejected', () => {
  const profile = createManagedTargetProfile({
    frontendId: 'wasm',
    formatVersion: '1',
    vmSpecEdition: '2024',
  });
  assert.throws(() => validateManagedTargetProfile({ ...profile, frontendId: 'dex' }), TypeError);
});

test('#4794 swapping only formatVersion or vmSpecEdition under a stale id is rejected', () => {
  const profile = createManagedTargetProfile({
    frontendId: 'wasm',
    formatVersion: '1',
    vmSpecEdition: '2024',
  });
  assert.throws(() => validateManagedTargetProfile({ ...profile, formatVersion: '2' }), TypeError);
  assert.throws(() => validateManagedTargetProfile({ ...profile, vmSpecEdition: '2025' }), TypeError);
});

test('#4794 a minimal object with an arbitrary id is rejected', () => {
  assert.throws(() => validateManagedTargetProfile({
    frontendId: 'wasm',
    id: 'totally-unrelated-id',
  }), TypeError);
});

test('#4794 a content-changed profile with a correctly re-derived canonical id is accepted', () => {
  const profile = createManagedTargetProfile({
    frontendId: 'wasm',
    formatVersion: '1',
    vmSpecEdition: '2024',
  });
  const tampered = { ...profile, formatVersion: '2' };
  assert.equal(validateManagedTargetProfile({ ...tampered, id: rederive(tampered) }), true);
});
