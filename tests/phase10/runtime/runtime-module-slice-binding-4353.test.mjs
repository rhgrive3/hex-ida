import assert from 'node:assert/strict';
import test from 'node:test';

import { RuntimeModuleBindingTable } from '../../../js/runtime/provider-identity.js';

function tableWithSlice(sliceId = null) {
  const table = new RuntimeModuleBindingTable('runtime-session-4353');
  table.load({
    bindingKey: 'main',
    runtimeBase: 0x1000n,
    runtimeSize: 0x100n,
    staticBase: 0x2000n,
    binaryId: 'fat-bin',
    sliceId,
    identityState: 'exact',
    identityEvidenceIds: ['module-evidence'],
  });
  return table;
}

test('P10.9 scoped module resolution rejects missing binding slice identity', () => {
  const result = tableWithSlice().resolve(0x1010n, {
    binaryId: 'fat-bin',
    sliceId: 'slice-arm64',
  });

  assert.equal(result.state, 'unresolved');
  assert.equal(result.method, 'slice-identity-unresolved');
  assert.equal(result.staticAddress, null);
  assert.equal(result.binaryId, 'fat-bin');
  assert.equal(result.sliceId, null);
  assert.deepEqual(result.evidenceIds, ['module-evidence']);
});

test('P10.9 scoped module resolution preserves slice mismatch rejection', () => {
  const result = tableWithSlice('slice-x86_64').resolve(0x1010n, {
    binaryId: 'fat-bin',
    sliceId: 'slice-arm64',
  });

  assert.equal(result.state, 'mismatch');
  assert.equal(result.method, 'slice-id-mismatch');
  assert.equal(result.staticAddress, null);
});

test('P10.9 scoped module resolution accepts exact matching slice identity', () => {
  const result = tableWithSlice('slice-arm64').resolve(0x1010n, {
    binaryId: 'fat-bin',
    sliceId: 'slice-arm64',
  });

  assert.equal(result.state, 'exact');
  assert.equal(result.method, 'verified-module-offset');
  assert.equal(result.staticAddress, 0x2010n);
  assert.equal(result.sliceId, 'slice-arm64');
});

test('P10.9 binary-only module resolution keeps legacy slice-agnostic behavior', () => {
  const result = tableWithSlice().resolve(0x1010n, { binaryId: 'fat-bin' });

  assert.equal(result.state, 'exact');
  assert.equal(result.method, 'verified-module-offset');
  assert.equal(result.staticAddress, 0x2010n);
  assert.equal(result.sliceId, null);
});
