import assert from 'node:assert/strict';
import { stableDigest } from '../js/core/identity/index.js';
import { computeStructuralHash } from '../js/symbolic/expr/hash.js';
import {
  createVerificationQuery,
  VERIFICATION_QUERY_KIND,
  CLAIM_KIND,
} from '../js/symbolic/verify/query.js';

// Issue #5779: the canonical factory must bind the queryHash to the same
// targetEntity representation it returns. Array inputs were schema-invalid but
// silently reshaped (`{...array}`) into a plain object at return time while the
// hash kept the array representation.

// Arrays and non-plain objects are rejected fail-closed instead of being
// reshaped by object spread after the hash has already bound a different form.
for (const targetEntity of [
  ['fn:1'],
  new Date('2020-01-01T00:00:00.000Z'),
  new Map([['fromBlock', 'b0']]),
  new Set(['b0']),
  new Uint8Array([1]),
  Object.create({ fromBlock: 'b0' }),
  7,
  false,
]) {
  assert.throws(
    () => createVerificationQuery({
      kind: VERIFICATION_QUERY_KIND.CONDITIONAL_EDGE_FEASIBILITY,
      claimKind: CLAIM_KIND.EDGE_FEASIBLE,
      targetEntity,
      constraints: [],
    }),
    (error) => error instanceof TypeError && /targetEntity/.test(error.message),
    'non-canonical targetEntity must be rejected',
  );
}

// Canonical shapes keep identical hash/record representation and hash binding.
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
  assert.equal(query.queryHash, stableDigest({
    schemaVersion: query.schemaVersion,
    kind: query.kind,
    claimKind: query.claimKind,
    targetEntity: query.targetEntity,
    constraints: query.constraints.map((constraint) => ({
      hash: computeStructuralHash(constraint),
      expression: constraint,
    })),
    assertion: query.assertion ? {
      hash: computeStructuralHash(query.assertion),
      expression: query.assertion,
    } : null,
    assumptions: query.assumptions,
    completeness: query.completeness,
    requestedOutputs: query.requestedOutputs,
    semanticIrVersion: query.semanticIrVersion,
    translatorVersion: query.translatorVersion,
    architecture: query.architecture,
    bitWidth: query.bitWidth,
    proofScope: query.proofScope || null,
  }), 'queryHash must bind the returned target representation');
}

function label(value) {
  return value === null ? 'null' : typeof value === 'object' ? 'object' : JSON.stringify(value);
}

console.log('issue-5779 verification query target shape is hash/record exact: ok');
