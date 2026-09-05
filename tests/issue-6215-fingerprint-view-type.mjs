/**
 * #6215 regression: ProposalStore stale-state fingerprint must distinguish
 * typed-array/view kinds. Previously all ArrayBuffer/views shared one `y`
 * domain with raw bytes only, so Uint8Array and Uint32Array over the same
 * bytes aliased to the same revision.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ProposalStore } from '../js/ai/proposals.js';

const evidenceStore = { has: () => true };

function storeWithProposal(before) {
  const store = new ProposalStore({ evidenceStore });
  const proposal = store.create({
    kind: 'patch',
    before,
    after: { value: 'changed' },
    evidenceIds: ['e1'],
  });
  const { approvalToken } = store.approve(proposal.id);
  return { store, proposal, approvalToken };
}

test('#6215 Uint8Array vs Uint32Array over same bytes are different states', async () => {
  const buffer = Uint8Array.of(1, 2, 3, 4).buffer;
  const before = new Uint8Array(buffer);
  const current = new Uint32Array(buffer);
  const { store, proposal, approvalToken } = storeWithProposal(before);
  let applied = false;
  await assert.rejects(
    () => store.apply(proposal.id, {
      approvalToken,
      currentState: current,
      apply: async () => { applied = true; },
    }),
    (error) => error.type === 'tool_failed',
  );
  assert.equal(applied, false);
});

test('#6215 ArrayBuffer vs full-width Uint8Array view alias no more', async () => {
  const buffer = Uint8Array.of(9, 8, 7, 6).buffer;
  const { store, proposal, approvalToken } = storeWithProposal(buffer);
  let applied = false;
  await assert.rejects(
    () => store.apply(proposal.id, {
      approvalToken,
      currentState: new Uint8Array(buffer),
      apply: async () => { applied = true; },
    }),
    (error) => error.type === 'tool_failed',
  );
  assert.equal(applied, false);
});

test('#6215 DataView does not alias typed arrays', async () => {
  const buffer = Uint8Array.of(1, 2, 3, 4).buffer;
  const { store, proposal, approvalToken } = storeWithProposal(new Uint8Array(buffer));
  let applied = false;
  await assert.rejects(
    () => store.apply(proposal.id, {
      approvalToken,
      currentState: new DataView(buffer),
      apply: async () => { applied = true; },
    }),
    (error) => error.type === 'tool_failed',
  );
  assert.equal(applied, false);
});

test('#6215 same view type and bytes still applies', async () => {
  const before = new Uint8Array([1, 2, 3, 4]);
  const { store, proposal, approvalToken } = storeWithProposal(before);
  let applied = false;
  await store.apply(proposal.id, {
    approvalToken,
    currentState: new Uint8Array([1, 2, 3, 4]),
    apply: async () => { applied = true; },
  });
  assert.equal(applied, true);
});

test('#6215 byte change still rejected', async () => {
  const { store, proposal, approvalToken } = storeWithProposal(new Uint8Array([1, 2, 3, 4]));
  await assert.rejects(
    () => store.apply(proposal.id, {
      approvalToken,
      currentState: new Uint8Array([1, 2, 3, 5]),
      apply: async () => {},
    }),
    (error) => error.type === 'tool_failed',
  );
});

test('#6215 Float32Array vs Uint32Array alias no more', async () => {
  const buffer = new ArrayBuffer(4);
  new Uint32Array(buffer)[0] = 0x3f800000;
  const { store, proposal, approvalToken } = storeWithProposal(new Uint32Array(buffer));
  let applied = false;
  await assert.rejects(
    () => store.apply(proposal.id, {
      approvalToken,
      currentState: new Float32Array(buffer),
      apply: async () => { applied = true; },
    }),
    (error) => error.type === 'tool_failed',
  );
  assert.equal(applied, false);
});
