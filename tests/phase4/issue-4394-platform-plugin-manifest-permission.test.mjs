import assert from 'node:assert/strict';
import { validatePluginManifest } from '../../js/platform/plugin-manifest.js';

function manifestWithPermissions(permissions) {
  return {
    id: 'p1',
    name: 'plugin',
    version: '1.0.0',
    apiVersion: '2.0.0',
    permissions,
    supportedTargets: ['*'],
    contributions: [{
      type: 'analyzer',
      id: 'c1',
      contractVersion: '1.0.0',
    }],
  };
}

for (const value of ['false', 'true', 0, 1, null, [], {}, new Boolean(false)]) {
  assert.throws(
    () => validatePluginManifest(manifestWithPermissions({ binaryRead: value })),
    /plugin-manifest-permissions-invalid/,
  );
}

let coerced = false;
const coercible = {
  valueOf() {
    coerced = true;
    return true;
  },
  toString() {
    coerced = true;
    return 'true';
  },
};
assert.throws(
  () => validatePluginManifest(manifestWithPermissions({ binaryRead: coercible })),
  /plugin-manifest-permissions-invalid/,
);
assert.equal(coerced, false, 'permission validation must not coerce structured values');

let permissionsReads = 0;
const statefulManifest = manifestWithPermissions(undefined);
Object.defineProperty(statefulManifest, 'permissions', {
  enumerable: true,
  get() {
    permissionsReads += 1;
    if (permissionsReads <= 3) return { binaryRead: false };
    return Object.assign(Object.create({}), { binaryRead: true });
  },
});
const statefulNormalized = validatePluginManifest(statefulManifest);
assert.equal(permissionsReads, 1, 'permissions authority must be snapshotted exactly once');
assert.equal(
  statefulNormalized.permissions.binaryRead,
  false,
  'later getter values must not replace the validated permissions authority',
);

assert.equal(
  validatePluginManifest(manifestWithPermissions({ binaryRead: true })).permissions.binaryRead,
  true,
);
assert.equal(
  validatePluginManifest(manifestWithPermissions({ binaryRead: false })).permissions.binaryRead,
  false,
);
assert.equal(
  validatePluginManifest(manifestWithPermissions({ binaryRead: undefined })).permissions.binaryRead,
  false,
);
assert.equal(
  validatePluginManifest(manifestWithPermissions({})).permissions.binaryRead,
  false,
);
assert.deepEqual(
  validatePluginManifest({ ...manifestWithPermissions(undefined), permissions: undefined }).permissions,
  {},
  'omitted permissions keep the existing normalized empty-object shape',
);

console.log('issue-4394-platform-plugin-manifest-permission: PASS');
