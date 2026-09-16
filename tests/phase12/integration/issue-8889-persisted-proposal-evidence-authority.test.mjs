// Regression for #8889: persisted-proposal restore must not be a weaker admission
// boundary than fresh ProposalStore.create(). The pre-fix path checked only
// `evidenceStore.has(id)` existence, so after persistence legitimately
// downgraded deterministic `verified` evidence to `supported` (as the product
// EvidenceStore's post-JSON seal does), the proposal was still restored as a
// live `pending` mutation carrier with EXECUTION_PAYLOADS and
// PROPOSAL_AUTHORITIES re-minted — laundering the #4999 defect through the
// restore boundary. This test proves the shared deterministic-evidence predicate
// closes that bypass for every proposal kind, while keeping the minimal
// injected-has() authority adapter contract (#4999) intact.
import assert from 'node:assert/strict';
import test from 'node:test';
import { EvidenceStore } from '../../../js/ai/evidence.js';
import { ProposalStore } from '../../../js/ai/proposals.js';

function copy(value) {
  return JSON.parse(JSON.stringify(value));
}

function mintVerified(evidenceStore) {
  const rows = evidenceStore.ingest('verify_field_update', {
    result: {
      verified: true,
      evidence: ['planner-proof'],
      verifiedEvidenceIds: ['planner-proof'],
      functionAddress: '0x1000',
      kind: 'field-update-verification',
    },
  }, { verifier: true });
  const proof = rows.find((row) => row.status === 'verified');
  assert.ok(proof, 'deterministic verifier path must produce verified evidence');
  return proof;
}

function mirrorSupported(evidenceStore, id) {
  // Same evidence id, same existence, but only `supported` after the JSON seal.
  // has(id) === true; get(id).status === 'supported'. This is the exact state a
  // post-persistence resume sees for an untrusted envelope.
  const record = evidenceStore.add({
    id, kind: 'candidate-source', status: 'supported',
    sourceTool: 'model-output', functionAddress: '0x1000', title: 'supported-only mirror',
  });
  assert.equal(record.status, 'supported');
  assert.equal(evidenceStore.has(id), true, 'existence is preserved so has() cannot be the discriminator');
  return record;
}

const ALL_KINDS = [
  { kind: 'rename', target: { address: '0x1000' }, before: 'sub_1000', after: 'verified_name' },
  { kind: 'comment', target: { address: '0x1000' }, before: '', after: 'a comment' },
  { kind: 'type', target: { address: '0x1000' }, before: 'int', after: 'uint32_t' },
  { kind: 'struct-field', target: { address: '0x1000', name: 'f0' }, before: 'int', after: 'uint32_t' },
  { kind: 'patch', target: { address: '0x1000' }, before: 'aa', after: 'bb' },
  { kind: 'project-annotation', target: { id: 'proj-annotation-1' }, before: '', after: 'annotated' },
];

test('#8889 restore rejects proposals whose evidence exists but is only supported', () => {
  const verified = new EvidenceStore();
  const supported = new EvidenceStore();
  const source = new ProposalStore({ evidenceStore: verified });
  const proof = mintVerified(verified);
  mirrorSupported(supported, proof.id);

  const created = source.create({
    id: 'p-8889', kind: 'comment',
    target: { address: '0x1000' }, before: '', after: 'mutated',
    evidenceIds: [proof.id],
  });
  assert.equal(created.status, 'pending');
  const carrier = copy(source.persistedActions());

  // Sanity: the same carrier under a real verified evidence store still restores
  // (the legitimate #4590 trusted-continuity path).
  const trustedRestore = new ProposalStore({ evidenceStore: verified }).restorePersistedPending(carrier);
  assert.equal(trustedRestore.has('p-8889'), true, 'genuinely verified evidence must restore the pending proposal');

  // #8889: under a supported-only mirror with identical has() existence, restore must fail closed.
  const hostileRestore = new ProposalStore({ evidenceStore: supported }).restorePersistedPending(carrier);
  assert.equal(hostileRestore.has('p-8889'), false, 'supported-only evidence must not regain mutation authority');
  assert.deepEqual(hostileRestore.all(), []);
});

