import assert from 'node:assert/strict';
import test from 'node:test';

import { createCapabilityCatalog } from '../../../js/ai/capabilities/catalog.js';
import { createCapabilityExecutor } from '../../../js/ai/capabilities/executor.js';
import { ProposalExecutor } from '../../../js/ai/interaction/proposal-executor.js';
import { ProposalStore } from '../../../js/ai/proposals.js';
import { PatchSet } from '../../../js/patch.js';

const evidenceStore = { has: (id) => id === 'evidence' };

function binding(binaryId) {
  return { binaryId, projectId: 'project-a', runtimeSessionId: null };
}
function runtimeBinding(binaryId, runtimeSessionId) {
  return { binaryId, projectId: 'project-a', runtimeSessionId };
}
function patchApp(readAt) {
  const bytes = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
  return {
    file: new Blob([bytes]),
    patches: new PatchSet(),
    backend: { readAt },
    store: {
      get(key) {
        if (key === 'regions') return [{ vmAddr: 4096n, fileOffset: 0n, size: 8n, exec: true }];
        if (key === 'fileInfo') return { size: bytes.length };
        return null;
      },
    },
  };
}

test('proposal publication fails closed when binding changes during an async adapter', async () => {
  let liveBinding = binding('bin-a');
  const store = new ProposalStore({ evidenceStore, binding: () => liveBinding });
  const proposal = store.create({
    kind: 'project-annotation', target: { id: 'async-binding' }, before: null,
    after: 'approved', evidenceIds: ['evidence'],
  });
  const { approvalToken } = store.approve(proposal.id);

  await assert.rejects(store.apply(proposal.id, {
    approvalToken,
    currentState: null,
    apply: async () => {
      await Promise.resolve();
      liveBinding = binding('bin-b');
    },
  }), (error) => error?.type === 'scope_violation');
  assert.equal(store.get(proposal.id).status, 'failed');
});

test('patch creation rejects a replaced patch set before adding to either target', async () => {
  const liveBinding = binding('bin-a');
  let readCount = 0;
  const bytes = Uint8Array.from([1, 2, 3, 4]);
  const originalPatchSet = new PatchSet();
  const replacementPatchSet = new PatchSet();
  let app;
  app = patchApp(async () => {
    readCount += 1;
    // ProposalExecutor.currentState() performs the first read. The second read
    // happens after authorization is consumed, inside validatePatchTarget().
    if (readCount === 2) app.patches = replacementPatchSet;
    return { found: true, bytes };
  });
  app.patches = originalPatchSet;
  const capabilityExecutor = createCapabilityExecutor({
    catalog: createCapabilityCatalog(), app, binaryId: () => liveBinding.binaryId,
  });
  const store = new ProposalStore({ evidenceStore, binding: () => liveBinding });
  const owner = new ProposalExecutor({ store, capabilityExecutor, app });
  const proposal = store.create({
    kind: 'patch', target: { address: '4096' }, before: [1, 2, 3, 4],
    after: [4, 3, 2, 1], evidenceIds: ['evidence'],
  });

  await assert.rejects(owner.approveAndApply(proposal.id), (error) => error?.type === 'scope_violation');
  assert.equal(readCount, 2);
  assert.equal(originalPatchSet.size, 0);
  assert.equal(replacementPatchSet.size, 0);
  assert.equal(store.get(proposal.id).status, 'failed');
});

