import assert from 'node:assert/strict';
import test from 'node:test';

import { TraceProvider } from '../../../js/runtime/trace-provider.js';

const binaryId = 'bin_sha256_' + 'ab'.repeat(32);

function recording(moduleOverrides = {}) {
  return {
    recordingId: 'recording:issue-4918',
    sourceProvider: 'fixture-tracer',
    sourceProviderVersion: '1',
    binaryId,
    completeness: 'complete',
    events: [],
    modules: [{
      bindingKey: 'main',
      runtimeBase: 0x7000n,
      runtimeSize: 0x1000n,
      staticBase: 0x1000n,
      binaryId,
      sliceId: 'slice:arm64',
      imageId: 'image:main',
      identityEvidenceIds: ['ev:module:identity'],
      ...moduleOverrides,
    }],
  };
}

async function bindingFor(moduleOverrides) {
  const provider = new TraceProvider(recording(moduleOverrides), { id: 'trace:issue-4918' });
  const session = await provider.openSession();
  const [binding] = session.modules.active();
  await session.close();
  return binding;
}

for (const identityState of ['mismatch', 'unresolved']) {
  test(`P10 #4918 explicit ${identityState} state cannot be promoted by canonical evidence IDs`, async () => {
    const binding = await bindingFor({ identityState });
    assert.equal(binding.identityState, 'unresolved');
    assert.equal(binding.binaryId, null);
    assert.equal(binding.sliceId, null);
    assert.equal(binding.imageId, null);
    assert.deepEqual(binding.identityEvidenceIds, ['ev:module:identity']);
  });
}

test('P10 #4918 resolved state still requires canonical identity evidence', async () => {
  const valid = await bindingFor({ identityState: 'resolved' });
  assert.equal(valid.identityState, 'resolved');
  assert.equal(valid.binaryId, binaryId);
  assert.equal(valid.sliceId, 'slice:arm64');
  assert.equal(valid.imageId, 'image:main');

  const malformed = await bindingFor({
    identityState: 'resolved',
    identityEvidenceIds: ['ev:module:identity', 7],
  });
  assert.equal(malformed.identityState, 'unresolved');
  assert.equal(malformed.binaryId, null);
  assert.equal(malformed.sliceId, null);
  assert.equal(malformed.imageId, null);
});

test('P10 #4918 exact state retains its existing proof semantics without evidence IDs', async () => {
  const binding = await bindingFor({ identityState: 'exact', identityEvidenceIds: [] });
  assert.equal(binding.identityState, 'exact');
  assert.equal(binding.binaryId, binaryId);
  assert.equal(binding.sliceId, 'slice:arm64');
  assert.equal(binding.imageId, 'image:main');
});

test('P10 #4918 legacy missing state plus canonical evidence remains resolved', async () => {
  const binding = await bindingFor({ identityState: undefined });
  assert.equal(binding.identityState, 'resolved');
  assert.equal(binding.binaryId, binaryId);
  assert.equal(binding.sliceId, 'slice:arm64');
  assert.equal(binding.imageId, 'image:main');
});
