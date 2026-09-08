import assert from 'node:assert/strict';
import test from 'node:test';

import { createManagedTargetProfile, validateManagedTargetProfile } from '../../../js/managed/shared/profile.js';
import { createManagedValidationReport } from '../../../js/managed/shared/validation.js';
import { probeWasm } from '../../../js/managed/wasm/parser-core.js';
import { parseWasm } from '../../../js/managed/wasm/parser.js';

/* Managed shared identity batch (#5401, #5296, #5294, #5384): canonical
 * ids must bind the content they describe, and the public probe must not
 * claim support the open path cannot deliver. */

test('#5401 profiles differing in feature/policy/options carry distinct ids', () => {
  const a = createManagedTargetProfile({
    frontendId: 'wasm', formatVersion: '1', vmSpecEdition: 'core-3.0',
    featureSet: ['simd'], validationPolicy: 'strict', options: { enableReferenceTypes: false },
  });
  const b = createManagedTargetProfile({
    frontendId: 'wasm', formatVersion: '1', vmSpecEdition: 'core-3.0',
    featureSet: ['threads'], validationPolicy: 'permissive', options: { enableReferenceTypes: true },
  });
  assert.notEqual(a.id, b.id);
  assert.ok(a.id.startsWith('managed-profile:wasm:1:core-3.0:'), a.id);
  assert.ok(b.id.startsWith('managed-profile:wasm:1:core-3.0:'), b.id);
  assert.notEqual(a.decodingOptionsHash, b.decodingOptionsHash);
});

test('#5401 identical configuration reproduces the identical id', () => {
  const make = () => createManagedTargetProfile({
    frontendId: 'jvm', featureSet: ['a'], validationPolicy: 'strict',
  });
  assert.equal(make().id, make().id);
  // Feature order is normalized before hashing.
  assert.equal(
    createManagedTargetProfile({ frontendId: 'jvm', featureSet: ['a', 'b'] }).id,
    createManagedTargetProfile({ frontendId: 'jvm', featureSet: ['b', 'a'] }).id,
  );
});

test('#5296 the validator re-derives the id and rejects tampered or absent identity', () => {
  const profile = createManagedTargetProfile({ frontendId: 'cil' });
  assert.equal(validateManagedTargetProfile(profile), true);
  // A stale/descriptive id from a different configuration cannot validate.
  const tampered = { ...profile, id: 'managed-profile:cil:1:default' };
  assert.throws(() => validateManagedTargetProfile(tampered), /managed-profile-identity-mismatch/);
  // A semantically different feature set must not reuse another profile's id.
  const other = createManagedTargetProfile({ frontendId: 'cil', featureSet: ['x'] });
  assert.throws(() => validateManagedTargetProfile({ ...profile, featureSet: other.featureSet, id: profile.id }), /managed-profile-identity-mismatch/);
});

test('#5294 validation report ids separate profile and status denominators', () => {
  const a = createManagedValidationReport({ targetId: 'method:m', profileId: 'managed-profile:jvm:52:java-se-8', status: 'valid' });
  const b = createManagedValidationReport({ targetId: 'method:m', profileId: 'managed-profile:jvm:65:java-se-21', status: 'invalid', errors: [{ code: 'version-specific-validation-failed' }] });
  assert.notEqual(a.id, b.id);
  assert.ok(a.id.includes(a.profileId) && a.id.endsWith(':valid'), a.id);
  // Same target without a profile keeps a distinct, self-describing id.
  const c = createManagedValidationReport({ targetId: 'method:m', status: 'valid' });
  assert.notEqual(c.id, a.id);
  assert.ok(c.id.startsWith('val-rep:method:m:-:valid'), c.id);
});

test('#5384 the wasm probe refuses versions the open path rejects', () => {
  const v2 = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x02, 0x00, 0x00, 0x00]);
  const probe = probeWasm(v2);
  assert.equal(probe.supported, false);
  assert.equal(probe.reason, 'unsupported-version');
  const v1 = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
  assert.equal(probeWasm(v1).supported, true);
  // End-to-end: opening a non-v1 image still fails closed with the same reason.
  assert.throws(() => parseWasm(v2), /wasm-unsupported-version/);
});
