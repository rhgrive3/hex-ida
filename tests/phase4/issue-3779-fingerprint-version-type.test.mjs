import assert from 'node:assert/strict';
import {
  FUNCTION_FINGERPRINT_VERSION,
  FingerprintVersionError,
  assertFingerprintCompatible,
  fingerprintFunction,
} from '../../js/fingerprint/index.js';

for (const version of [['4'], '4', true, { valueOf() { return 4; } }]) {
  assert.throws(
    () => assertFingerprintCompatible({ schema:'hex.function-fingerprint', version }),
    (error) => error instanceof FingerprintVersionError && error.code === 'unsupported-fingerprint-version',
    `malformed fingerprint version ${String(version)} must fail closed`,
  );
}

for (let version = 1; version <= FUNCTION_FINGERPRINT_VERSION; version++) {
  const candidate = { schema:'hex.function-fingerprint', version };
  assert.equal(assertFingerprintCompatible(candidate), candidate, 'canonical numeric schema versions remain compatible');
}

assert.throws(
  () => assertFingerprintCompatible({ schema:'hex.function-fingerprint', version:FUNCTION_FINGERPRINT_VERSION + 1 }),
  FingerprintVersionError,
  'future numeric schema versions remain unsupported',
);

assert.throws(
  () => fingerprintFunction({ schema:'hex.function-fingerprint', version:['4'] }),
  FingerprintVersionError,
  'malformed schema artifacts must not be laundered into the current fingerprint version',
);

console.log('issue #3779 strict fingerprint version type: PASS');
