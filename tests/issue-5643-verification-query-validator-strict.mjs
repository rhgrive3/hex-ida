import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isVerificationQuery,
  createVerificationQuery,
  QUERY_SCHEMA_VERSION,
  VERIFICATION_QUERY_KIND,
  CLAIM_KIND,
} from '../js/symbolic/verify/query.js';

test('#5643 unknown kind/claimKind must fail validation like the factory', () => {
  const forged = {
    schemaVersion: QUERY_SCHEMA_VERSION,
    kind: 'not-a-real-query-kind',
    claimKind: 'not-a-real-claim-kind',
    constraints: [],
    assertion: null,
    queryHash: 'arbitrary',
  };
  assert.equal(isVerificationQuery(forged), false);
  assert.throws(() => createVerificationQuery({ kind: forged.kind, claimKind: forged.claimKind }), TypeError);
});

test('#5643 every canonical kind/claimKind pair round-trips the validator', () => {
  for (const kind of Object.values(VERIFICATION_QUERY_KIND)) {
    for (const claimKind of Object.values(CLAIM_KIND)) {
      const query = createVerificationQuery({ kind, claimKind });
      assert.equal(isVerificationQuery(query), true, `${kind}/${claimKind} must validate`);
    }
  }
});

test('#5643 a tampered queryHash must be rejected', () => {
  const query = createVerificationQuery({ kind: 'bounded_equivalence', claimKind: 'equivalent' });
  assert.equal(isVerificationQuery({ ...query, queryHash: 'tampered' }), false);
  assert.equal(isVerificationQuery({ ...query, queryHash: 'same-hash' }), false);
});

test('#5643 two different constraints can no longer share one identity', () => {
  const constraintA = { id: 'c1', expression: 'x0 == 0' };
  const constraintB = { id: 'c2', expression: 'x0 != 0' };
  const a = createVerificationQuery({
    kind: 'conditional_edge_feasibility',
    claimKind: 'edge_feasible',
    constraints: [constraintA],
  });
  const b = createVerificationQuery({
    kind: 'conditional_edge_feasibility',
    claimKind: 'edge_feasible',
    constraints: [constraintB],
  });
  assert.notEqual(a.queryHash, b.queryHash);
  // A cross-labeled forgery (B's content stamped with A's hash) is rejected.
  assert.equal(isVerificationQuery({ ...b, queryHash: a.queryHash }), false);
});

test('#5643 all factory-carried fields participate in the content hash', () => {
  const base = createVerificationQuery({
    kind: 'bounded_equivalence',
    claimKind: 'different',
    targetEntity: { fn: 'sub_1000' },
    bitWidth: 64,
    architecture: 'arm64',
    assumptions: ['a1'],
    requestedOutputs: ['model'],
  });
  for (const mutated of [
    { ...base, kind: 'conditional_edge_feasibility' },
    { ...base, claimKind: 'equivalent' },
    { ...base, targetEntity: { fn: 'sub_2000' } },
    { ...base, architecture: 'x86_64' },
    { ...base, bitWidth: 32 },
    { ...base, assumptions: ['a2'] },
    { ...base, requestedOutputs: [] },
    { ...base, constraints: [{ id: 'x' }] },
  ]) {
    assert.equal(isVerificationQuery(mutated), false, `mutation must invalidate: ${JSON.stringify(mutated).slice(0, 80)}`);
  }
});

test('#5643 malformed hash material must fail closed without throwing', () => {
  const query = createVerificationQuery({ kind: 'bounded_equivalence', claimKind: 'equivalent' });
  // Cyclic/garbage hash material must not crash the validator.
  const hostile = { ...query, targetEntity: {} };
  hostile.targetEntity.self = hostile.targetEntity;
  assert.equal(isVerificationQuery(hostile), false);
  assert.equal(isVerificationQuery(null), false);
  assert.equal(isVerificationQuery('query'), false);
  assert.equal(isVerificationQuery({ ...query, schemaVersion: '0.0.1' }), false);
  assert.equal(isVerificationQuery({ ...query, constraints: 'not-an-array' }), false);
});
