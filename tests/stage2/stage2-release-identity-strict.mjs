import assert from 'node:assert/strict';
import { stage2CanonicalBuildIdentity } from '../../tools/validation/stage2/verify.mjs';

const releaseIdentity = 'a'.repeat(64);
const buildId = 'b'.repeat(24);
const valid = { releaseIdentity, buildId, serial: 1 };

assert.equal(
  stage2CanonicalBuildIdentity(valid),
  `userscript-release:${releaseIdentity}:build:${buildId}:serial:1`,
);

for (const badReleaseIdentity of [[releaseIdentity], 1, true, { valueOf() { return releaseIdentity; } }, '']) {
  assert.throws(
    () => stage2CanonicalBuildIdentity({ ...valid, releaseIdentity: badReleaseIdentity }),
    (error) => error instanceof TypeError && error.message === 'stage2-release-identity-invalid',
  );
}

for (const badBuildId of [[buildId], 1, true, { valueOf() { return buildId; } }, '']) {
  assert.throws(
    () => stage2CanonicalBuildIdentity({ ...valid, buildId: badBuildId }),
    (error) => error instanceof TypeError && error.message === 'stage2-build-id-invalid',
  );
}

for (const badSerial of [0, -1, 1.5, NaN, Infinity, '1', true]) {
  assert.throws(
    () => stage2CanonicalBuildIdentity({ ...valid, serial: badSerial }),
    (error) => error instanceof TypeError && error.message === 'stage2-release-serial-invalid',
  );
}

console.log('issue #2793 Stage 2 release identity strict-type regression passed');
