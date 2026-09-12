import assert from 'node:assert/strict';
import test from 'node:test';

import {
  computeProofCacheKey,
  computeVerifierFingerprint,
  getProofToolCacheOptions,
} from '../js/symbolic/evidence/cache-policy.js';
import { PROOF_AUTHORITY } from '../js/symbolic/solver/backend.js';

const exactBase = {
  queryKind: 'bounded-equivalence',
  backendId: 'exhaustive-bv',
  backendVersion: '1.0.0',
  proofAuthority: PROOF_AUTHORITY.EXACT,
  capabilityFingerprint: 'cap-fingerprint',
};

const noneBase = {
  queryKind: 'bounded-equivalence',
  backendId: 'exhaustive-bv',
  backendVersion: '1.0.0',
};

const structuredScalars = [['bin-A'], { toString: () => 'bin-A' }, true, 7, Symbol.for('bin-A'), () => 'bin-A'];

test('#4660 canonical primitive cache identities keep their existing keys', () => {
  assert.equal(
    computeProofCacheKey({
      baseKey: 'proof:edge',
      queryHash: 'query_hash_123',
      verifierFingerprint: 'verifier_fp_456',
      binaryIdentity: 'binary_bin1',
      analysisRevision: 'rev_10',
    }),
    'proof:edge::binary_bin1::rev_10::verifier_fp_456::query_hash_123',
  );
  assert.equal(
    computeProofCacheKey({ queryHash: 'q', verifierFingerprint: 'vf' }),
    'proof::binary:unknown::analysis:0::vf::q',
  );
  assert.equal(
    computeVerifierFingerprint({
      ...exactBase,
      architecture: 'arm64',
      bitWidth: 64,
      assumptionsFingerprint: 'asm-1',
      proofScope: { functions: ['0x1000'] },
      solverOptions: { timeoutMs: 5000, randomSeed: 42 },
    }),
    '03c01c65cfd8c7888151ea018faa9a83',
  );
});

test('#4660 a structured binary or revision identity does not alias the canonical proof cache key', () => {
  assert.throws(
    () => computeProofCacheKey({
      queryHash: 'q',
      verifierFingerprint: 'vf',
      binaryIdentity: ['bin-A'],
      analysisRevision: '7',
    }),
    TypeError,
  );
  assert.throws(
    () => computeProofCacheKey({
      queryHash: 'q',
      verifierFingerprint: 'vf',
      binaryIdentity: 'bin-A',
      analysisRevision: ['7'],
    }),
    TypeError,
  );
  assert.throws(
    () => computeProofCacheKey({
      queryHash: 'q',
      verifierFingerprint: 'vf',
      binaryIdentity: { toString: () => 'bin-A' },
      analysisRevision: '7',
    }),
    TypeError,
  );
  assert.equal(
    computeProofCacheKey({
      queryHash: 'q',
      verifierFingerprint: 'vf',
      binaryIdentity: 'bin-A',
      analysisRevision: '7',
    }),
    'proof::bin-A::7::vf::q',
  );
});

test('#4660 a structured base key is rejected, not String-coerced', () => {
  assert.equal(
    computeProofCacheKey({ queryHash: 'q', verifierFingerprint: 'vf', baseKey: 'proof:edge' }),
    'proof:edge::binary:unknown::analysis:0::vf::q',
  );
  assert.throws(() => computeProofCacheKey({ queryHash: 'q', verifierFingerprint: 'vf', baseKey: ['proof:edge'] }), TypeError);
  assert.throws(() => computeProofCacheKey({ queryHash: 'q', verifierFingerprint: 'vf', baseKey: null }), TypeError);
  assert.throws(() => computeProofCacheKey({ queryHash: 'q', verifierFingerprint: 'vf', baseKey: 7 }), TypeError);
});

test('#4660 every proof cache key identity scalar must stay a primitive string', () => {
  for (const value of structuredScalars) {
    assert.throws(
      () => computeProofCacheKey({ queryHash: 'q', verifierFingerprint: 'vf', binaryIdentity: value }),
      TypeError,
      'binaryIdentity must not become cache authority through String coercion',
    );
    assert.throws(
      () => computeProofCacheKey({ queryHash: 'q', verifierFingerprint: 'vf', analysisRevision: value }),
      TypeError,
      'analysisRevision must not become cache authority through String coercion',
    );
    assert.throws(
      () => computeProofCacheKey({ queryHash: 'q', verifierFingerprint: value }),
      TypeError,
      'verifierFingerprint must not become cache authority through String coercion',
    );
    assert.throws(
      () => computeProofCacheKey({ queryHash: value, verifierFingerprint: 'vf' }),
      TypeError,
      'queryHash must not become cache authority through String coercion',
    );
  }
});

