import assert from 'node:assert/strict';
import test from 'node:test';

import { computeProofCacheKey, computeVerifierFingerprint } from '../js/symbolic/evidence/cache-policy.js';
import { PROOF_AUTHORITY } from '../js/symbolic/solver/backend.js';

const base = {
  queryKind: 'bounded-equivalence',
  backendId: 'exhaustive-bv',
  backendVersion: '1.0.0',
  proofAuthority: PROOF_AUTHORITY.EXACT,
  capabilityFingerprint: 'cap-fingerprint',
};

test('#5907 solverOptions with an own __proto__ key produces a distinct verifier fingerprint', () => {
  const clean = computeVerifierFingerprint({ ...base, solverOptions: {} });
  const proto = computeVerifierFingerprint({
    ...base,
    solverOptions: JSON.parse('{"__proto__":{"maxSteps":1}}'),
  });
  assert.notEqual(clean, proto, 'own __proto__ data must survive canonicalization');
});

test('#5907 proofScope with an own __proto__ key produces a distinct verifier fingerprint', () => {
  const clean = computeVerifierFingerprint({ ...base, solverOptions: {}, proofScope: {} });
  const proto = computeVerifierFingerprint({
    ...base,
    solverOptions: {},
    proofScope: JSON.parse('{"__proto__":{"functions":["0x1000"]}}'),
  });
  assert.notEqual(clean, proto);
});

test('#5907 key-order differences still collapse to one fingerprint (determinism kept)', () => {
  const a = computeVerifierFingerprint({
    ...base,
    solverOptions: { maxSteps: 10, timeoutMs: 500 },
  });
  const b = computeVerifierFingerprint({
    ...base,
    solverOptions: { timeoutMs: 500, maxSteps: 10 },
  });
  assert.equal(a, b);
});

test('#5907 same semantic configuration keeps the existing deterministic fingerprint', () => {
  const a = computeVerifierFingerprint({ ...base, solverOptions: { maxSteps: 10 } });
  const b = computeVerifierFingerprint({ ...base, solverOptions: { maxSteps: 10 } });
  assert.equal(a, b);
});

test('#5907 different solver configurations still produce different fingerprints', () => {
  const a = computeVerifierFingerprint({ ...base, solverOptions: { maxSteps: 10 } });
  const b = computeVerifierFingerprint({ ...base, solverOptions: { maxSteps: 20 } });
  assert.notEqual(a, b);
});

test('#5907 a configuration change invalidates the exact proof cache key', () => {
  const a = computeVerifierFingerprint({ ...base, solverOptions: { maxSteps: 10 } });
  const b = computeVerifierFingerprint({ ...base, solverOptions: { maxSteps: 20 } });
  const keyA = computeProofCacheKey({
    queryHash: 'query-hash',
    verifierFingerprint: a,
    binaryIdentity: 'binary-id',
    analysisRevision: 'revision-1',
  });
  const keyB = computeProofCacheKey({
    queryHash: 'query-hash',
    verifierFingerprint: b,
    binaryIdentity: 'binary-id',
    analysisRevision: 'revision-1',
  });
  assert.notEqual(keyA, keyB, 'changed solver configuration must not reuse a proof cache entry');
});
