const VERSION_PREFIX = '2.0';
const IDENTITY = /^[a-f0-9]{64}$/;
const BUILD_ID = /^[a-f0-9]{24}$/;

export function resolveUserscriptReleaseVersion(previous, { releaseIdentity, buildId } = {}) {
  const serial = Number(previous?.serial);
  if (!Number.isSafeInteger(serial) || serial < 1 || serial >= 9_999_999_999) {
    throw new Error('Userscript release serial is invalid or exhausted.');
  }
  const identity = String(releaseIdentity || '').toLowerCase();
  const runtimeBuildId = String(buildId || '').toLowerCase();
  if (!IDENTITY.test(identity)) throw new Error('Userscript release identity must be SHA-256 hex.');
  if (!BUILD_ID.test(runtimeBuildId)) throw new Error('Userscript runtime buildId must be 24 lowercase hex characters.');

  const previousIdentity = typeof previous?.releaseIdentity === 'string'
    ? previous.releaseIdentity.toLowerCase()
    : '';
  const previousBuildId = typeof previous?.buildId === 'string'
    ? previous.buildId.toLowerCase()
    : '';
  if (!IDENTITY.test(previousIdentity)) throw new Error('Previous userscript release identity must be SHA-256 hex.');
  if (!BUILD_ID.test(previousBuildId)) throw new Error('Previous userscript runtime buildId must be 24 hex characters.');

  const unchanged = previousIdentity === identity && previousBuildId === runtimeBuildId;
  const nextSerial = unchanged ? serial : serial + 1;
  const state = Object.freeze({ serial: nextSerial, releaseIdentity: identity, buildId: runtimeBuildId });
  return Object.freeze({
    changed: !unchanged,
    version: VERSION_PREFIX + '.' + nextSerial,
    state,
  });
}
