import assert from 'node:assert/strict';
import {
  PackageValidationError,
  createPackageEnvelope,
  resolvePackageDependencies,
} from '../../../js/phase12/package-envelope.js';

// #3838: resolvePackageDependencies() compared the AVAILABLE dependency's
// packageVersion through String(), so a structured / schema-invalid version
// ('1' from ['1'], 1, {version:'1'}, true) was accepted as the exact pin of a
// required primitive string version. The resolver is the provenance/compat
// authority boundary for knowledge and rule packages: once a malformed
// available identity passes, the caller cannot distinguish it from a real pin.

const parent = createPackageEnvelope({
  kind: 'mixed',
  packageId: 'parent',
  packageVersion: '1',
  dependencies: [{ packageId: 'dep', contentHash: 'abcd', packageVersion: '1' }],
  payload: {},
});

function isDependencyContractError(error) {
  return error instanceof PackageValidationError && /^package-dependency-/.test(error.code);
}

// 1. structured version must not be promoted to the required pin by String().
assert.throws(
  () => resolvePackageDependencies(parent, [{ packageId: 'dep', contentHash: 'abcd', packageVersion: ['1'] }]),
  isDependencyContractError,
  'array packageVersion must not satisfy an exact string pin',
);

// 2. number / object / boolean versions are equally non-canonical.
for (const packageVersion of [1, 1.0, { toString: () => '1', version: '1' }, true, null, undefined, '']) {
  assert.throws(
    () => resolvePackageDependencies(parent, [{ packageId: 'dep', contentHash: 'abcd', packageVersion }]),
    isDependencyContractError,
    `non-string packageVersion ${JSON.stringify(packageVersion) ?? 'undefined'} must be rejected`,
  );
}

// 3. whitespace-only versions are not identity, and a different canonical
//    string version is still not the required pin.
assert.throws(
  () => resolvePackageDependencies(parent, [{ packageId: 'dep', contentHash: 'abcd', packageVersion: '   ' }]),
  isDependencyContractError,
  'whitespace-only packageVersion must be rejected',
);
assert.throws(
  () => resolvePackageDependencies(parent, [{ packageId: 'dep', contentHash: 'abcd', packageVersion: '2' }]),
  /not resolved to its exact identity/,
  'a different canonical string version must not resolve the pin',
);

// 4. canonical string exact matching keeps working.
const resolved = resolvePackageDependencies(parent, [{ packageId: 'dep', contentHash: 'abcd', packageVersion: '1' }]);
assert.equal(resolved.length, 1);
assert.deepEqual(
  { packageId: resolved[0].packageId, contentHash: resolved[0].contentHash, packageVersion: resolved[0].packageVersion },
  { packageId: 'dep', contentHash: 'abcd', packageVersion: '1' },
);
assert.ok(Object.isFrozen(resolved[0]), 'resolved dependency identity stays frozen');
assert.ok(Object.isFrozen(resolved), 'resolved dependency list stays frozen');

// 5. real envelopes still resolve through the same canonical contract.
const dep = createPackageEnvelope({ kind: 'knowledge', packageId: 'dep-real', packageVersion: '2', payload: { rules: [] } });
const parentReal = createPackageEnvelope({
  kind: 'mixed',
  packageId: 'parent-real',
  packageVersion: '1',
  dependencies: [{ packageId: dep.packageId, contentHash: dep.contentHash, packageVersion: dep.packageVersion }],
  payload: {},
});
assert.equal(resolvePackageDependencies(parentReal, [dep])[0].contentHash, dep.contentHash);

// 6. contentHash / packageId mismatch rejects are preserved.
assert.throws(
  () => resolvePackageDependencies(parent, [{ packageId: 'dep', contentHash: 'abce', packageVersion: '1' }]),
  /not resolved to its exact identity/,
  'contentHash mismatch must stay fail-closed',
);
assert.throws(
  () => resolvePackageDependencies(parent, [{ packageId: 'other', contentHash: 'abcd', packageVersion: '1' }]),
  /not resolved to its exact identity/,
  'missing packageId must stay fail-closed',
);
assert.throws(
  () => resolvePackageDependencies(parent, [{ packageId: 'dep', contentHash: 'ab!d', packageVersion: '1' }]),
  isDependencyContractError,
  'a non-canonical available contentHash must not resolve as pinned identity',
);
assert.throws(
  () => resolvePackageDependencies(parent, [{ contentHash: 'abcd', packageVersion: '1' }]),
  isDependencyContractError,
  'an available dependency without a canonical packageId must be rejected',
);

// 7. missing available list behaviour is unchanged.
assert.throws(() => resolvePackageDependencies(parent, []), /not resolved to its exact identity/);
assert.throws(() => resolvePackageDependencies(parent, null), /not resolved to its exact identity/);

// 8. dependency content identity computation is not weakened: the required
//    side keeps carrying the canonical version into the resolved record even
//    when the available side is a distinct object instance.
assert.equal(
  resolvePackageDependencies(parent, [{ packageId: 'dep', contentHash: 'abcd', packageVersion: '1' }])[0].packageVersion,
  '1',
);

console.log('issue-3838: package dependency resolver version-type regressions green');
