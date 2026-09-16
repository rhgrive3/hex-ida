import assert from 'node:assert/strict';
import test from 'node:test';

import { SORT_KIND } from '../../../js/symbolic/expr/kinds.js';
import { ExhaustiveBvBackend } from '../../../js/symbolic/solver/exhaustive-backend.js';
import { SolverBackend, isExactProofBackend, isSolverBackendInstance } from '../../../js/symbolic/solver/backend.js';
import { effectivePositiveSafeInteger, requirePositiveSafeInteger } from '../../../js/symbolic/solver/limits.js';
import { validateExactModelBindings } from '../../../js/symbolic/solver/model-boundary.js';

test('T014 foundation: exact authority requires a real SolverBackend instance', () => {
  const exact = new ExhaustiveBvBackend();
  assert.equal(isSolverBackendInstance(exact), true);
  assert.equal(isExactProofBackend(exact), true);
  assert.equal(isSolverBackendInstance(new Proxy(exact, {})), false);
  assert.equal(isExactProofBackend(new Proxy(exact, {})), false);
  assert.equal(isExactProofBackend({
    id: exact.id,
    version: exact.version,
    proofAuthority: exact.proofAuthority,
    capabilityFingerprint: () => exact.capabilityFingerprint(),
    capabilities: () => exact.capabilities(),
  }), false);
});

test('T014 foundation: existing primitive boolean backend contract stays strict', () => {
  for (const [name, value] of [['isRemote', 'false'], ['isWasm', 1]]) {
    assert.throws(() => new SolverBackend({ id: `strict-${name}`, version: '1', [name]: value }), /primitive boolean/);
  }
});

test('T014 foundation: proof/resource limits reject coercive values and respect backend ceilings', () => {
  assert.equal(requirePositiveSafeInteger(32, 'limit'), 32);
  for (const value of [0, -1, NaN, Infinity, 1.5, '32', 32n, new Number(32)]) {
    assert.throws(() => requirePositiveSafeInteger(value, 'limit'), TypeError);
  }
  assert.equal(effectivePositiveSafeInteger({}, 'limit', 16, 64), 16);
  assert.equal(effectivePositiveSafeInteger({ limit: 128 }, 'limit', 16, 64), 64);
});

test('T014 foundation: exact model bindings are canonical and complete', () => {
  const symbols = [
    { symbolId: 'flag', sort: { kind: SORT_KIND.BOOL } },
    { symbolId: 'word', sort: { kind: SORT_KIND.BV, width: 8 } },
  ];
  assert.deepEqual(validateExactModelBindings(symbols, { flag: true, word: 255n }), { valid: true });
  assert.equal(validateExactModelBindings(symbols, { flag: true }).valid, false);
  assert.equal(validateExactModelBindings(symbols, { flag: true, word: 256n }).valid, false);
  assert.equal(validateExactModelBindings(symbols, { flag: 1, word: 1n }).valid, false);
  assert.equal(validateExactModelBindings(symbols, { flag: true, word: 1n, extra: false }).valid, false);
});