test('#4660 nullish optional identity keeps the existing fallback semantics', () => {
  assert.equal(
    computeProofCacheKey({
      queryHash: 'q',
      verifierFingerprint: 'vf',
      binaryIdentity: null,
      analysisRevision: undefined,
    }),
    'proof::binary:unknown::analysis:0::vf::q',
  );
  assert.equal(
    computeVerifierFingerprint({ ...noneBase, capabilityFingerprint: null, assumptionsFingerprint: null, semanticIrVersion: '2.0.0' }),
    computeVerifierFingerprint(noneBase),
  );
  assert.notEqual(
    computeVerifierFingerprint({ ...noneBase, assumptionsFingerprint: null }),
    computeVerifierFingerprint({ ...noneBase, assumptionsFingerprint: 'asm-1' }),
  );
});

test('#4660 structured version and assumption metadata does not launder into one verifier fingerprint', () => {
  const common = { queryKind: 'equivalence', backendId: 'z3' };
  const canonical = computeVerifierFingerprint({ ...common, semanticIrVersion: '2.0.0', assumptionsFingerprint: 'asm-1' });
  assert.throws(() => computeVerifierFingerprint({ ...common, semanticIrVersion: ['2.0.0'] }), TypeError);
  assert.throws(() => computeVerifierFingerprint({ ...common, semanticIrVersion: 2 }), TypeError);
  assert.throws(() => computeVerifierFingerprint({ ...common, semanticIrVersion: { toString: () => '2.0.0' } }), TypeError);
  assert.throws(() => computeVerifierFingerprint({ ...common, semanticIrVersion: null }), TypeError);
  assert.throws(() => computeVerifierFingerprint({ ...common, assumptionsFingerprint: ['asm-1'] }), TypeError);
  assert.throws(() => computeVerifierFingerprint({ ...common, assumptionsFingerprint: 42 }), TypeError);
  assert.throws(() => computeVerifierFingerprint({ ...common, capabilityFingerprint: ['cap'] }), TypeError);
  assert.throws(() => computeVerifierFingerprint({ ...common, capabilityFingerprint: { toString: () => 'cap' } }), TypeError);
  assert.equal(canonical, computeVerifierFingerprint({ ...common, semanticIrVersion: '2.0.0', assumptionsFingerprint: 'asm-1' }));
});

test('#4660 exact authority capability fingerprint contract is preserved', () => {
  assert.throws(
    () => computeVerifierFingerprint({ ...exactBase, capabilityFingerprint: ['cap-fingerprint'] }),
    TypeError,
  );
  assert.throws(() => computeVerifierFingerprint({ ...exactBase, capabilityFingerprint: null }), TypeError);
  assert.throws(() => computeVerifierFingerprint({ ...exactBase, capabilityFingerprint: 7 }), TypeError);
  assert.equal(typeof computeVerifierFingerprint(exactBase), 'string');
});

test('#4660 proofScope and solverOptions keep deterministic type-preserving canonicalization', () => {
  const ordered = computeVerifierFingerprint({ ...exactBase, solverOptions: { timeoutMs: 5000, randomSeed: 42 } });
  const reordered = computeVerifierFingerprint({ ...exactBase, solverOptions: { randomSeed: 42, timeoutMs: 5000 } });
  assert.equal(ordered, reordered);
  assert.notEqual(ordered, computeVerifierFingerprint({ ...exactBase, solverOptions: { timeoutMs: 5000, randomSeed: 43 } }));
  assert.notEqual(
    computeVerifierFingerprint({ ...exactBase, proofScope: { functions: ['0x1000'] } }),
    computeVerifierFingerprint({ ...exactBase, proofScope: { functions: ['0x1001'] } }),
  );
  assert.notEqual(
    computeVerifierFingerprint({ ...exactBase, solverOptions: { maxSteps: [10] } }),
    computeVerifierFingerprint({ ...exactBase, solverOptions: { maxSteps: '10' } }),
  );
});

test('#4660 proof tool cache options reject a structured verifier fingerprint', () => {
  assert.deepEqual(getProofToolCacheOptions({ verifierFingerprint: 'abc123' }), {
    storeResult: true,
    deterministic: false,
    verifierFingerprint: 'abc123',
  });
  assert.equal(getProofToolCacheOptions().verifierFingerprint, null);
  assert.equal(getProofToolCacheOptions({ verifierFingerprint: null }).verifierFingerprint, null);
  assert.throws(() => getProofToolCacheOptions({ verifierFingerprint: ['abc123'] }), TypeError);
  assert.throws(() => getProofToolCacheOptions({ verifierFingerprint: { toString: () => 'abc123' } }), TypeError);
  assert.throws(() => getProofToolCacheOptions({ verifierFingerprint: 123 }), TypeError);
});
