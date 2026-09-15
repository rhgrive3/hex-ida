import assert from 'node:assert/strict';
import test from 'node:test';

import { computeVerifierFingerprint, computeProofCacheKey, getProofToolCacheOptions } from '../js/symbolic/evidence/cache-policy.js';

// #4660 — proof cache key / verifier fingerprint must bind exact primitive-string identity,
// never String()-coerce structured values into a colliding identity.

test('#4660 canonical primitive-string proof cache key is stable and discriminative', () => {
  const k1 = computeProofCacheKey({ queryHash: 'q', verifierFingerprint: 'vf', binaryIdentity: 'bin-A', analysisRevision: '7' });
  const k2 = computeProofCacheKey({ queryHash: 'q', verifierFingerprint: 'vf', binaryIdentity: 'bin-A', analysisRevision: '7' });
  const other = computeProofCacheKey({ queryHash: 'q', verifierFingerprint: 'vf', binaryIdentity: 'bin-B', analysisRevision: '7' });
  assert.equal(k1, k2);
  assert.notEqual(k1, other);
});

test('#4660 computeProofCacheKey rejects structured binaryIdentity / analysisRevision instead of colliding', () => {
  const legit = computeProofCacheKey({ queryHash: 'q', verifierFingerprint: 'vf', binaryIdentity: 'bin-A', analysisRevision: '7' });
  assert.throws(
    () => computeProofCacheKey({ queryHash: 'q', verifierFingerprint: 'vf', binaryIdentity: ['bin-A'], analysisRevision: ['7'] }),
    TypeError,
  );
  assert.throws(() => computeProofCacheKey({ queryHash: 'q', verifierFingerprint: 'vf', baseKey: ['p'] }), TypeError);
  // The previously-colliding array input must never silently equal the legit key.
  assert.notEqual(legit, computeProofCacheKey({ queryHash: 'q', verifierFingerprint: 'vf' }));
});

test('#4660 computeVerifierFingerprint rejects structured semanticIrVersion / fingerprint identity', () => {
  const common = { queryKind: 'equivalence', backendId: 'z3' };
  assert.throws(() => computeVerifierFingerprint({ ...common, semanticIrVersion: ['2.0.0'] }), TypeError);
  assert.throws(() => computeVerifierFingerprint({ ...common, assumptionsFingerprint: ['asm-1'] }), TypeError);
  assert.throws(() => computeVerifierFingerprint({ ...common, capabilityFingerprint: ['cap'] }), TypeError);
});

test('#4660 distinct legit semanticIrVersion / assumptions still bind into distinct fingerprints', () => {
  const common = { queryKind: 'equivalence', backendId: 'z3' };
  const a = computeVerifierFingerprint({ ...common, semanticIrVersion: '2.0.0', assumptionsFingerprint: 'asm-1' });
  const b = computeVerifierFingerprint({ ...common, semanticIrVersion: '2.1.0', assumptionsFingerprint: 'asm-1' });
  const c = computeVerifierFingerprint({ ...common, semanticIrVersion: '2.0.0', assumptionsFingerprint: 'asm-2' });
  assert.equal(a, computeVerifierFingerprint({ ...common, semanticIrVersion: '2.0.0', assumptionsFingerprint: 'asm-1' }));
  assert.notEqual(a, b);
  assert.notEqual(a, c);
});

test('#4660 getProofToolCacheOptions rejects a structured verifierFingerprint', () => {
  assert.equal(getProofToolCacheOptions({ verifierFingerprint: 'vf' }).verifierFingerprint, 'vf');
  assert.equal(getProofToolCacheOptions({}).verifierFingerprint, null);
  assert.throws(() => getProofToolCacheOptions({ verifierFingerprint: ['vf'] }), TypeError);
});
