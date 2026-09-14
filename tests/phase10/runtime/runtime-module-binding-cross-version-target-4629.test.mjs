import assert from 'node:assert/strict';
import test from 'node:test';

import { RuntimeModuleBindingTable } from '../../../js/runtime/provider-identity.js';

function table() {
  const value = new RuntimeModuleBindingTable('session:4629');
  value.load({
    bindingKey: 'main',
    runtimeBase: 0x1000n,
    runtimeSize: 0x100n,
    staticBase: 0x4000n,
    binaryId: 'binary-A',
    identityState: 'exact',
    identityEvidenceIds: ['module-A'],
  });
  return value;
}

function strongMatch(overrides = {}) {
  return {
    accepted: true,
    confidence: 0.95,
    ambiguityMargin: 0.20,
    staticAddress: 0x9000n,
    evidenceIds: ['match-1'],
    ...overrides,
  };
}

test('cross-version resolution requires the match to bind the requested binary (#4629)', () => {
  const runtime = table();

  for (const crossVersionMatch of [
    strongMatch(),
    strongMatch({ targetBinaryId: 'binary-A' }),
    strongMatch({ targetBinaryId: ['binary-B'] }),
  ]) {
    const result = runtime.resolve(0x1010n, {
      binaryId: 'binary-B',
      crossVersionMatch,
    });
    assert.equal(result.state, 'mismatch');
    assert.equal(result.method, 'binary-id-mismatch');
    assert.equal(result.binaryId, 'binary-A');
    assert.equal(result.staticAddress, null);
  }
});

test('a strong match explicitly bound to the requested binary can resolve (#4629)', () => {
  const result = table().resolve(0x1010n, {
    binaryId: 'binary-B',
    crossVersionMatch: strongMatch({ targetBinaryId: 'binary-B' }),
  });

  assert.equal(result.state, 'resolved');
  assert.equal(result.method, 'cross-version-match');
  assert.equal(result.binaryId, 'binary-B');
  assert.equal(result.staticAddress, 0x9000n);
  assert.deepEqual(result.evidenceIds, ['match-1', 'module-A']);
});

test('cross-version confidence and ambiguity guards remain fail-closed (#4629)', () => {
  const runtime = table();

  for (const crossVersionMatch of [
    strongMatch({ targetBinaryId: 'binary-B', confidence: 0.84 }),
    strongMatch({ targetBinaryId: 'binary-B', ambiguityMargin: 0.09 }),
    strongMatch({ targetBinaryId: 'binary-B', ambiguous: true }),
  ]) {
    const result = runtime.resolve(0x1010n, {
      binaryId: 'binary-B',
      crossVersionMatch,
    });
    assert.equal(result.state, 'mismatch');
    assert.equal(result.method, 'binary-id-mismatch');
  }
});

test('same-binary resolution remains exact without cross-version proof (#4629)', () => {
  const result = table().resolve(0x1010n, { binaryId: 'binary-A' });
  assert.equal(result.state, 'exact');
  assert.equal(result.method, 'verified-module-offset');
  assert.equal(result.staticAddress, 0x4010n);
});
