import assert from 'node:assert/strict';
import test from 'node:test';

import { openManagedImage, probeManagedFrontend } from '../../../js/managed/index.js';
import { createManagedTargetProfileId } from '../../../js/managed/shared/identity.js';
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

test('#5401 each semantic profile denominator independently changes identity', () => {
  const input = {
    frontendId: 'wasm',
    frontendSemanticVersion: '1.0.0',
    featureSet: ['simd'],
    validationPolicy: 'strict',
    options: { enableReferenceTypes: false },
  };
  const base = createManagedTargetProfile(input);
  for (const [label, override] of [
    ['options', { options: { enableReferenceTypes: true } }],
    ['featureSet', { featureSet: ['threads'] }],
    ['validationPolicy', { validationPolicy: 'permissive' }],
    ['frontendSemanticVersion', { frontendSemanticVersion: '1.0.1' }],
  ]) {
    const changed = createManagedTargetProfile({ ...input, ...override });
    assert.notEqual(changed.id, base.id, `${label} must participate in profile identity`);
  }
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
  // A canonical-looking legacy id must not let an under-specified object
  // borrow constructor defaults and validate as a complete profile.
  assert.throws(
    () => validateManagedTargetProfile({ frontendId: 'wasm', id: 'managed-profile:wasm:1:default' }),
    /managed-profile-invalid-version/,
  );
  // A stale/descriptive id from a different configuration cannot validate.
  const tampered = { ...profile, id: 'managed-profile:cil:1:default' };
  assert.throws(() => validateManagedTargetProfile(tampered), /managed-profile-identity-mismatch/);
  // A semantically different feature set must not reuse another profile's id.
  const other = createManagedTargetProfile({ frontendId: 'cil', featureSet: ['x'] });
  assert.throws(() => validateManagedTargetProfile({ ...profile, featureSet: other.featureSet, id: profile.id }), /managed-profile-identity-mismatch/);

  const withSelfConsistentId = (candidate) => ({
    ...candidate,
    id: createManagedTargetProfileId(
      candidate.frontendId,
      candidate.formatVersion,
      candidate.vmSpecEdition,
      {
        frontendSemanticVersion: candidate.frontendSemanticVersion,
        featureSet: candidate.featureSet,
        runtimeVersionHint: candidate.runtimeVersionHint ?? null,
        validationPolicy: candidate.validationPolicy,
        decodingOptionsHash: candidate.decodingOptionsHash,
      },
    ),
  });

  // A caller cannot make a constructor-impossible options hash valid merely
  // by rebinding the public id builder to the same malformed value.
  const malformedHash = withSelfConsistentId({
    ...profile,
    decodingOptionsHash: 'not-a-canonical-digest',
  });
  assert.throws(() => validateManagedTargetProfile(malformedHash), /managed-profile-invalid-options-hash/);

  // Constructor-normalized scalar fields must already be canonical at the
  // validation boundary, even when the supplied id is self-consistent.
  const canonical = createManagedTargetProfile({ frontendId: 'cil', runtimeVersionHint: 'v1' });
  for (const [field, code] of [
    ['frontendSemanticVersion', 'managed-profile-invalid-version'],
    ['formatVersion', 'managed-profile-invalid-format-version'],
    ['vmSpecEdition', 'managed-profile-invalid-spec-edition'],
    ['runtimeVersionHint', 'managed-profile-runtime-version-hint-invalid'],
    ['validationPolicy', 'managed-profile-invalid-validation-policy'],
  ]) {
    const forged = withSelfConsistentId({ ...canonical, [field]: ` ${canonical[field]} ` });
    assert.throws(() => validateManagedTargetProfile(forged), new RegExp(code), field);
  }
});

test('#5294 validation report ids use an injective typed identity tuple', () => {
  const a = createManagedValidationReport({ targetId: 'method:m', profileId: 'managed-profile:jvm:52:java-se-8', status: 'valid' });
  const b = createManagedValidationReport({ targetId: 'method:m', profileId: 'managed-profile:jvm:65:java-se-21', status: 'invalid', errors: [{ code: 'version-specific-validation-failed' }] });
  assert.notEqual(a.id, b.id);
  assert.match(a.id, /^val-rep:[0-9a-f]{32}$/);

  // Null is a typed tuple member, never a string sentinel.
  const noProfile = createManagedValidationReport({ targetId: 'method:m', status: 'valid' });
  const dashProfile = createManagedValidationReport({ targetId: 'method:m', profileId: '-', status: 'valid' });
  assert.notEqual(noProfile.id, dashProfile.id, 'null profileId must not alias the literal "-" profile id');

  // Raw delimiter joining used to collapse these two distinct field tuples:
  // `method:m:a` + `b` and `method:m` + `a:b` both rendered `...:a:b:valid`.
  const delimiterLeft = createManagedValidationReport({ targetId: 'method:m:a', profileId: 'b', status: 'valid' });
  const delimiterRight = createManagedValidationReport({ targetId: 'method:m', profileId: 'a:b', status: 'valid' });
  assert.notEqual(delimiterLeft.id, delimiterRight.id, '":" inside identity fields must not move tuple boundaries');

  // The canonical tuple remains deterministic for identical validation facts.
  const repeat = createManagedValidationReport({ targetId: 'method:m', profileId: 'managed-profile:jvm:52:java-se-8', status: 'valid' });
  assert.equal(repeat.id, a.id);
});

test('#5384 the public managed probe/open path agrees with wasm support', async () => {
  const v2 = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x02, 0x00, 0x00, 0x00]);
  const probe = probeWasm(v2);
  assert.equal(probe.supported, false);
  assert.equal(probe.reason, 'unsupported-version');

  // Public routing must not turn an unsupported WASM version into an
  // openable managed frontend.
  const publicProbe = await probeManagedFrontend(v2);
  assert.equal(publicProbe.supported, false);
  assert.equal(publicProbe.frontendId, null);
  await assert.rejects(() => openManagedImage(v2), /managed-image-unsupported-format/);

  // The direct WASM parser keeps its format-specific fail-closed reason.
  assert.throws(() => parseWasm(v2), /wasm-unsupported-version/);

  const v1 = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
  assert.equal(probeWasm(v1).supported, true);
  const publicV1 = await probeManagedFrontend(v1);
  assert.equal(publicV1.supported, true);
  assert.equal(publicV1.frontendId, 'wasm');

  // Invalid magic remains rejected by the public router.
  const invalidMagic = new Uint8Array(8);
  const invalidProbe = await probeManagedFrontend(invalidMagic);
  assert.equal(invalidProbe.supported, false);
  assert.equal(invalidProbe.frontendId, null);

  // Other managed frontend routing is unchanged: a supported DEX magic/version
  // still routes to DEX rather than being shadowed by the WASM change.
  const dex = new Uint8Array(40);
  dex.set([0x64, 0x65, 0x78, 0x0a, 0x30, 0x33, 0x35, 0x00]);
  const dexProbe = await probeManagedFrontend(dex);
  assert.equal(dexProbe.supported, true);
  assert.equal(dexProbe.frontendId, 'dex');
});