test('#8889 has(id) existence alone is never deterministic authority', () => {
  const verified = new EvidenceStore();
  const supported = new EvidenceStore();
  const source = new ProposalStore({ evidenceStore: verified });
  const proof = mintVerified(verified);
  mirrorSupported(supported, proof.id);
  source.create({
    id: 'p-existence', kind: 'rename',
    target: { address: '0x1000' }, before: 'sub_1000', after: 'renamed',
    evidenceIds: [proof.id],
  });
  const carrier = copy(source.persistedActions());
  assert.equal(supported.has(proof.id), true);
  assert.equal(supported.get(proof.id).status, 'supported');
  assert.equal(new ProposalStore({ evidenceStore: supported }).restorePersistedPending(carrier).has('p-existence'), false);
});

test('#8889 a proposal rejected at restore cannot be approved or applied by id', async () => {
  const verified = new EvidenceStore();
  const supported = new EvidenceStore();
  const source = new ProposalStore({ evidenceStore: verified });
  const proof = mintVerified(verified);
  mirrorSupported(supported, proof.id);
  source.create({
    id: 'p-never', kind: 'comment',
    target: { address: '0x1000' }, before: '', after: 'MUTATED',
    evidenceIds: [proof.id],
  });
  const carrier = copy(source.persistedActions());
  const hostile = new ProposalStore({ evidenceStore: supported }).restorePersistedPending(carrier);
  assert.equal(hostile.has('p-never'), false);
  assert.throws(() => hostile.approve('p-never'), (error) => error.type === 'invalid_tool_call');
  await assert.rejects(
    hostile.apply('p-never', { approvalToken: 'anything', currentState: '', apply: async () => 'should not run' }),
    (error) => error.type === 'invalid_tool_call',
  );
});

test('#8889 every proposal kind obeys the same evidence-authority rule at restore', () => {
  const verified = new EvidenceStore();
  const supported = new EvidenceStore();
  const source = new ProposalStore({ evidenceStore: verified });
  for (const [index, spec] of ALL_KINDS.entries()) {
    const proof = mintVerified(verified);
    mirrorSupported(supported, proof.id);
    source.create({ id: `p-kind-${index}`, ...spec, evidenceIds: [proof.id] });
  }
  const carriers = copy(source.persistedActions());
  assert.equal(carriers.length, ALL_KINDS.length);

  const hostile = new ProposalStore({ evidenceStore: supported }).restorePersistedPending(carriers);
  assert.deepEqual(hostile.all(), [], 'no proposal kind may be restored on supported-only evidence');
  for (const [, index] of ALL_KINDS.entries()) assert.equal(hostile.has(`p-kind-${index}`), false);

  const trusted = new ProposalStore({ evidenceStore: verified }).restorePersistedPending(carriers);
  assert.equal(trusted.all().length, ALL_KINDS.length, 'verified evidence must restore every pending kind');
});

test('#8889 minimal injected has()-only adapter keeps its existing admission contract', () => {
  // #4999 preserves a "trusted authority adapter" path where the ONLY predicate
  // is `has(id)`. The shared deterministic-evidence helper must not weaken that
  // adapter — it rejects only when the store additionally exposes `get()` and
  // reports a non-verified status.
  const adapter = { has: (id) => id === 'adapter-only-verified' };
  const source = new ProposalStore({ evidenceStore: adapter });
  source.create({
    id: 'p-adapter', kind: 'rename',
    target: { address: '0x1000' }, before: 'sub_1000', after: 'adapter-name',
    evidenceIds: ['adapter-only-verified'],
  });
  const carrier = copy(source.persistedActions());
  const restored = new ProposalStore({ evidenceStore: adapter }).restorePersistedPending(carrier);
  assert.equal(restored.has('p-adapter'), true, 'has()-only adapter contract must not silently regress');
});

