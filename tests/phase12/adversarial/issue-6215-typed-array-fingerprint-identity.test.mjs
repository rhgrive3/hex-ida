import assert from 'node:assert/strict';
import { ProposalStore } from '../../../js/ai/proposals.js';
import { ProposalExecutor } from '../../../js/ai/interaction/proposal-executor.js';
import { CapabilityExecutor } from '../../../js/ai/capabilities/executor.js';
import { createCapabilityCatalog } from '../../../js/ai/capabilities/catalog.js';

const evidenceStore = Object.freeze({ has: (id) => id === 'e1' });
const proposalFor = (before) => new ProposalStore({ evidenceStore }).create({
  kind: 'project-annotation',
  target: { id: 'typed-state' },
  before,
  after: 'changed',
  evidenceIds: ['e1'],
});

// The fingerprint is stale-state authority, not a byte-only display digest.
// Equal backing bytes with a different binary view type are different states.
{
  const buffer = Uint8Array.of(1, 2, 3, 4).buffer;
  const u8 = proposalFor(new Uint8Array(buffer));
  const u32 = proposalFor(new Uint32Array(buffer));
  const dataView = proposalFor(new DataView(buffer));
  const arrayBuffer = proposalFor(buffer);
  assert.notEqual(u8.revision, u32.revision, 'Uint8Array and Uint32Array must not share a stale-state revision');
  assert.notEqual(u8.revision, dataView.revision, 'typed arrays and DataView must not share a stale-state revision');
  assert.notEqual(u8.revision, arrayBuffer.revision, 'ArrayBuffer and a view over it must not share a stale-state revision');
}

// Same semantic view type + same visible bytes remains deterministic, while a
// byte change still invalidates the revision.
{
  const first = proposalFor(Uint16Array.of(0x1234, 0xabcd));
  const same = proposalFor(Uint16Array.of(0x1234, 0xabcd));
  const changed = proposalFor(Uint16Array.of(0x1234, 0xabce));
  assert.equal(first.revision, same.revision, 'same typed-view state must fingerprint deterministically');
  assert.notEqual(first.revision, changed.revision, 'changed bytes must still change the stale-state revision');
}

// The public ProposalStore stale guard must reject a type-changed state before
// the mutation callback gains authority.
{
  const buffer = Uint8Array.of(1, 2, 3, 4).buffer;
  const store = new ProposalStore({ evidenceStore });
  const proposal = store.create({
    kind: 'project-annotation', target: { id: 'typed-state' },
    before: new Uint8Array(buffer), after: 'changed', evidenceIds: ['e1'],
  });
  const { approvalToken } = store.approve(proposal.id);
  let applied = false;
  await assert.rejects(
    () => store.apply(proposal.id, {
      approvalToken,
      currentState: new Uint32Array(buffer),
      apply: async () => { applied = true; },
    }),
    (error) => error?.type === 'tool_failed' && /changed after it was created/.test(error.message),
  );
  assert.equal(applied, false, 'a type-changed state must not reach the mutation callback');
  assert.equal(store.get(proposal.id).status, 'failed');
}

// Production project-annotation flow exposes arbitrary annotation values to
// ProposalExecutor.currentState(), so exercise the actual executor boundary as
// well: the mismatched typed view must be rejected before autosave/mutation.
{
  const buffer = Uint8Array.of(1, 2, 3, 4).buffer;
  const liveValue = new Uint32Array(buffer);
  let autosaves = 0;
  const app = {
    projectAnnotations: [{ id: 'typed-state', kind: 'note', value: liveValue }],
    autoReport: { report: { confirmed: [], deep: [] } },
    workspace: { async autosave() { autosaves += 1; return true; } },
  };
  const store = new ProposalStore({ evidenceStore });
  const proposal = store.create({
    kind: 'project-annotation', target: { id: 'typed-state' },
    before: new Uint8Array(buffer), after: 'changed', evidenceIds: ['e1'],
  });
  const executor = new ProposalExecutor({
    store,
    app,
    capabilityExecutor: new CapabilityExecutor({ catalog: createCapabilityCatalog(), app }),
  });
  await assert.rejects(
    () => executor.approveAndApply(proposal.id),
    (error) => error?.type === 'tool_failed' && /changed after it was created/.test(error.message),
  );
  assert.equal(app.projectAnnotations[0].value, liveValue, 'stale rejection must preserve the live annotation value');
  assert.equal(autosaves, 0, 'stale rejection must happen before persistence side effects');
}

// bindingRevision uses the same fingerprint authority. A binary-container type
// change in the bound execution context must therefore fail closed as a scope
// change too, rather than aliasing on equal raw bytes.
{
  const buffer = Uint8Array.of(9, 8, 7, 6).buffer;
  let binding = new Uint8Array(buffer);
  const store = new ProposalStore({ evidenceStore, binding: () => binding });
  const proposal = store.create({
    kind: 'comment', target: { address: '0x1000' },
    before: 'old', after: 'new', evidenceIds: ['e1'],
  });
  const { approvalToken } = store.approve(proposal.id);
  binding = new Uint32Array(buffer);
  let applied = false;
  await assert.rejects(
    () => store.apply(proposal.id, {
      approvalToken, currentState: 'old', apply: async () => { applied = true; },
    }),
    (error) => error?.type === 'scope_violation' && /different binary, project, or runtime session/.test(error.message),
  );
  assert.equal(applied, false, 'a type-changed binding must not reach mutation authority');
}

// #6171 deliberately canonicalizes patch Uint8Array/plain-array bytes to the
// same execution authority. Subtyping the generic binary fingerprint must not
// undo that patch-specific contract.
{
  const store = new ProposalStore({ evidenceStore });
  const proposal = store.create({
    kind: 'patch', target: { address: '0x1000' },
    before: Uint8Array.of(1, 2, 3, 4), after: Uint8Array.of(5, 6, 7, 8), evidenceIds: ['e1'],
  });
  const { approvalToken } = store.approve(proposal.id);
  let applied = false;
  await store.apply(proposal.id, {
    approvalToken,
    currentState: [1, 2, 3, 4],
    apply: async () => { applied = true; },
  });
  assert.equal(applied, true, 'canonical patch byte containers must remain equivalent');
}

console.log('issue-6215 typed-array fingerprint identity: ok');
