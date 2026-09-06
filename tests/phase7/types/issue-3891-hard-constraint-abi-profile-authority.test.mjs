import assert from 'node:assert/strict';
import test from 'node:test';

import { createHardConstraint } from '../../../js/analysis/types/constraints.js';

function abiClaim(abiProfile) {
  return {
    layer: 'abi',
    entityId: 'arg0',
    descriptor: {
      location: 'x0',
      ...(abiProfile === undefined ? {} : { abiProfile }),
    },
  };
}

function hard(input = {}) {
  return createHardConstraint({
    kind: 'abi-location',
    origin: 'abi-boundary',
    claim: abiClaim(input.claimAbiProfile),
    ...(input.abiProfile === undefined ? {} : { abiProfile: input.abiProfile }),
  });
}

test('issue #3891 rejects unsupported ABI profiles before hard authority is minted', () => {
  assert.throws(
    () => hard({ claimAbiProfile: 'unsupported-demo' }),
    /abi-profile-unsupported:unsupported-demo/,
  );
  assert.throws(
    () => hard({ abiProfile: 'unsupported-demo' }),
    /abi-profile-unsupported:unsupported-demo/,
  );
});

test('issue #3891 rejects structured and non-string ABI profile authority', () => {
  const malformed = [
    ['unsupported-demo'],
    { value: 'unsupported-demo' },
    1,
    true,
    1n,
  ];

  for (const abiProfile of malformed) {
    assert.throws(
      () => hard({ claimAbiProfile: abiProfile }),
      /abi-profile-invalid/,
    );
    assert.throws(
      () => hard({ abiProfile }),
      /abi-profile-invalid/,
    );
  }

  assert.throws(() => hard({ claimAbiProfile: '' }), /abi-profile-invalid/);
  assert.throws(() => hard({ claimAbiProfile: '   ' }), /abi-profile-invalid/);
});

test('issue #3891 never invokes caller-controlled ABI profile coercion hooks', () => {
  let coercions = 0;
  const abiProfile = {
    toString() { coercions++; return 'unsupported-demo'; },
    valueOf() { coercions++; return 'unsupported-demo'; },
    [Symbol.toPrimitive]() { coercions++; return 'unsupported-demo'; },
  };

  assert.throws(() => hard({ claimAbiProfile: abiProfile }), /abi-profile-invalid/);
  assert.equal(coercions, 0);
});

test('issue #3891 preserves canonical supported primitive ABI profiles', () => {
  const fromClaim = hard({ claimAbiProfile: 'aapcs64-v1' });
  assert.equal(fromClaim.abiProfile, 'aapcs64-v1');
  assert.equal(fromClaim.claim.descriptor.abiProfile, 'aapcs64-v1');

  const fromConstraint = hard({ abiProfile: 'sysv-amd64-v1' });
  assert.equal(fromConstraint.abiProfile, 'sysv-amd64-v1');
  assert.equal(fromConstraint.claim.descriptor.abiProfile, undefined);

  const absent = hard();
  assert.equal(absent.abiProfile, null);
});
