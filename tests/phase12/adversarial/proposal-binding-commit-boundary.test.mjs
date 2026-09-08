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
    kind: 'project-annotation',
    target: { id: 'async-binding' },
    before: null,
    after: 'approved',
    evidenceIds: ['evidence'],
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
  assert.equal(store.get(proposal.id).status, 'failed', 'binding drift must not publish an applied proposal');
});

test('patch creation rejects a replaced patch set before adding to the target', async () => {
  const liveBinding = binding('bin-a');
  let readCount = 0;
  const bytes = Uint8Array.from([1, 2, 3, 4]);
  const originalPatchSet = new PatchSet();
  const replacementPatchSet = new PatchSet();
  let app;
  app = patchApp(async () => {
    readCount += 1;
    // ProposalExecutor.currentState() performs the first read. The second is
    // validatePatchTarget() after authorization has been consumed, so this
    // replaces the target in the real async-to-mutation window while the
    // binary/project/session binding remains unchanged.
    if (readCount === 2) app.patches = replacementPatchSet;
    return { found: true, bytes };
  });
  app.patches = originalPatchSet;
  const catalog = createCapabilityCatalog();
  const capabilityExecutor = createCapabilityExecutor({
    catalog,
    app,
    binaryId: () => liveBinding.binaryId,
  });
  const store = new ProposalStore({ evidenceStore, binding: () => liveBinding });
  const owner = new ProposalExecutor({ store, capabilityExecutor, app });
  const proposal = store.create({
    kind: 'patch',
    target: { address: '4096' },
    before: [1, 2, 3, 4],
    after: [4, 3, 2, 1],
    evidenceIds: ['evidence'],
  });

  await assert.rejects(owner.approveAndApply(proposal.id), (error) => error?.type === 'scope_violation');
  assert.equal(readCount, 2, 'the context switch must occur in the validation read');
  assert.equal(originalPatchSet.size, 0, 'the replaced target must not receive a patch');
  assert.equal(replacementPatchSet.size, 0, 'the current target must not receive a stale patch');
  assert.equal(store.get(proposal.id).status, 'failed');

  // A current, approved mutation still reaches the real PatchSet adapter.
  app.patches = originalPatchSet;
  const current = store.create({
    kind: 'patch',
    target: { address: '4096' },
    before: [1, 2, 3, 4],
    after: [4, 3, 2, 1],
    evidenceIds: ['evidence'],
  });
  const result = await owner.approveAndApply(current.id);
  assert.equal(result.proposal.status, 'applied');
  assert.equal(originalPatchSet.size, 1);
  assert.equal(replacementPatchSet.size, 0);
});

test('runtime memory write rechecks the captured session target before writing', async () => {
  const liveBinding = runtimeBinding('bin-a', 'session-a');
  let readCount = 0;
  let oldWriteCount = 0;
  let replacementWriteCount = 0;
  let memory = Uint8Array.from([1, 2, 3, 4]);
  let activeSession;
  const adapter = {
    async readMemory(_address, size) {
      readCount += 1;
      const result = memory.slice(0, size);
      // The fourth read is boundedMemoryWrite()'s expected-before read. The
      // earlier three belong to proposal creation/current-state checks.
      if (readCount === 4) activeSession = { id: 'session-b', binaryHash: 'bin-a', adapter: replacementAdapter };
      return result;
    },
    async writeMemory(_address, bytes) {
      oldWriteCount += 1;
      memory = Uint8Array.from(bytes);
    },
  };
  const replacementAdapter = {
    async readMemory(_address, size) { return memory.slice(0, size); },
    async writeMemory(_address, bytes) {
      replacementWriteCount += 1;
      memory = Uint8Array.from(bytes);
    },
  };
  activeSession = { id: 'session-a', binaryHash: 'bin-a', adapter };
  const runtimePlatform = {
    currentSession: () => activeSession,
  };
  const catalog = createCapabilityCatalog();
  const capabilityExecutor = createCapabilityExecutor({
    catalog,
    runtimePlatform,
    binaryId: () => liveBinding.binaryId,
  });
  const store = new ProposalStore({ evidenceStore, binding: () => liveBinding });
  const owner = new ProposalExecutor({ store, capabilityExecutor });
  const args = {
    runtimeSessionId: 'session-a',
    binaryId: 'bin-a',
    address: '4096',
    expectedBefore: [1, 2, 3, 4],
    bytes: [9, 8, 7, 6],
  };
  const proposal = await owner.proposeCapability('runtime.memory-write', args, { evidenceIds: ['evidence'] });

  await assert.rejects(owner.approveAndApply(proposal.id), (error) => error?.type === 'scope_violation');
  assert.equal(readCount, 4, 'the switch must occur at the write adapter boundary');
  assert.equal(oldWriteCount, 0, 'a session switch after expected-before must prevent the old adapter write');
  assert.equal(replacementWriteCount, 0, 'a session switch must not write through the replacement adapter');
  assert.deepEqual([...memory], [1, 2, 3, 4]);
  assert.equal(store.get(proposal.id).status, 'failed');
});

test('patch application rejects a replaced patch set and preserves a valid awaited mutation', async () => {
  const liveBinding = binding('bin-a');
  const app = patchApp(async () => ({ found: true, bytes: Uint8Array.from([1, 2, 3, 4]) }));
  const originalPatchSet = app.patches;
  originalPatchSet.add(0n, [1, 2, 3, 4], [4, 3, 2, 1], { addr: 4096n });
  const replacementPatchSet = new PatchSet();
  originalPatchSet.apply = async () => {
    await Promise.resolve();
    // Replace the live target after the async read to model a context refresh.
    // The adapter must reject before publishing the old target's output.
    app.patches = replacementPatchSet;
    return new Blob([Uint8Array.from([4, 3, 2, 1, 5, 6, 7, 8])]);
  };
  const catalog = createCapabilityCatalog();
  const capabilityExecutor = createCapabilityExecutor({
    catalog,
    app,
    binaryId: () => liveBinding.binaryId,
  });
  const store = new ProposalStore({ evidenceStore, binding: () => liveBinding });
  const owner = new ProposalExecutor({ store, capabilityExecutor, app });
  const proposal = await owner.proposeCapability('patch.apply', {}, { evidenceIds: ['evidence'] });

  await assert.rejects(owner.approveAndApply(proposal.id), (error) => error?.type === 'scope_violation');
  assert.equal(store.get(proposal.id).status, 'failed');
  assert.equal(originalPatchSet.size, 1, 'the old target remains unchanged by a rejected publication');
  assert.equal(app.patches, replacementPatchSet);
  assert.equal(replacementPatchSet.size, 0, 'the refreshed patch set must not receive the old target metadata');

  // A valid async PatchSet.apply still publishes the approved target result.
  originalPatchSet.apply = async () => {
    await Promise.resolve();
    return new Blob([Uint8Array.from([4, 3, 2, 1, 5, 6, 7, 8])]);
  };
  app.patches = originalPatchSet;
  const current = await owner.proposeCapability('patch.apply', {}, { evidenceIds: ['evidence'] });
  const result = await owner.approveAndApply(current.id);
  assert.equal(result.proposal.status, 'applied');
  assert.equal(result.execution.patches.length, 1, 'publication must describe the retained target');
  assert.equal(result.execution.patches[0].fileOffset, '0');
});
