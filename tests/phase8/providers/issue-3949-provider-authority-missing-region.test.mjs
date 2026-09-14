import assert from 'node:assert/strict';
import test from 'node:test';

import { providerAuthorityFailures } from '../../../js/decompiler/phase8/providers.js';

function hint({ status = 'accepted', regionKey = 'missing-region', certainty = 'candidate', evidence = ['e'] } = {}) {
  return {
    providerId: 'test.provider',
    status,
    kind: 'idiom',
    name: 'forged',
    regionKey,
    certainty,
    evidence,
  };
}

test('accepted provider hints fail closed when their region is missing', () => {
  const failures = providerAuthorityFailures({ hints: [hint()] }, { regions: [] });
  assert.deepEqual(failures, [{
    providerId: 'test.provider',
    problem: 'accepted-for-missing-region',
    detail: 'missing-region',
  }]);
});

test('rejected missing-region hints and global accepted hints keep their existing semantics', () => {
  assert.deepEqual(
    providerAuthorityFailures({ hints: [hint({ status: 'rejected' })] }, { regions: [] }),
    [],
  );
  assert.deepEqual(
    providerAuthorityFailures({ hints: [hint({ regionKey: null })] }, { regions: [] }),
    [],
  );
});

test('existing provider authority failures remain enforced', () => {
  const view = {
    regions: [{ regionKey: 'r', conflicts: ['width-disagreement'], highestCertainty: 'candidate' }],
  };
  const failures = providerAuthorityFailures({ hints: [hint({ regionKey: 'r', certainty: 'confirmed', evidence: [] })] }, view);
  const problems = failures.map((entry) => entry.problem);
  assert.ok(problems.includes('no-evidence'));
  assert.ok(problems.includes('accepted-over-hard-conflict'));
  assert.ok(problems.includes('certainty-above-generic-evidence'));
});
