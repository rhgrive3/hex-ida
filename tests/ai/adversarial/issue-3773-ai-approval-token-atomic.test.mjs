import assert from 'node:assert/strict';
import { ProposalStore } from '../../../js/ai/proposals.js';

const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');

function replaceCrypto(value) {
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    writable: true,
    value,
  });
}

const store = new ProposalStore({
  evidenceStore: { has: (id) => id === 'evidence-1' },
});
const proposal = store.create({
  id: 'proposal-3773',
  kind: 'comment',
  evidenceIds: ['evidence-1'],
  target: { address: '0x1000' },
  before: null,
  after: 'note',
});

try {
  replaceCrypto(undefined);
  assert.throws(
    () => store.approve(proposal.id),
    (error) => error?.code === 'tool_failed' && /Secure randomness/.test(error?.message || ''),
  );
  assert.equal(store.get(proposal.id).status, 'pending');
  assert.equal(store.approvals.has(proposal.id), false);
  assert.equal(store.audit.filter((event) => event.type === 'proposal-approved').length, 0);

  replaceCrypto({
    randomUUID() {
      throw new Error('rng-failed');
    },
  });
  assert.throws(() => store.approve(proposal.id), /rng-failed/);
  assert.equal(store.get(proposal.id).status, 'pending');
  assert.equal(store.approvals.has(proposal.id), false);
  assert.equal(store.audit.filter((event) => event.type === 'proposal-approved').length, 0);

  replaceCrypto({
    randomUUID() {
      return 'approval-test-token';
    },
  });
  const approved = store.approve(proposal.id);
  assert.equal(approved.proposal, proposal);
  assert.equal(approved.approvalToken, 'approval-test-token');
  assert.equal(store.get(proposal.id).status, 'approved');
  assert.equal(store.approvals.get(proposal.id), 'approval-test-token');
  assert.equal(store.audit.filter((event) => event.type === 'proposal-approved').length, 1);
} finally {
  if (originalCrypto) Object.defineProperty(globalThis, 'crypto', originalCrypto);
  else delete globalThis.crypto;
}

console.log('[phase12] issue #3773 approval-token atomicity passed');
