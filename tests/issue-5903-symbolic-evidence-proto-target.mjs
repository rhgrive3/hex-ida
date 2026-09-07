import assert from 'node:assert/strict';
import test from 'node:test';

import { createSymbolicEvidence } from '../js/symbolic/evidence/symbolic-evidence.js';
import { ExhaustiveBvBackend } from '../js/symbolic/solver/exhaustive-backend.js';

const exactBackend = new ExhaustiveBvBackend();
const base = {
  queryKind: 'edge-feasibility',
  claimKind: 'edge-feasibility',
  proofStatement: 'Edge is infeasible under precondition P',
  queryHash: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
  solverStatus: 'unsat',
  preconditionStatus: 'satisfiable',
  validationStatus: 'not-applicable',
  verdict: 'proved',
  backendId: exactBackend.id,
  backendVersion: exactBackend.version,
  proofAuthority: exactBackend.proofAuthority,
  capabilityFingerprint: exactBackend.capabilityFingerprint(),
};

test('#5903 own __proto__ data property yields a different Evidence ID than an empty target', () => {
  const targetA = {};
  const targetB = JSON.parse('{"__proto__":{"entity":"A"}}');
  const a = createSymbolicEvidence({ ...base, targetEntities: [targetA] });
  const b = createSymbolicEvidence({ ...base, targetEntities: [targetB] });
  assert.notEqual(a.id, b.id, 'distinct target entities must not share one Evidence ID');
  assert.notEqual(JSON.stringify(a.targetEntities), JSON.stringify(b.targetEntities));
});

test('#5903 Map key "__proto__" is preserved as data, not dropped', () => {
  const mapTarget = new Map([['__proto__', { entity: 'A' }]]);
  const emptyTarget = new Map();
  const a = createSymbolicEvidence({ ...base, targetEntities: [mapTarget] });
  const b = createSymbolicEvidence({ ...base, targetEntities: [emptyTarget] });
  assert.notEqual(a.id, b.id);
});

test('#5903 normal key ordering keeps deterministic Evidence IDs', () => {
  const a = createSymbolicEvidence({ ...base, targetEntities: [{ b: 2, a: 1 }] });
  const b = createSymbolicEvidence({ ...base, targetEntities: [{ a: 1, b: 2 }] });
  assert.equal(a.id, b.id);
});

test('#5903 origins dynamic-key canonicalization preserves __proto__ as data in the record', () => {
  // Origins do not feed the Evidence ID, but the same safe canonicalizer must
  // keep their dynamic keys as data instead of silently dropping them.
  const a = createSymbolicEvidence({
    ...base,
    targetEntities: ['func:0x1000'],
    origins: JSON.parse('{"sym:1":["inst:0x1004"]}'),
  });
  const b = createSymbolicEvidence({
    ...base,
    targetEntities: ['func:0x1000'],
    origins: JSON.parse('{"__proto__":["inst:0x1004"]}'),
  });
  assert.notEqual(JSON.stringify(a.origins), JSON.stringify(b.origins));
  assert.ok(JSON.stringify(b.origins).includes('inst:0x1004'));
});
