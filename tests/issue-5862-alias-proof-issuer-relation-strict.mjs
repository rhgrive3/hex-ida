import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalAliasProof } from '../js/semantics/memoryssa/proof.js';

const base = {
  identity: { snapshotId: 's' },
  functionId: 'f',
  leftRegionId: 'r1',
  rightRegionId: 'r2',
  purpose: 'memoryssa',
};

test('#5862 structured relation/issuer cannot launder into a canonical no-alias proof', () => {
  const proof = canonicalAliasProof({
    ...base,
    result: {
      relation: ['no'],
      proof: { analyzerId: ['phase7.alias.solver'], analyzerVersion: ['1.1.0'] },
    },
  });
  assert.equal(proof, null, 'array relation/issuer must not produce a canonical proof');
});

test('#5862 non-enum relation strings are rejected', () => {
  const proof = canonicalAliasProof({
    ...base,
    result: {
      relation: 'proved-no-alias',
      proof: { analyzerId: 'phase7.alias.solver', analyzerVersion: '1.1.0' },
    },
  });
  assert.equal(proof, null);
});

test('#5862 canonical primitive issuer and relation still produce proofs', () => {
  const proof = canonicalAliasProof({
    ...base,
    result: {
      relation: 'no',
      proof: { analyzerId: 'phase7.alias.solver', analyzerVersion: '1.1.0' },
    },
  });
  assert.ok(proof);
  assert.equal(proof.relation, 'no');
  assert.equal(proof.issuer.id, 'phase7.alias.solver');
  assert.equal(proof.issuer.version, '1.1.0');
  assert.ok(proof.proofDigest);
});
