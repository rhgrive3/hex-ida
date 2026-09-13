import assert from 'node:assert/strict';
import test from 'node:test';

import { TraceProvider } from '../../../js/runtime/trace-provider.js';

const binaryId = 'bin_sha256_' + '16'.repeat(32);

function recording(moduleOverrides = {}) {
  return {
    recordingId: 'recording:issue-5165',
    sourceProvider: 'external-fixture',
    sourceProviderVersion: '1',
    binaryId,
    completeness: 'complete',
    events: [],
    modules: [{
      bindingKey: 'main',
      runtimeBase: 0x1000n,
      runtimeSize: 0x100n,
      staticBase: 0x4000n,
      binaryId,
      sliceId: 'slice:arm64',
      identityState: 'exact',
      identityEvidenceIds: [],
      ...moduleOverrides,
    }],
  };
}

async function resolution(moduleOverrides, options = {}) {
  const provider = new TraceProvider(recording(moduleOverrides), options);
  const session = await provider.openSession();
  try {
    return {
      binding: session.modules.active()[0],
      resolved: session.facets.trace.resolveAddress(0x1010n, { binaryId }),
    };
  } finally {
    await session.close();
  }
}

test('P10 #5165 external exact self-assertion is not static identity proof', async () => {
  const { binding, resolved } = await resolution({ identityState: 'exact', identityEvidenceIds: [] });
  assert.equal(binding.identityState, 'unresolved');
  assert.equal(binding.binaryId, null);
  assert.equal(resolved.state, 'unresolved');
  assert.equal(resolved.staticAddress, null);
});

test('P10 #5165 arbitrary evidence id plus resolved self-assertion is not proof', async () => {
  const { binding, resolved } = await resolution({
    identityState: 'resolved',
    identityEvidenceIds: ['made-up:evidence'],
  });
  assert.equal(binding.identityState, 'unresolved');
  assert.equal(binding.binaryId, null);
  assert.equal(resolved.state, 'unresolved');
  assert.equal(resolved.staticAddress, null);
});

test('P10 #5165 trusted verifier can authorize the exact imported module mapping', async () => {
  let calls = 0;
  const { binding, resolved } = await resolution({
    identityState: 'exact',
    identityEvidenceIds: ['canonical:evidence'],
  }, {
    verifyModuleIdentity(module, context) {
      calls += 1;
      assert.equal(Object.isFrozen(module), true);
      assert.equal(module.binaryId, binaryId);
      assert.equal(context.recordingId, 'recording:issue-5165');
      assert.equal(context.binaryId, binaryId);
      return true;
    },
  });
  assert.equal(calls, 1);
  assert.equal(binding.identityState, 'exact');
  assert.equal(binding.binaryId, binaryId);
  assert.equal(resolved.state, 'exact');
  assert.equal(resolved.staticAddress, 0x4010n);
});

test('P10 #5165 verifier rejection remains fail-closed', async () => {
  const { binding, resolved } = await resolution({
    identityState: 'resolved',
    identityEvidenceIds: ['canonical:evidence'],
  }, { verifyModuleIdentity: () => false });
  assert.equal(binding.identityState, 'unresolved');
  assert.equal(binding.binaryId, null);
  assert.equal(resolved.state, 'unresolved');
});


test('P10 #5165 structured or asynchronous verifier results cannot grant authority', async () => {
  for (const verifyModuleIdentity of [
    () => ({ accepted: true }),
    () => Promise.resolve(true),
  ]) {
    const { binding, resolved } = await resolution({
      identityState: 'exact',
      identityEvidenceIds: ['canonical:evidence'],
    }, { verifyModuleIdentity });
    assert.equal(binding.identityState, 'unresolved');
    assert.equal(binding.binaryId, null);
    assert.equal(resolved.state, 'unresolved');
  }
});

test('P10 #5165 explicit negative identity never invokes the trusted verifier', async () => {
  let calls = 0;
  const { binding } = await resolution({
    identityState: 'unresolved',
    identityEvidenceIds: ['canonical:evidence'],
  }, { verifyModuleIdentity: () => { calls += 1; return true; } });
  assert.equal(calls, 0);
  assert.equal(binding.identityState, 'unresolved');
  assert.equal(binding.binaryId, null);
});

test('P10 #5165 verifier option must be callable', () => {
  assert.throws(
    () => new TraceProvider(recording(), { verifyModuleIdentity: { accepted: true } }),
    (error) => error?.code === 'trace-module-identity-verifier-invalid',
  );
});
