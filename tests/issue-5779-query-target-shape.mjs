import assert from 'node:assert/strict';
import {
  createVerificationQuery,
  VERIFICATION_QUERY_KIND,
  CLAIM_KIND,
} from '../js/symbolic/verify/query.js';

// Issue #5779: the canonical factory must bind the queryHash to the same
// targetEntity representation it returns. Array inputs were schema-invalid but
// silently reshaped (`{...array}`) into a plain object at return time while the
// hash kept the array representation.

// Arrays are rejected fail-closed instead of being reshaped.
assert.throws(
  () => createVerificationQuery({
    kind: VERIFICATION_QUERY_KIND.CONDITIONAL_EDGE_FEASIBILITY,
    claimKind: CLAIM_KIND.EDGE_FEASIBLE,
    targetEntity: ['fn:1'],
    constraints: [],
  }),
  (error) => error instanceof TypeError && /targetEntity/.test(error.message),
  'array targetEntity must be rejected, not reshaped',
);

// Canonical shapes keep identical hash/record representation.
for (const targetEntity of [{ fromBlock: 'b0', toBlock: 'b1' }, 'preconditions', null]) {
  const query = createVerificationQuery({
    kind: VERIFICATION_QUERY_KIND.CONDITIONAL_EDGE_FEASIBILITY,
    claimKind: CLAIM_KIND.EDGE_FEASIBLE,
    targetEntity,
    constraints: [],
  });
  const expected = targetEntity && typeof targetEntity === 'object'
    ? JSON.stringify(targetEntity)
    : String(targetEntity ?? '');
  const returned = targetEntity && typeof targetEntity === 'object'
    ? JSON.stringify(query.targetEntity)
    : String(query.targetEntity ?? '');
  assert.equal(returned, expected, `object target representation must survive (${label(targetEntity)})`);
  assert.equal(typeof query.queryHash, 'string');
}

function label(value) {
  return value === null ? 'null' : typeof value === 'object' ? 'object' : JSON.stringify(value);
}

console.log('issue-5779 verification query target shape is hash/record exact: ok');
