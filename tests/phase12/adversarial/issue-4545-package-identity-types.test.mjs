import assert from 'node:assert/strict';
import {
  createPackageArtifactDescriptor,
  createPackageEnvelope,
  validatePackageEnvelope,
} from '../../../js/phase12/package-envelope.js';

const base = {
  kind: 'knowledge',
  packageId: 'pkg-A',
  packageVersion: '1',
  dependencies: [{ packageId: 'dep-A', contentHash: 'abcd', packageVersion: '2' }],
  payload: { rules: [] },
};

const canonical = createPackageEnvelope(base);
assert.equal(canonical.kind, 'knowledge');
assert.equal(canonical.packageId, 'pkg-A');
assert.equal(canonical.packageVersion, '1');
assert.deepEqual(canonical.dependencies[0], { packageId: 'dep-A', contentHash: 'abcd', packageVersion: '2' });

for (const [field, value, code] of [
  ['kind', ['knowledge'], 'package-kind-required'],
  ['kind', { value: 'knowledge' }, 'package-kind-required'],
  ['packageId', ['pkg-A'], 'package-id-required'],
  ['packageId', 7, 'package-id-required'],
  ['packageVersion', ['1'], 'package-version-required'],
  ['packageVersion', true, 'package-version-required'],
]) {
  assert.throws(
    () => createPackageEnvelope({ ...base, [field]: value }),
    (error) => error?.code === code,
    `${field} must reject structured/non-string identity input`,
  );
}

for (const [field, value, code] of [
  ['packageId', ['dep-A'], 'package-dependency-id-required'],
  ['contentHash', ['abcd'], 'package-dependency-content-identity-required'],
  ['packageVersion', ['2'], 'package-dependency-version-required'],
  ['packageVersion', 2, 'package-dependency-version-required'],
]) {
  const dependency = { ...base.dependencies[0], [field]: value };
  assert.throws(
    () => createPackageEnvelope({ ...base, dependencies: [dependency] }),
    (error) => error?.code === code,
    `dependency ${field} must reject structured/non-string identity input`,
  );
}

for (const binaryId of [['bin-A'], { value: 'bin-A' }, 7, true]) {
  assert.throws(
    () => createPackageArtifactDescriptor(canonical, { binaryId }),
    (error) => error?.code === 'package-artifact-binary-id-required',
    'artifact binary identity must remain a primitive string',
  );
}

const forged = { ...canonical, packageId: ['pkg-A'] };
const checked = validatePackageEnvelope(forged);
assert.equal(checked.ok, false);
assert.equal(checked.code, 'package-id-required');
assert.equal(validatePackageEnvelope(canonical).ok, true, 'canonical primitive identity remains valid');

console.log('issue-4545 package identity type boundary regression: ok');
