import assert from 'node:assert/strict';

import { createAIRuntime } from '../../../js/ai/runtime.js';
import { createAiEngine } from '../../../js/ai/ui/bridge.js';

function createApp(label) {
  const values = new Map([
    ['fileInfo', { name: `${label}.bin` }],
    ['sliceIndex', 0],
    ['architecture', 'x86_64'],
  ]);
  const counters = { reads: 0, mutations: 0 };
  const project = { id: `project-${label}`, binary: { hash: `project-hash-${label}` } };
  return {
    project,
    workspace: { project, autosave() { counters.mutations++; } },
    backend: {
      contentHash: `content-hash-${label}`,
      async readAt() {
        counters.reads++;
        return { found: true, bytes: Uint8Array.from([0x90]) };
      },
    },
    store: { get(key) { return values.get(key); } },
    counters,
  };
}

function createCoreEngine(app) {
  return createAiEngine(app, {
    loadCore: (context) => createAIRuntime({ context, planner: false }),
  });
}

function isScopeViolation(error) {
  return error?.type === 'scope_violation';
}

const appA = createApp('A');
const appB = createApp('B');
const engineA = createCoreEngine(appA);
const engineB = createCoreEngine(appB);
const coreA = await engineA.runtime();
const coreB = await engineB.runtime();
assert.ok(coreA && coreB, 'both bridges must load their real AIRuntime core');

const storeA = engineA.proposals();
const storeB = engineB.proposals();
assert.ok(storeA && storeB);
assert.notEqual(storeA, storeB, 'different engines must own different proposal stores');

const evidence = coreA.evidenceStore.add({
  id: 'ev-bridge-store-scope', kind: 'analysis', status: 'supported',
  title: 'bridge store scope', sourceTool: 'focused-test',
});
assert.equal(evidence.id, 'ev-bridge-store-scope');
const proposalA = storeA.create({
  kind: 'patch', target: { address: '4096' }, before: [0x90], after: [0x91],
  evidenceIds: [evidence.id], reason: 'cross-engine scope regression',
});
assert.deepEqual(proposalA.binding, {
  binaryId: 'A.bin:0', projectId: 'project-A', runtimeSessionId: null,
}, 'the regression must use a live AIRuntime binding, not binding:null');

let approvalCalls = 0;
const approveA = storeA.approve.bind(storeA);
storeA.approve = (...args) => { approvalCalls++; return approveA(...args); };

// A live store from engine A must not be accepted by engine B. The rejection
// happens at bridge construction, before approval, backend reads, or mutation.
assert.throws(() => engineB.proposalExecutor(storeA), isScopeViolation);
assert.equal(approvalCalls, 0, 'foreign-store rejection must precede approval');
assert.equal(appB.counters.reads, 0, 'foreign-store rejection must precede current-state reads');
assert.equal(appB.counters.mutations, 0, 'foreign-store rejection must precede mutation');

// The canonical current store remains usable, both explicitly and through the
// null/default compatibility form used by the approval UI.
const currentExecutor = engineB.proposalExecutor(storeB);
assert.equal(currentExecutor.store, storeB);
assert.equal(engineB.proposalExecutor(null).store, storeB);
assert.equal(engineB.proposalExecutor().store, storeB);

// A second conversation namespace in the same AIRuntime is also foreign to the
// bridge's currently published store and must not be replayed through it.
const currentNamespace = coreA.storesFor({ id: 'conversation-current' }, 'A.bin:0');
assert.equal(currentNamespace.proposalStore, storeA);
const staleNamespace = coreA.storesFor({ id: 'conversation-stale' }, 'A.bin:0');
assert.notEqual(staleNamespace.proposalStore, storeA);
assert.throws(() => engineA.proposalExecutor(staleNamespace.proposalStore), isScopeViolation);

// Before core loading, no executor exists; an arbitrary explicit store is not
// silently accepted as a custom authority.
const unloaded = createAiEngine(createApp('unloaded'), { loadCore: () => null });
assert.equal(unloaded.proposalExecutor(), null);
assert.throws(() => unloaded.proposalExecutor({}), isScopeViolation);
await unloaded.runtime();
assert.equal(unloaded.proposalExecutor(), null);

console.log('bridge proposal store scope: PASS');