test('runtime memory-write capability rejects a session swap and preserves atomic CAS on success', async () => {
  const liveBinding = runtimeBinding('bin-a', 'session-a');
  let readCount = 0;
  let casCount = 0;
  let swapOnThird = true;
  let memory = Uint8Array.from([1, 2, 3, 4]);
  const activeSession = { id: 'session-a', binaryHash: 'bin-a', generation: 1, adapter: null };
  const replacementAdapter = {
    epoch: 2,
    async readMemory(_address, size) { return memory.slice(0, size); },
  };
  const adapter = {
    epoch: 1,
    compareAndWriteMemoryAtomic: true,
    async readMemory(_address, size) {
      readCount += 1;
      const result = memory.slice(0, size);
      // proposeCapability + approveAndApply.currentState + execute approvalState.
      // A switch on the third read is caught before the atomic primitive runs.
      if (swapOnThird && readCount === 3) {
        activeSession.id = 'session-b';
        activeSession.adapter = replacementAdapter;
      }
      return result;
    },
    async compareAndWriteMemory(_address, expected, bytes, options) {
      casCount += 1;
      assert.equal(options.expectedSessionId, 'session-a');
      assert.deepEqual([...memory], [...expected]);
      memory = Uint8Array.from(bytes);
      return { written: bytes.length };
    },
  };
  activeSession.adapter = adapter;
  const runtimePlatform = { currentSession: () => activeSession };
  const capabilityExecutor = createCapabilityExecutor({
    catalog: createCapabilityCatalog(), runtimePlatform, binaryId: () => liveBinding.binaryId,
  });
  const store = new ProposalStore({ evidenceStore, binding: () => liveBinding });
  const owner = new ProposalExecutor({ store, capabilityExecutor });
  const args = {
    runtimeSessionId: 'session-a', binaryId: 'bin-a', address: '4096',
    expectedBefore: [1, 2, 3, 4], bytes: [9, 8, 7, 6],
  };
  const proposal = await owner.proposeCapability('runtime.memory-write', args, { evidenceIds: ['evidence'] });
  await assert.rejects(owner.approveAndApply(proposal.id), (error) => error?.type === 'scope_violation');
  assert.equal(casCount, 0, 'session drift must stop before atomic CAS');
  assert.deepEqual([...memory], [1, 2, 3, 4]);

  // Restore the approved session and verify the valid path still reaches the
  // latest-main atomic compare-and-write primitive rather than split writeMemory.
  swapOnThird = false;
  activeSession.id = 'session-a';
  activeSession.generation = 1;
  activeSession.adapter = adapter;
  readCount = 0;
  const stable = await owner.proposeCapability('runtime.memory-write', args, { evidenceIds: ['evidence'] });
  const result = await owner.approveAndApply(stable.id);
  assert.equal(result.proposal.status, 'applied');
  assert.equal(casCount, 1);
  assert.deepEqual(result.execution.after, [9, 8, 7, 6]);
  assert.deepEqual([...memory], [9, 8, 7, 6]);
});

test('patch application rejects a replaced patch set and preserves valid awaited publication', async () => {
  const liveBinding = binding('bin-a');
  const app = patchApp(async () => ({ found: true, bytes: Uint8Array.from([1, 2, 3, 4]) }));
  const originalPatchSet = app.patches;
  originalPatchSet.add(0n, [1, 2, 3, 4], [4, 3, 2, 1], { addr: 4096n });
  const replacementPatchSet = new PatchSet();
  originalPatchSet.apply = async () => {
    await Promise.resolve();
    app.patches = replacementPatchSet;
    return new Blob([Uint8Array.from([4, 3, 2, 1, 5, 6, 7, 8])]);
  };
  const capabilityExecutor = createCapabilityExecutor({
    catalog: createCapabilityCatalog(), app, binaryId: () => liveBinding.binaryId,
  });
  const store = new ProposalStore({ evidenceStore, binding: () => liveBinding });
  const owner = new ProposalExecutor({ store, capabilityExecutor, app });
  const proposal = await owner.proposeCapability('patch.apply', {}, { evidenceIds: ['evidence'] });

  await assert.rejects(owner.approveAndApply(proposal.id), (error) => error?.type === 'scope_violation');
  assert.equal(store.get(proposal.id).status, 'failed');
  assert.equal(originalPatchSet.size, 1);
  assert.equal(replacementPatchSet.size, 0);

  originalPatchSet.apply = async () => {
    await Promise.resolve();
    return new Blob([Uint8Array.from([4, 3, 2, 1, 5, 6, 7, 8])]);
  };
  app.patches = originalPatchSet;
  const current = await owner.proposeCapability('patch.apply', {}, { evidenceIds: ['evidence'] });
  const result = await owner.approveAndApply(current.id);
  assert.equal(result.proposal.status, 'applied');
  assert.equal(result.execution.patches.length, 1);
  assert.equal(result.execution.patches[0].fileOffset, '0');
});
