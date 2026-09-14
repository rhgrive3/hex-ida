import assert from 'node:assert/strict';
import test from 'node:test';

import { PROOF_AUTHORITY, SolverBackend } from '../js/symbolic/solver/backend.js';

class ProbeBackend extends SolverBackend {
  createSession() { return null; }
}

function probe(options = {}) {
  return new ProbeBackend({ id: 'b', version: '1', ...options });
}

test('#4954 primitive boolean capabilities are preserved through to fingerprint', () => {
  for (const [isRemote, isWasm] of [[true, true], [true, false], [false, true], [false, false]]) {
    const backend = probe({ isRemote, isWasm });
    assert.equal(backend.isRemote, isRemote);
    assert.equal(backend.isWasm, isWasm);
    assert.equal(backend.baseCapabilities().isRemote, isRemote);
    assert.equal(backend.baseCapabilities().isWasm, isWasm);
    assert.equal(backend.capabilities().isRemote, isRemote);
    assert.equal(backend.capabilities().isWasm, isWasm);
    assert.equal(
      backend.capabilityFingerprint(),
      probe({ isRemote, isWasm }).capabilityFingerprint(),
      'equal canonical booleans must mint an equal fingerprint',
    );
  }
  assert.notEqual(
    probe({ isRemote: true }).capabilityFingerprint(),
    probe({ isRemote: false }).capabilityFingerprint(),
    'isRemote must keep participating in the canonical fingerprint',
  );
  assert.notEqual(
    probe({ isWasm: true }).capabilityFingerprint(),
    probe({ isWasm: false }).capabilityFingerprint(),
    'isWasm must keep participating in the canonical fingerprint',
  );
});

test('#4954 omitted capability keeps the existing default false', () => {
  const omitted = probe();
  assert.equal(omitted.isRemote, false);
  assert.equal(omitted.isWasm, false);
  assert.equal(omitted.capabilityFingerprint(), probe({ isRemote: false, isWasm: false }).capabilityFingerprint());
});

test('#4954 nullish capability collapses to the conservative default false', () => {
  for (const nullish of [undefined, null]) {
    const backend = probe({ isRemote: nullish, isWasm: nullish });
    assert.equal(backend.isRemote, false);
    assert.equal(backend.isWasm, false);
  }
});

test('#4954 coercible malformed isRemote values are rejected, not promoted', () => {
  for (const value of ['false', 'true', '0', '1', [], [1], {}, { toString() { return 'x'; } }, 0, 1, 2, NaN, Infinity, 1n, () => true]) {
    assert.throws(
      () => probe({ isRemote: value }),
      (error) => error instanceof TypeError && /isRemote must be a primitive boolean/.test(error.message),
      `isRemote ${typeof value} must fail closed`,
    );
  }
});

test('#4954 coercible malformed isWasm values are rejected, not promoted', () => {
  for (const value of ['false', 'true', [], [1], {}, 0, 1, 1n]) {
    assert.throws(
      () => probe({ isWasm: value }),
      (error) => error instanceof TypeError && /isWasm must be a primitive boolean/.test(error.message),
      `isWasm ${typeof value} must fail closed`,
    );
  }
});

test('#4954 the issue minimal counterexample is rejected', () => {
  assert.throws(
    () => probe({ isRemote: 'false', isWasm: [] }),
    TypeError,
  );
});

test('#4954 rejection happens without consulting coercion hooks', () => {
  let coercionReads = 0;
  const hostile = new Proxy({}, {
    get(target, property, receiver) {
      if (property === Symbol.toPrimitive || property === 'toString' || property === 'valueOf') coercionReads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  assert.throws(() => probe({ isRemote: hostile, isWasm: hostile }), TypeError);
  assert.equal(coercionReads, 0, 'boolean capability validation must not read coercion hooks');
});

test('#4954 sibling schema guards keep their existing behavior', () => {
  assert.throws(() => probe({ id: '', version: '1' }), TypeError);
  assert.throws(() => probe({ id: 'b', version: '1', proofAuthority: 'exact-ish' }), TypeError);
  const exact = probe({ proofAuthority: PROOF_AUTHORITY.EXACT, isRemote: true, isWasm: true });
  assert.equal(exact.proofAuthority, PROOF_AUTHORITY.EXACT);
});
