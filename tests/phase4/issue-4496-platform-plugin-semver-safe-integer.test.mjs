import assert from 'node:assert/strict';
import {
  parseSemver,
  isSemverCompatible,
  validatePluginManifest,
  checkManifestCompatibility,
} from '../../js/platform/plugin-manifest.js';

const invalidVersions = [
  '9007199254740992.0.0',
  '9007199254740993.0.0',
  '0.9007199254740992.0',
  '0.0.9007199254740992',
  `${'9'.repeat(400)}.0.0`,
];

for (const version of invalidVersions) {
  assert.throws(() => parseSemver(version), /semver-invalid/);
}
assert.throws(
  () => isSemverCompatible('9007199254740993.0.0', '9007199254740992.0.0'),
  /semver-invalid/,
);

assert.deepEqual(parseSemver('9007199254740991.0.0'), {
  major: Number.MAX_SAFE_INTEGER,
  minor: 0,
  patch: 0,
  raw: '9007199254740991.0.0',
});
assert.deepEqual(parseSemver('1.2.3'), { major:1, minor:2, patch:3, raw:'1.2.3' });
assert.equal(isSemverCompatible('2.0.0', '2.0.0'), true);
assert.equal(isSemverCompatible('2.0.1', '2.0.0'), false);
assert.equal(isSemverCompatible('2.0.0', '2.0.1'), true);
assert.equal(isSemverCompatible('2.0.999', '2.1.0'), true);

const baseManifest = {
  id:'safe.semver',
  name:'Safe SemVer',
  version:'1.0.0',
  apiVersion:'2.0.0',
  permissions:{ binaryRead:false },
  supportedTargets:['*'],
  contributions:[{
    type:'analyzer',
    id:'safe.semver.analyzer',
    contractVersion:'1.0.0',
    capabilities:[],
  }],
};

for (const field of ['version', 'apiVersion']) {
  assert.throws(
    () => validatePluginManifest({ ...baseManifest, [field]:'9007199254740992.0.0' }),
    /semver-invalid/,
  );
}
assert.throws(
  () => validatePluginManifest({
    ...baseManifest,
    contributions:[{
      ...baseManifest.contributions[0],
      contractVersion:'1.9007199254740992.0',
    }],
  }),
  /semver-invalid/,
);
assert.throws(
  () => checkManifestCompatibility({ ...baseManifest, apiVersion:'9007199254740992.0.0' }),
  /semver-invalid/,
);
assert.throws(
  () => checkManifestCompatibility({
    ...baseManifest,
    contributions:[{
      ...baseManifest.contributions[0],
      contractVersion:'1.9007199254740992.0',
    }],
  }),
  /semver-invalid/,
);

console.log('issue-4496 platform plugin semver safe integer: PASS');
