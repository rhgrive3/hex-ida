import assert from 'node:assert/strict';
import { ProposalStore } from '../../../js/ai/proposals.js';

const evidenceStore = Object.freeze({ has: (id) => id === 'e1' });
const proposalFor = (before) => new ProposalStore({ evidenceStore }).create({
  kind: 'project-annotation',
  target: { id: 'typed-state' },
  before,
  after: 'changed',
  evidenceIds: ['e1'],
});

function spoofTypedArrayTag(value, tag) {
  // Keep the forged tag off the view itself so #5945's existing own-symbol
  // rejection does not mask the #6215 subtype-authority bug. Object#toString
  // still observes the inherited tag, while intrinsic TypedArray slots do not.
  const spoofedPrototype = Object.create(Object.getPrototypeOf(value));
  Object.defineProperty(spoofedPrototype, Symbol.toStringTag, { value: tag });
  Object.setPrototypeOf(value, spoofedPrototype);
  return value;
}

// A caller-controlled @@toStringTag must not let same-byte Uint8Array state
// impersonate the approved Uint32Array before mutation authority is issued.
{
  const bytes = Uint8Array.of(1, 2, 3, 4);
  const store = new ProposalStore({ evidenceStore });
  const proposal = store.create({
    kind: 'project-annotation', target: { id: 'typed-state' },
    before: new Uint32Array(bytes.buffer), after: 'changed', evidenceIds: ['e1'],
  });
  const { approvalToken } = store.approve(proposal.id);
  const currentState = spoofTypedArrayTag(new Uint8Array(bytes.buffer), 'Uint32Array');
  assert.equal(Object.prototype.toString.call(currentState), '[object Uint32Array]', 'fixture must spoof Object#toString');
  let applied = false;
  await assert.rejects(
    () => store.apply(proposal.id, {
      approvalToken,
      currentState,
      apply: async () => { applied = true; },
    }),
    (error) => error?.type === 'tool_failed' && /changed after it was created/.test(error.message),
  );
  assert.equal(applied, false, 'spoofed current state must fail before the mutation callback');
}

// bindingRevision is the same authority boundary: an inherited tag must not
// disguise a Uint8Array binding as the approved same-byte Uint32Array binding.
{
  const bytes = Uint8Array.of(9, 8, 7, 6);
  let binding = new Uint32Array(bytes.buffer);
  const store = new ProposalStore({ evidenceStore, binding: () => binding });
  const proposal = store.create({
    kind: 'comment', target: { address: '0x1000' },
    before: 'old', after: 'new', evidenceIds: ['e1'],
  });
  const { approvalToken } = store.approve(proposal.id);
  binding = spoofTypedArrayTag(new Uint8Array(bytes.buffer), 'Uint32Array');
  let applied = false;
  await assert.rejects(
    () => store.apply(proposal.id, {
      approvalToken,
      currentState: 'old',
      apply: async () => { applied = true; },
    }),
    (error) => error?.type === 'scope_violation' && /different binary, project, or runtime session/.test(error.message),
  );
  assert.equal(applied, false, 'spoofed binding must fail before mutation authority');
}

// View bounds are representation state too. Equal visible bytes at a different
// byteOffset must not share a revision even when the intrinsic view kind matches.
{
  const first = proposalFor(new Uint8Array(Uint8Array.of(1, 2, 0).buffer, 0, 2));
  const shifted = proposalFor(new Uint8Array(Uint8Array.of(0, 1, 2).buffer, 1, 2));
  assert.notEqual(first.revision, shifted.revision, 'typed-view byteOffset must participate in stale-state identity');
}

console.log('issue-6215 intrinsic typed-array identity: ok');
