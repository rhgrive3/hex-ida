import assert from 'node:assert/strict';

import { assertIdentityMatch } from '../../../js/phase12/identity.js';

assert.equal(assertIdentityMatch('hex-project:project-a:binary-a', 'hex-project:project-a:binary-a'), true);
assert.equal(assertIdentityMatch('', ''), true, 'optional binary identity sentinel remains supported');

// Structured values must not be collapsed through String(value), even when
// their default string representation is identical.
assert.throws(
  () => assertIdentityMatch({ binaryId: 'A' }, { binaryId: 'B' }),
  (error) => error.code === 'phase12-identity-mismatch',
);

for (const invalid of [null, undefined, [], ['identity'], {}, { value: 'identity' }, 0, 1, false, true, '   ', new String('identity')]) {
  assert.throws(
    () => assertIdentityMatch(invalid, invalid),
    (error) => error.code === 'phase12-identity-mismatch',
    `invalid identity ${Object.prototype.toString.call(invalid)} must fail closed`,
  );
  assert.throws(
    () => assertIdentityMatch('hex-identity:valid', invalid),
    (error) => error.code === 'phase12-identity-mismatch',
    `invalid expected identity ${Object.prototype.toString.call(invalid)} must fail closed`,
  );
}

assert.throws(
  () => assertIdentityMatch('hex-identity:A', 'hex-identity:B'),
  (error) => error.code === 'phase12-identity-mismatch',
);

console.log('[phase12] issue #4407 strict identity matching: PASS');
