import assert from 'node:assert/strict';

import { checkProofEligibility } from '../../../js/symbolic/verify/eligibility.js';

function unsupportedReasons(value) {
  return checkProofEligibility({ unsupportedEntities: value }).reasons
    .filter((reason) => reason.startsWith('unsupported-entities-'));
}

assert.deepEqual(
  unsupportedReasons([]),
  [],
  'an empty unsupportedEntities array must not add an unsupported-entities reason',
);

assert.deepEqual(
  unsupportedReasons(['opaque-op']),
  ['unsupported-entities-present:1'],
  'a non-empty array must preserve the existing unsupported-entities reason',
);

for (const malformed of [null, 'opaque-op', { kind: 'opaque-op' }, 1]) {
  assert.deepEqual(
    unsupportedReasons(malformed),
    ['unsupported-entities-malformed'],
    `non-array unsupportedEntities must fail closed: ${JSON.stringify(malformed)}`,
  );
}

console.log('phase9 proof eligibility unsupportedEntities schema boundary: PASS');
