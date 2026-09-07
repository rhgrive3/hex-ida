import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalAliasProof } from '../../js/semantics/memoryssa/proof.js';

const base = {
  identity: { snapshotId: 's' },
  functionId: 'f',
  leftRegionId: 'r1',
  rightRegionId: 'r2',
  purpose: 'memoryssa',
};

function proofFor({ relation = 'no', analyzerId = 'phase7.alias.solver', analyzerVersion = '1.1.0' } = {}) {
  return canonicalAliasProof({
    ...base,
    result: {
      relation,
      proof: { analyzerId, analyzerVersion },
    },
  });
}

test('#5862 structured relation cannot launder into a canonical no-alias proof', () => {
  assert.equal(proofFor({ relation: ['no'] }), null);
});

test('#5862 structured analyzer id cannot launder into canonical issuer authority', () => {
  assert.equal(proofFor({ analyzerId: ['phase7.alias.solver'] }), null);
});

test('#5862 structured analyzer version cannot launder into canonical issuer authority', () => {
  assert.equal(proofFor({ analyzerVersion: ['1.1.0'] }), null);
});

test('#5862 caller-owned coercion hooks are never consulted for proof authority', () => {
  let coercions = 0;
  const coercible = {
    [Symbol.toPrimitive]() {
      coercions += 1;
      return 'no';
    },
  };
  assert.equal(proofFor({ relation: coercible }), null);
  assert.equal(proofFor({ analyzerId: coercible }), null);
  assert.equal(proofFor({ analyzerVersion: coercible }), null);
  assert.equal(coercions, 0);
});

test('#5862 non-enum relation strings are rejected', () => {
  assert.equal(proofFor({ relation: 'proved-no-alias' }), null);
});

test('#5862 canonical primitive issuer and relation still produce proofs', () => {
  const proof = proofFor();
  assert.ok(proof);
  assert.equal(proof.relation, 'no');
  assert.equal(proof.issuer.id, 'phase7.alias.solver');
  assert.equal(proof.issuer.version, '1.1.0');
  assert.ok(proof.proofDigest);
});
