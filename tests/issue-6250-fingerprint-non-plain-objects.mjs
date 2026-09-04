/**
 * #6250 regression: the stale-state fingerprint must not collapse non-plain
 * built-in objects (RegExp etc.) whose meaningful state lives in internal
 * slots. `/alpha/g` and `/beta/i` both enumerated zero own keys, so the old
 * canonicalIdentity() encoded both as `o{}` and an approved proposal passed
 * its stale-state guard against a completely different current state.
 *
 * Policy: RegExp gets explicit domain separation (source + flags); every other
 * non-plain object fails closed instead of being silently plain-objectified.
 */
import assert from 'node:assert/strict';
import { EvidenceStore } from '../js/ai/evidence.js';
import { ProposalStore } from '../js/ai/proposals.js';

function storeWith() {
  const evidence = new EvidenceStore([{ id: 'ev_6250', kind: 'read', status: 'unknown', title: 'fixed' }]);
  return new ProposalStore({ evidenceStore: evidence });
}

function proposalFor(before, binding = null) {
  const store = new ProposalStore({ evidenceStore: new EvidenceStore([{ id: 'ev_6250', kind: 'read', status: 'unknown', title: 'fixed' }]), binding });
  const proposal = store.create({
    kind: 'rename', target: { at: '0x1000' }, before, after: 'renamed',
    reason: 'regression fixture', evidenceIds: ['ev_6250'],
  });
  const { approvalToken } = store.approve(proposal.id);
  return { store, proposal, approvalToken };
}

async function assertStale(before, currentState, label) {
  const { store, proposal, approvalToken } = proposalFor(before);
  await assert.rejects(
    () => store.apply(proposal.id, { approvalToken, currentState, apply: async () => {} }),
    /changed after it was created/,
    `${label} must be detected as a changed state (#6250)`,
  );
  assert.equal(store.get(proposal.id).status, 'failed');
}

/* 1. different RegExp state must not pass the stale-state guard */
await assertStale(/alpha/g, /beta/i, 'RegExp source change');
await assertStale(/alpha/g, /alpha/i, 'RegExp flags change');
await assertStale({ pattern: /alpha/g }, { pattern: /beta/i }, 'nested RegExp source change');

/* 2. identical RegExp state still applies (stable, deterministic match) */
{
  const { store, proposal, approvalToken } = proposalFor(/alpha/g);
  let applied = false;
  await store.apply(proposal.id, { approvalToken, currentState: /alpha/g, apply: async () => { applied = true; } });
  assert.ok(applied, 'identical RegExp state must still apply');
  assert.equal(store.get(proposal.id).status, 'applied');
}

/* 3. RegExp must not alias the plain-object or string encoding */
{
  const store = storeWith();
  const a = store.create({ kind: 'rename', target: {}, before: /alpha/g, after: 'x', evidenceIds: ['ev_6250'] });
  const b = store.create({ kind: 'rename', target: {}, before: {}, after: 'x', evidenceIds: ['ev_6250'] });
  const c = store.create({ kind: 'rename', target: {}, before: 'alpha', after: 'x', evidenceIds: ['ev_6250'] });
  assert.notEqual(a.revision, b.revision, 'RegExp must not fingerprint like an empty object');
  assert.notEqual(a.revision, c.revision, 'RegExp must not fingerprint like its source string');
}

/* 4. unsupported non-plain objects fail closed instead of silently encoding */
{
  class Custom { constructor() { this.value = 1; } }
  assert.throws(
    () => storeWith().create({ kind: 'rename', target: {}, before: new Custom(), after: 'x', evidenceIds: ['ev_6250'] }),
    /non-plain/,
    'custom class instances must be rejected, never plain-objectified',
  );
  // Boxed primitives carry state in internal slots and enumerate empty.
  assert.throws(
    () => storeWith().create({ kind: 'rename', target: {}, before: new String('secret'), after: 'x', evidenceIds: ['ev_6250'] }),
    /non-plain/,
    'boxed primitives must be rejected, never plain-objectified',
  );
}

/* 5. bindingRevision shares the same fail-closed policy */
{
  const evidence = new EvidenceStore([{ id: 'ev_b6250', kind: 'read', status: 'unknown', title: 'b' }]);
  let binding = { binaryId: 'bin-A' };
  const store = new ProposalStore({ evidenceStore: evidence, binding: () => binding });
  const proposal = store.create({ kind: 'rename', target: { at: '0x1000' }, before: 'a', after: 'b', reason: 'r', evidenceIds: ['ev_b6250'] });
  const { approvalToken } = store.approve(proposal.id);
  binding = { binaryId: /bin-A/ };
  await assert.rejects(
    () => store.apply(proposal.id, { approvalToken, currentState: 'a', apply: async () => {} }),
    /different binary, project, or runtime session/,
    'a RegExp smuggled into the binding object must not pass the scope guard (#6250)',
  );
}

/* 6. pre-existing plain-data fingerprints are unchanged */
{
  const one = storeWith().create({ kind: 'rename', target: {}, before: { a: [1, 'x', null], b: { c: true } }, after: 'x', evidenceIds: ['ev_6250'] });
  const two = storeWith().create({ kind: 'rename', target: {}, before: { b: { c: true }, a: [1, 'x', null] }, after: 'x', evidenceIds: ['ev_6250'] });
  assert.equal(one.revision, two.revision, 'plain JSON-like object fingerprints must stay stable');
  const bigintOne = storeWith().create({ kind: 'rename', target: {}, before: 1n, after: 'x', evidenceIds: ['ev_6250'] });
  const bigintTwo = storeWith().create({ kind: 'rename', target: {}, before: { $bigint: '1' }, after: 'x', evidenceIds: ['ev_6250'] });
  assert.notEqual(bigintOne.revision, bigintTwo.revision, '#1299 type-tag separation must not regress');
}

console.log('issue-6250-fingerprint-non-plain-objects: ok');
