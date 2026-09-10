/* #5133 regression: a proposal whose mutation applied but whose postcondition
   could not be verified must not be recorded as a plain "failed = nothing
   changed" outcome. The verification-throw path carries an indeterminate
   marker (`partial`) on the proposal record and in the audit trail, while a
   definitive postcondition mismatch stays a hard failure. */
import assert from 'node:assert/strict';
import test from 'node:test';

import { ProposalStore } from '../../../js/ai/proposals.js';
import { ProposalExecutor } from '../../../js/ai/interaction/proposal-executor.js';
import { CapabilityExecutor } from '../../../js/ai/capabilities/executor.js';

const evidenceStore = { has: (id) => id === 'ev' };
const catalog = { get: (id) => (id === 'annotation.comment' ? { id, agentExposed: true, inputSchema: { type: 'object' } } : null) };

function commentApp({ readback }) {
  let comment = 'old';
  let reads = 0;
  return {
    app: {
      notes: {
        comment: () => { reads += 1; return readback(reads, comment); },
        setComment: (_address, value) => { comment = value; },
      },
    },
    state: () => comment,
  };
}

test('#5133 postcondition readback failure after an applied mutation records the proposal as partial', async () => {
  // reads: 1 = pre-approve currentState, 2 = executor mutation snapshot,
  // 3 = verifyPostcondition live read (must fail after the write landed).
  const { app, state } = commentApp({
    readback: (reads, comment) => {
      if (reads >= 3) throw new Error('comment readback temporarily unavailable');
      return comment;
    },
  });
  const store = new ProposalStore({ evidenceStore });
  const executor = new ProposalExecutor({ store, app, capabilityExecutor: new CapabilityExecutor({ catalog, app }) });
  const proposal = store.create({ kind: 'comment', target: { address: '0x1000' }, before: 'old', after: 'fresh note', evidenceIds: ['ev'] });

  let error = null;
  try {
    await executor.approveAndApply(proposal.id);
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, 'an unverifiable postcondition must reject');
  assert.equal(error.type, 'tool_failed');
  assert.match(error.message, /could not be verified/);

  assert.equal(state(), 'fresh note', 'the mutation did apply — the failure is in verification only');
  const record = store.get(proposal.id);
  assert.equal(record.status, 'failed');
  assert.equal(record.partial, true, 'an applied-but-unverifiable mutation must be recorded as partial, not as no-change');
  assert.equal(error.details.verification, 'indeterminate');
  assert.match(error.details.cause, /readback temporarily unavailable/);
  assert.match(error.details.mutationResult, /"ok":true/, 'the applied mutation result must be preserved for the audit trail');
  const partialAudit = store.audit.filter((entry) => entry.type === 'proposal-partial');
  assert.equal(partialAudit.length, 1, 'the audit trail must carry exactly one partial marker');
  assert.match(partialAudit[0].reason, /readback temporarily unavailable/);
});

test('#5133 a definitive postcondition mismatch stays a hard failure without the partial marker', async () => {
  const { app } = commentApp({
    readback: (reads, comment) => (reads >= 3 ? 'stale readback value' : comment),
  });
  const store = new ProposalStore({ evidenceStore });
  const executor = new ProposalExecutor({ store, app, capabilityExecutor: new CapabilityExecutor({ catalog, app }) });
  const proposal = store.create({ kind: 'comment', target: { address: '0x1000' }, before: 'old', after: 'fresh note', evidenceIds: ['ev'] });

  await assert.rejects(
    () => executor.approveAndApply(proposal.id),
    (caught) => caught.type === 'tool_failed' && /Postcondition verification failed/.test(caught.message),
  );

  const record = store.get(proposal.id);
  assert.equal(record.status, 'failed');
  assert.equal(record.partial, undefined, 'a verifiable mismatch is not an indeterminate outcome');
  assert.equal(store.audit.some((entry) => entry.type === 'proposal-partial'), false, 'a verifiable mismatch is not an indeterminate outcome');
});

test('#5133 a verified mutation still applies cleanly with no partial marker', async () => {
  const { app, state } = commentApp({
    readback: (reads, comment) => comment,
  });
  const store = new ProposalStore({ evidenceStore });
  const executor = new ProposalExecutor({ store, app, capabilityExecutor: new CapabilityExecutor({ catalog, app }) });
  const proposal = store.create({ kind: 'comment', target: { address: '0x1000' }, before: 'old', after: 'fresh note', evidenceIds: ['ev'] });

  const result = await executor.approveAndApply(proposal.id);
  assert.equal(result.proposal.status, 'applied');
  assert.equal(state(), 'fresh note');
  assert.equal(result.proposal.partial, undefined);
  assert.equal(store.audit.some((entry) => entry.type === 'proposal-partial'), false);
});
