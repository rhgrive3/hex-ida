import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createVerificationQuery,
  QUERY_METADATA_MAX_DEPTH,
  QUERY_METADATA_MAX_NODES,
  VERIFICATION_QUERY_KIND,
  CLAIM_KIND,
} from '../js/symbolic/verify/query.js';

function deepObject(depth) {
  let target = { id: 'leaf' };
  for (let i = 0; i < depth; i++) target = { child: target };
  return target;
}

test('#5496 deep targetEntity must fail as a domain error, not a stack overflow', () => {
  assert.throws(
    () => createVerificationQuery({
      kind: VERIFICATION_QUERY_KIND.CONDITIONAL_EDGE_FEASIBILITY,
      claimKind: CLAIM_KIND.EDGE_FEASIBLE,
      targetEntity: deepObject(50_000),
      constraints: [],
    }),
    (error) => error instanceof TypeError && /depth budget exceeded/.test(error.message),
    'depth-50k metadata must be rejected with the explicit budget error',
  );
});

test('#5496 metadata within the depth budget is accepted and normalized', () => {
  const depthBudgetTarget = deepObject(Math.min(256, QUERY_METADATA_MAX_DEPTH - 8));
  const query = createVerificationQuery({
    kind: VERIFICATION_QUERY_KIND.CONDITIONAL_EDGE_FEASIBILITY,
    claimKind: CLAIM_KIND.EDGE_FEASIBLE,
    targetEntity: depthBudgetTarget,
    constraints: [],
  });
  assert.equal(query.kind, VERIFICATION_QUERY_KIND.CONDITIONAL_EDGE_FEASIBILITY);
  assert.equal(typeof query.queryHash, 'string');
  assert.ok(query.queryHash.length > 0);
});

test('#5496 huge node counts are rejected by the node budget even at shallow depth', () => {
  const wide = {
    kind: 'wide',
    children: Array.from({ length: QUERY_METADATA_MAX_NODES + 1 }, (_, i) => ({ id: `n${i}` })),
  };
  assert.throws(
    () => createVerificationQuery({
      kind: VERIFICATION_QUERY_KIND.CONDITIONAL_EDGE_FEASIBILITY,
      claimKind: CLAIM_KIND.EDGE_FEASIBLE,
      targetEntity: wide,
      constraints: [],
    }),
    (error) => error instanceof TypeError && /node budget exceeded/.test(error.message),
  );
});

test('#5496 cyclic metadata does not loop the freeze walk and stays fail-closed', () => {
  const cyclic = { id: 'root' };
  cyclic.self = cyclic;
  // freezeDeep handles the cycle without infinite recursion; the identity
  // hashing layer then rejects cyclic material outright (fail-closed).
  assert.throws(
    () => createVerificationQuery({
      kind: VERIFICATION_QUERY_KIND.CONDITIONAL_EDGE_FEASIBILITY,
      claimKind: CLAIM_KIND.EDGE_FEASIBLE,
      targetEntity: cyclic,
      constraints: [],
    }),
    (error) => error instanceof TypeError,
  );
});

test('#5496 constraints/assertion/assumptions paths carry the same budget', () => {
  assert.throws(
    () => createVerificationQuery({
      kind: VERIFICATION_QUERY_KIND.CONDITIONAL_EDGE_FEASIBILITY,
      claimKind: CLAIM_KIND.EDGE_FEASIBLE,
      constraints: [deepObject(50_000)],
    }),
    (error) => error instanceof TypeError && /depth budget exceeded/.test(error.message),
  );
  assert.throws(
    () => createVerificationQuery({
      kind: VERIFICATION_QUERY_KIND.CONDITIONAL_EDGE_FEASIBILITY,
      claimKind: CLAIM_KIND.EDGE_FEASIBLE,
      assumptions: [deepObject(50_000)],
    }),
    (error) => error instanceof TypeError && /depth budget exceeded/.test(error.message),
  );
});