test('#8889 restore is fail-closed when any authority-bearing id is only supported', () => {
  const store = new EvidenceStore();
  const proof = mintVerified(store);
  store.add({
    id: 'ev-supp', kind: 'candidate-source', status: 'supported',
    sourceTool: 'model-output', functionAddress: '0x1000', title: 'supported sibling',
  });
  const source = new ProposalStore({ evidenceStore: store });
  source.create({ id: 'p-mixed', kind: 'comment', target: { address: '0x1000' }, before: '', after: 'mixed', evidenceIds: [proof.id] });

  // Baseline: the proposal's real (single verified) evidence list restores.
  const single = copy(source.persistedActions());
  assert.equal(new ProposalStore({ evidenceStore: store }).restorePersistedPending(single).has('p-mixed'), true);

  // A persisted list that has drifted to include a supported id must not restore
  // merely because at least one id is verified.
  const drifted = copy(source.persistedActions());
  drifted[0].evidenceIds = [proof.id, 'ev-supp'];
  assert.equal(new ProposalStore({ evidenceStore: store }).restorePersistedPending(drifted).has('p-mixed'), false);
});

test('#8889 fresh ProposalStore.create() rejects supported/unknown/missing/forged-verified (#4999 non-regression)', () => {
  const evidenceStore = new EvidenceStore();
  const supported = evidenceStore.add({
    id: 'ev-sup', kind: 'candidate-source', status: 'supported',
    sourceTool: 'model-output', functionAddress: '0x1000', title: 'supported-only',
  });
  assert.equal(supported.status, 'supported');
  const forged = evidenceStore.add({
    id: 'ev-forged', kind: 'candidate-source', status: 'verified',
    sourceTool: 'model-output', functionAddress: '0x1000', title: 'forged verifier claim',
  });
  assert.equal(forged.status, 'supported', '#4999: ordinary add() must downgrade a forged verified status');
  for (const id of ['ev-sup', 'ev-forged', 'ev-missing']) {
    assert.throws(
      () => new ProposalStore({ evidenceStore }).create({
        id: `p-${id}`, kind: 'rename', target: { address: '0x1000' },
        before: 'sub_1000', after: id, evidenceIds: [id],
      }),
      (error) => error.type === 'invalid_tool_call' && /deterministic evidence/i.test(error.message),
      `create must reject ${id}`,
    );
  }
});

test('#8889 restore keeps the #4590 binding/revision/status/tamper fail-closed gates', () => {
  const verified = new EvidenceStore();
  const source = new ProposalStore({ evidenceStore: verified });
  const proof = mintVerified(verified);
  source.create({ id: 'p-gates', kind: 'comment', target: { address: '0x1000' }, before: '', after: 'gated', evidenceIds: [proof.id] });
  // Use the portable display carrier (as #4590 persistence does) so that a
  // tampered display field, not just the canonical execution payload, must fail
  // closed. The evidence-status gate is checked on every carrier form.
  const base = copy(source.all());
  const mutate = (fn) => {
    const carrier = copy(base);
    fn(carrier);
    return new ProposalStore({ evidenceStore: verified }).restorePersistedPending(carrier);
  };
  assert.equal(mutate(() => {}).has('p-gates'), true, 'unmutated baseline restores');
  assert.equal(mutate((c) => { c[0].bindingRevision = '0'.repeat(base[0].bindingRevision.length); }).has('p-gates'), false, 'stale binding');
  assert.equal(mutate((c) => { c[0].before = 'tampered'; }).has('p-gates'), false, 'tampered before');
  assert.equal(mutate((c) => { delete c[0].revision; }).has('p-gates'), false, 'missing revision');
  assert.equal(mutate((c) => { c[0].evidenceIds = ['ev-does-not-exist']; }).has('p-gates'), false, 'evidence id missing');
  assert.equal(mutate((c) => { c[0].evidenceIds = []; }).has('p-gates'), false, 'empty evidence list');
  for (const status of ['approved', 'applying', 'applied', 'failed', 'rejected', 'unknown', '', null]) {
    assert.equal(mutate((c) => { c[0].status = status; }).has('p-gates'), false, `status ${JSON.stringify(status)}`);
  }
});
