import assert from 'node:assert/strict';
import test from 'node:test';

import { createSymbolicEvidence } from '../js/symbolic/evidence/symbolic-evidence.js';
import { ExhaustiveBvBackend } from '../js/symbolic/solver/exhaustive-backend.js';

const exactBackend = new ExhaustiveBvBackend();
const base = {
  queryKind: 'edge-feasibility',
  claimKind: 'edge-feasibility',
  proofStatement: 'Edge is infeasible',
  queryHash: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
  solverStatus: 'sat',
  preconditionStatus: 'satisfiable',
  validationStatus: 'validated',
  verdict: 'refuted',
  backendId: exactBackend.id,
  backendVersion: exactBackend.version,
  proofAuthority: exactBackend.proofAuthority,
  capabilityFingerprint: exactBackend.capabilityFingerprint(),
  targetEntities: ['func:0x1000'],
};

test('#5774 witnessModel Map insertion order does not leak into the record', () => {
  const a = createSymbolicEvidence({ ...base, witnessModel: new Map([['x', 1n], ['y', 2n]]) });
  const b = createSymbolicEvidence({ ...base, witnessModel: new Map([['y', 2n], ['x', 1n]]) });
  assert.deepEqual(a.witnessModel, b.witnessModel);
  assert.equal(JSON.stringify(a.witnessModel), JSON.stringify(b.witnessModel));
  // BigInt witness values keep their existing hex normalization
  assert.deepEqual(a.witnessModel, { x: '0x1', y: '0x2' });
});

test('#5774 origins Map insertion order does not leak into the record', () => {
  const a = createSymbolicEvidence({ ...base, origins: new Map([['sym:1', ['a']], ['sym:2', ['b']]]) });
  const b = createSymbolicEvidence({ ...base, origins: new Map([['sym:2', ['b']], ['sym:1', ['a']]]) });
  assert.deepEqual(a.origins, b.origins);
  assert.equal(JSON.stringify(a.origins), JSON.stringify(b.origins));
});

test('#5774 canonical Map ordering is host-locale independent (code-unit order)', () => {
  // 'ä' is 0xE4, after 'z' (0x7A) in code-unit order regardless of ICU locale.
  const a = createSymbolicEvidence({ ...base, origins: new Map([['ä', ['x']]]) });
  const b = createSymbolicEvidence({ ...base, origins: new Map([['z', ['x']]]) });
  assert.deepEqual(JSON.stringify(a.origins), JSON.stringify({ 'ä': ['x'] }));
  assert.deepEqual(JSON.stringify(b.origins), JSON.stringify({ z: ['x'] }));
});

test('#5774 object-form witness/origins semantics unchanged', () => {
  const a = createSymbolicEvidence({ ...base, witnessModel: { x: 1n, y: 2n } });
  assert.deepEqual(a.witnessModel, { x: '0x1', y: '0x2' });
  const b = createSymbolicEvidence({ ...base, origins: { 'sym:1': ['a'] } });
  assert.deepEqual(b.origins, { 'sym:1': ['a'] });
});
