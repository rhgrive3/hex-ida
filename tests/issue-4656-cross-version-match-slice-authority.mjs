import assert from 'node:assert/strict';
import test from 'node:test';

import { RuntimeModuleBindingTable } from '../js/runtime/provider-identity.js';

const CONTAINER = 'fat-container-hash';

function tableWith(sliceId, binaryId = CONTAINER) {
  const table = new RuntimeModuleBindingTable('session:4656');
  table.load({
    bindingKey: 'module',
    runtimeBase: 0x1000n,
    runtimeSize: 0x100n,
    staticBase: 0x4000n,
    binaryId,
    sliceId,
    identityState: 'exact',
    identityEvidenceIds: ['module-evidence'],
  });
  return table;
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

test('#4656 1. requested slice and bound slice agree stays exact', () => {
  const result = tableWith('slice:arm64').resolve(0x1010n, {
    binaryId: CONTAINER,
    sliceId: 'slice:arm64',
  });
  assert.equal(result.state, 'exact');
  assert.equal(result.method, 'verified-module-offset');
  assert.equal(result.staticAddress, 0x4010n);
  assert.equal(result.sliceId, 'slice:arm64');
});

test('#4656 2. requested slice and bound slice differ stays mismatch', () => {
  const result = tableWith('slice:x86_64').resolve(0x1010n, {
    binaryId: CONTAINER,
    sliceId: 'slice:arm64',
  });
  assert.equal(result.state, 'mismatch');
  assert.equal(result.method, 'slice-id-mismatch');
  assert.equal(result.staticAddress, null);
});

test('#4656 3. missing binding slice identity is unproven, not a wildcard', () => {
  const result = tableWith(null).resolve(0x1010n, {
    binaryId: CONTAINER,
    sliceId: 'slice:arm64',
  });
  assert.equal(result.state, 'unresolved');
  assert.equal(result.method, 'slice-identity-unresolved');
  assert.equal(result.staticAddress, null);
  assert.equal(result.sliceId, null);
});

test('#4656 4. unscoped resolution policy is unchanged when no slice is requested', () => {
  const unscoped = tableWith(null).resolve(0x1010n, { binaryId: CONTAINER });
  assert.equal(unscoped.state, 'exact');
  assert.equal(unscoped.method, 'verified-module-offset');
  assert.equal(unscoped.staticAddress, 0x4010n);
  assert.equal(unscoped.sliceId, null);

  const crossVersion = tableWith(null, 'binary-A').resolve(0x1010n, {
    binaryId: 'binary-B',
    crossVersionMatch: strongMatch({ targetBinaryId: 'binary-B' }),
  });
  assert.equal(crossVersion.state, 'resolved');
  assert.equal(crossVersion.method, 'cross-version-match');
  assert.equal(crossVersion.staticAddress, 0x9000n);
});

test('#4656 5. same container binaryId across slices cannot resolve into another slice', () => {
  const table = new RuntimeModuleBindingTable('session:4656-fat');
  table.load({
    bindingKey: 'arm64',
    runtimeBase: 0x1000n,
    runtimeSize: 0x100n,
    staticBase: 0x4000n,
    binaryId: CONTAINER,
    sliceId: 'slice:arm64',
    identityState: 'exact',
  });
  table.load({
    bindingKey: 'x86_64',
    runtimeBase: 0x2000n,
    runtimeSize: 0x100n,
    staticBase: 0x8000n,
    binaryId: CONTAINER,
    sliceId: 'slice:x86_64',
    identityState: 'exact',
  });

  const arm = table.resolve(0x1010n, { binaryId: CONTAINER, sliceId: 'slice:arm64' });
  assert.equal(arm.state, 'exact');
  assert.equal(arm.staticAddress, 0x4010n);

  const cross = table.resolve(0x1010n, { binaryId: CONTAINER, sliceId: 'slice:x86_64' });
  assert.equal(cross.state, 'mismatch');
  assert.equal(cross.method, 'slice-id-mismatch');
  assert.equal(cross.staticAddress, null);
  assert.notEqual(cross.staticAddress, 0x4010n);
});

test('#4656 6a. cross-version match does not adopt a requested slice the binding lacks', () => {
  const result = tableWith(null, 'binary-A').resolve(0x1010n, {
    binaryId: 'binary-B',
    sliceId: 'slice:arm64',
    crossVersionMatch: strongMatch({ targetBinaryId: 'binary-B' }),
  });
  assert.notEqual(result.state, 'resolved');
  assert.equal(result.state, 'unresolved');
  assert.equal(result.method, 'slice-identity-unresolved');
  assert.equal(result.staticAddress, null);
  assert.equal(result.sliceId, null);
});

test('#4656 6b. cross-version match does not resolve a different slice', () => {
  const result = tableWith('slice:x86_64', 'binary-A').resolve(0x1010n, {
    binaryId: 'binary-B',
    sliceId: 'slice:arm64',
    crossVersionMatch: strongMatch({ targetBinaryId: 'binary-B' }),
  });
  assert.notEqual(result.state, 'resolved');
  assert.equal(result.state, 'mismatch');
  assert.equal(result.method, 'slice-id-mismatch');
  assert.equal(result.staticAddress, null);
});

test('#4656 6c. cross-version match cannot assert a slice contradicting its own target', () => {
  const result = tableWith('slice:arm64', 'binary-A').resolve(0x1010n, {
    binaryId: 'binary-B',
    sliceId: 'slice:arm64',
    crossVersionMatch: strongMatch({ targetBinaryId: 'binary-B', targetSliceId: 'slice:x86_64' }),
  });
  assert.notEqual(result.state, 'resolved');
  assert.equal(result.state, 'mismatch');
  assert.equal(result.method, 'slice-id-mismatch');
  assert.equal(result.staticAddress, null);
});

test('#4656 6d. slice-bound cross-version match still resolves', () => {
  const result = tableWith('slice:arm64', 'binary-A').resolve(0x1010n, {
    binaryId: 'binary-B',
    sliceId: 'slice:arm64',
    crossVersionMatch: strongMatch({ targetBinaryId: 'binary-B', targetSliceId: 'slice:arm64' }),
  });
  assert.equal(result.state, 'resolved');
  assert.equal(result.method, 'cross-version-match');
  assert.equal(result.staticAddress, 0x9000n);
  assert.equal(result.sliceId, 'slice:arm64');
});
