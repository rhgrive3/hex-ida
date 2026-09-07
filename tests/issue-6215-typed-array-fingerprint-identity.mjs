// Regression for #6215: the proposal stale-state fingerprint collapsed every
// ArrayBuffer/TypedArray/DataView into the same `y` payload of raw hex bytes,
// so a proposal approved against one representation applied cleanly against a
// different one over identical bytes (Uint8Array → Uint32Array, view →
// ArrayBuffer, Uint8Array → DataView, even a different length window). The
// canonical form now carries the view kind, element length and byte window, so
// the same bytes under a different representation are a different revision and
// the stale-state guard rejects the apply.
import assert from 'node:assert/strict';
import { ProposalStore } from '../js/ai/proposals.js';

const evidenceStore = { has: () => true };

async function attempt({ before, current }) {
  const store = new ProposalStore({ evidenceStore });
  const proposal = store.create({ kind: 'patch', before, after: { value: 'changed' }, evidenceIds: ['e1'] });
  const { approvalToken } = store.approve(proposal.id);
  let applied = false;
  let error = null;
  try {
    await store.apply(proposal.id, { approvalToken, currentState: current, apply: async () => { applied = true; } });
  } catch (caught) {
    error = caught;
  }
  return { applied, error };
}

const buffer = Uint8Array.of(1, 2, 3, 4).buffer;

{
  const { applied, error } = await attempt({ before: new Uint8Array(buffer), current: new Uint32Array(buffer) });
  assert.equal(applied, false, 'a Uint32Array over the approved bytes is a different state than a Uint8Array');
  assert.equal(error?.type, 'tool_failed');
}

{
  const { applied, error } = await attempt({ before: new Uint8Array(buffer), current: buffer.slice(0) });
  assert.equal(applied, false, 'a bare ArrayBuffer is a different state than a full-width view');
  assert.equal(error?.type, 'tool_failed');
}

{
  const { applied, error } = await attempt({ before: new Uint8Array(buffer), current: new DataView(buffer.slice(0)) });
  assert.equal(applied, false, 'a DataView is a different state than a typed array view');
  assert.equal(error?.type, 'tool_failed');
}

{
  const { applied, error } = await attempt({ before: new Uint8Array(buffer), current: new Uint8Array(buffer, 0, 2) });
  assert.equal(applied, false, 'a different byte window over the same buffer is a different state');
  assert.equal(error?.type, 'tool_failed');
}

{
  const { applied, error } = await attempt({ before: new Uint8Array(buffer), current: new Uint8Array(buffer.slice(0)) });
  assert.equal(applied, true, 'the same representation and byte window still applies');
  assert.equal(error, null);
}

{
  const { applied, error } = await attempt({ before: new Uint8Array(buffer), current: new Uint8Array(Uint8Array.of(9, 9, 9, 9).buffer) });
  assert.equal(applied, false, 'changed bytes stay rejected');
  assert.equal(error?.type, 'tool_failed');
}
