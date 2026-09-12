import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSymbolicEvidence,
  isProvedEvidence,
  isRefutedEvidence,
  EVIDENCE_VERDICT,
  PRECONDITION_STATUS,
  VALIDATION_STATUS,
} from '../js/symbolic/evidence/symbolic-evidence.js';
import { PROOF_AUTHORITY } from '../js/symbolic/solver/backend.js';
import { SOLVER_STATUS } from '../js/symbolic/solver/result.js';

const STRUCTURED_ENTITY_ID_PREFIX = '\u0000entity:json:';

const provedBase = {
  queryKind: 'equivalence',
  claimKind: 'bounded-equivalence',
  proofStatement: 'x == x',
  targetEntities: ['fn:1'],
  queryHash: 'q1',
  backendId: 'solver',
  backendVersion: '1',
  proofAuthority: PROOF_AUTHORITY.EXACT,
  capabilityFingerprint: 'cap',
  solverStatus: SOLVER_STATUS.UNSAT,
  preconditionStatus: PRECONDITION_STATUS.SATISFIABLE,
  verdict: EVIDENCE_VERDICT.PROVED,
  completeness: {
    translation: 'complete', controlFlow: 'complete', memoryEffects: 'complete',
    pathCoverage: 'complete', queryScope: 'complete',
  },
};

const refutedBase = {
  ...provedBase,
  solverStatus: SOLVER_STATUS.SAT,
  validationStatus: VALIDATION_STATUS.VALIDATED,
  verdict: EVIDENCE_VERDICT.REFUTED,
  witnessModel: { arg_x0: 42 },
};

test('#4663 valid primitive scope metadata keeps minting canonical proved evidence', () => {
  const ev = createSymbolicEvidence({ ...provedBase, architecture: 'arm64', bitWidth: 64 });
  assert.equal(ev.architecture, 'arm64');
  assert.equal(ev.bitWidth, 64);
  assert.equal(isProvedEvidence(ev), true);
  const again = createSymbolicEvidence({ ...provedBase, architecture: 'arm64', bitWidth: 64 });
  assert.equal(again.id, ev.id, 'evidence id determinism must be preserved');
  const defaults = createSymbolicEvidence(provedBase);
  assert.equal(defaults.architecture, 'generic');
  assert.equal(defaults.bitWidth, null);
  assert.equal(isProvedEvidence(defaults), true);
});

test('#4663 counterexample 1: structured architecture/bitWidth must not launder into exact proof metadata', () => {
  assert.throws(
    () => createSymbolicEvidence({ ...provedBase, architecture: ['arm64'], bitWidth: ['64'] }),
    TypeError
  );
});

test('#4663 mint rejects non-primitive or empty architecture', () => {
  for (const bad of [['arm64'], { id: 'arm64' }, '', '   ', null, 64, true, Symbol('arm')]) {
    assert.throws(
      () => createSymbolicEvidence({ ...provedBase, architecture: bad }),
      TypeError,
      `architecture ${String(bad)} must be rejected`
    );
  }
});

test('#4663 mint rejects structured or numeric-string bitWidth', () => {
  for (const bad of [['64'], '64', { width: 64 }, 64n, 6.5, 0, -8, Number.NaN, Number.POSITIVE_INFINITY, true]) {
    assert.throws(
      () => createSymbolicEvidence({ ...provedBase, bitWidth: bad }),
      TypeError,
      `bitWidth ${String(bad)} must be rejected`
    );
  }
});

test('#4663 counterexample 2: structured target entity must not alias the JSON canonical entity ID string', () => {
  const a = createSymbolicEvidence({ ...provedBase, targetEntities: ['{"id":"x"}'] });
  const b = createSymbolicEvidence({ ...provedBase, targetEntities: [{ id: 'x' }] });
  assert.notEqual(b.targetEntities[0], a.targetEntities[0]);
  assert.notEqual(a.id, b.id);
  assert.equal(a.targetEntities[0], '{"id":"x"}');
  assert.equal(b.targetEntities[0], `${STRUCTURED_ENTITY_ID_PREFIX}{"id":"x"}`);
});

test('#4663 target entity entries must be strings or canonicalizable objects', () => {
  for (const bad of [64, true, null, undefined, 1n, Symbol('t')]) {
    assert.throws(
      () => createSymbolicEvidence({ ...provedBase, targetEntities: [bad] }),
      TypeError,
      `target entity ${String(bad)} must be rejected`
    );
  }
});

test('#4663 a string may not impersonate the structured entity id namespace', () => {
  assert.throws(
    () => createSymbolicEvidence({ ...provedBase, targetEntities: [`${STRUCTURED_ENTITY_ID_PREFIX}{"id":"x"}`] }),
    TypeError
  );
});

test('#4663 proved/refuted predicates re-validate scope metadata types', () => {
  const ev = createSymbolicEvidence({ ...provedBase, architecture: 'arm64', bitWidth: 64 });
  assert.equal(isProvedEvidence(ev), true);
  for (const [field, value] of [
    ['architecture', ['arm64']],
    ['architecture', { id: 'arm64' }],
    ['architecture', ''],
    ['architecture', null],
    ['bitWidth', ['64']],
    ['bitWidth', '64'],
    ['bitWidth', 64.5],
    ['bitWidth', 0],
    ['bitWidth', -8],
    ['bitWidth', 64n],
    ['targetEntities', [{ id: 'x' }]],
    ['targetEntities', [42]],
  ]) {
    assert.equal(isProvedEvidence({ ...ev, [field]: value }), false,
      `tampered ${field}=${String(value)} must fail the proved predicate`);
  }
  const refuted = createSymbolicEvidence({ ...refutedBase, architecture: 'arm64', bitWidth: 64 });
  assert.equal(isRefutedEvidence(refuted), true);
  assert.equal(isRefutedEvidence({ ...refuted, architecture: ['arm64'] }), false);
  assert.equal(isRefutedEvidence({ ...refuted, bitWidth: '64' }), false);
});

test('#4663 mint rejects malformed scope metadata for refuted verdicts too', () => {
  assert.throws(() => createSymbolicEvidence({ ...refutedBase, architecture: ['arm64'] }), TypeError);
  assert.throws(() => createSymbolicEvidence({ ...refutedBase, bitWidth: ['64'] }), TypeError);
  assert.throws(() => createSymbolicEvidence({ ...refutedBase, targetEntities: [64] }), TypeError);
});

test('#4663 structured target id determinism from #5903 is preserved', () => {
  const a = createSymbolicEvidence({ ...provedBase, targetEntities: [{ b: 2, a: 1 }] });
  const b = createSymbolicEvidence({ ...provedBase, targetEntities: [{ a: 1, b: 2 }] });
  assert.equal(a.id, b.id);
  const mapA = createSymbolicEvidence({ ...provedBase, targetEntities: [new Map([['__proto__', { entity: 'A' }]])] });
  const mapB = createSymbolicEvidence({ ...provedBase, targetEntities: [new Map()] });
  assert.notEqual(mapA.id, mapB.id);
});
