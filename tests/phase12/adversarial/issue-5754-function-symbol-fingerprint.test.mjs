// Regression for #5754: canonicalIdentity() mapped functions and symbols into
// the `x` domain via String(value), so distinct closures (same source text,
// different captures) and distinct symbols (same description) aliased into one
// revision fingerprint. The state/binding paths that bypass the create-time
// structured-clone gate (bindingRevision at create and apply) could therefore
// accept a changed binding as "the same" approved state. Function and symbol
// values are now refused fail-closed; JSON/BigInt/Date/Map/Set/typed-array
// states keep their stable fingerprints, and one-shot approval semantics are
// untouched.
import assert from 'node:assert/strict';
import { ProposalStore } from '../../../js/ai/proposals.js';

const evidenceStore = { has: () => true };

async function applyWithBinding({ bindingValue, applyBindingValue, currentState = Uint8Array.of(1) }) {
  let current = bindingValue;
  const store = new ProposalStore({ evidenceStore, binding: () => current });
  let proposal = null;
  let createError = null;
  try {
    proposal = store.create({ kind: 'patch', before: Uint8Array.of(1), after: Uint8Array.of(2), evidenceIds: ['e1'] });
  } catch (caught) { createError = caught; }
  if (createError) return { createFailed: true, createError, applied: false, error: null };
  const { approvalToken } = store.approve(proposal.id);
  current = applyBindingValue;
  let applied = false;
  let error = null;
  try {
    await store.apply(proposal.id, { approvalToken, currentState, apply: async () => { applied = true; } });
  } catch (caught) { error = caught; }
  return { createFailed: proposal.status === 'failed', applied, error };
}

function assertCreateFingerprintRejection(result, label) {
  assert.ok(result.createError, `${label} must fail during create, before approval`);
  assert.equal(result.createError.name, 'AIError', `${label} must use the public AI error type`);
  assert.equal(result.createError.type, 'tool_failed', `${label} must fail in the tool_failed domain`);
  assert.match(result.createError.message, /function or symbol values/, `${label} must report the unsupported identity value`);
  assert.equal(result.applied, false, `${label} must not invoke the mutation adapter`);
}

// 1: two closures with identical source text but different captures must not
// alias — the create itself fails closed (option 1 of the issue).
{
  const make = (value) => () => value;
  const result = await applyWithBinding({ bindingValue: make(1), applyBindingValue: make(2) });
  assertCreateFingerprintRejection(result, 'a function-valued binding');
}

// 2: distinct symbols with the same description must not alias.
{
  const result = await applyWithBinding({ bindingValue: Symbol('bind'), applyBindingValue: Symbol('bind') });
  assertCreateFingerprintRejection(result, 'a symbol-valued binding');
}

// 2b: a nested function/symbol inside an object binding must also be refused.
{
  const make = (value) => () => value;
  const nestedFunction = await applyWithBinding({ bindingValue: { fn: make(1) }, applyBindingValue: { fn: make(2) } });
  assertCreateFingerprintRejection(nestedFunction, 'a nested function inside the binding');
  const nestedSymbol = await applyWithBinding({ bindingValue: { symbol: Symbol('bind') }, applyBindingValue: { symbol: Symbol('bind') } });
  assertCreateFingerprintRejection(nestedSymbol, 'a nested symbol inside the binding');
}

// 3: deterministically serializable states keep their stable fingerprints.
{
  const store = new ProposalStore({ evidenceStore, binding: () => ({ binaryId: 'bin-A' }) });
  const before = { when: new Date(0), big: 255n, map: new Map([['a', 1n]]), set: new Set([2n]), bytes: Uint8Array.of(5, 6), text: 'x' };
  const proposal = store.create({ kind: 'rename', target: { address: '0x1000' }, before, after: 'new-name', evidenceIds: ['e1'] });
  const { approvalToken } = store.approve(proposal.id);
  const result = await store.apply(proposal.id, {
    approvalToken,
    currentState: { when: new Date(0), big: 255n, map: new Map([['a', 1n]]), set: new Set([2n]), bytes: Uint8Array.of(5, 6), text: 'x' },
    apply: async () => {},
  });
  assert.equal(result.status, 'applied', 'serializable state still fingerprints stably');
}

// 3b: changed serializable state stays rejected (rename kind; patch bytes
// carry their own #6215/#6171 container contract, covered by those
// regressions on their own branches).
{
  const store = new ProposalStore({ evidenceStore, binding: () => ({ binaryId: 'bin-A' }) });
  const before = { when: new Date(0), big: 255n, map: new Map([['a', 1n]]), set: new Set([2n]), bytes: Uint8Array.of(5, 6), text: 'x' };
  const proposal = store.create({ kind: 'rename', target: { address: '0x1000' }, before, after: 'new-name', evidenceIds: ['e1'] });
  const { approvalToken } = store.approve(proposal.id);
  await assert.rejects(
    () => store.apply(proposal.id, {
      approvalToken,
      currentState: { when: new Date(1), big: 255n, map: new Map([['a', 1n]]), set: new Set([2n]), bytes: Uint8Array.of(5, 6), text: 'x' },
      apply: async () => {},
    }),
    (error) => error?.type === 'tool_failed',
    'changed state remains stale-rejected',
  );
  await assert.rejects(
    () => store.apply(proposal.id, {
      approvalToken,
      currentState: { when: new Date(0), big: 255n, map: new Map([['a', 1n]]), set: new Set([2n]), bytes: Uint8Array.of(5, 6), text: 'x' },
      apply: async () => {},
    }),
    (error) => error?.type === 'approval_required',
    'the approval token must be consumed when stale-state validation rejects the proposal',
  );
}

// 4: the same policy guards the apply-time binding re-check (create under a
// plain binding, then swap in a function binding afterwards).
{
  let current = { binaryId: 'bin-A' };
  const store = new ProposalStore({ evidenceStore, binding: () => current });
  const before = { when: new Date(0), big: 255n };
  const proposal = store.create({ kind: 'rename', target: { address: '0x1000' }, before, after: 'new-name', evidenceIds: ['e1'] });
  const { approvalToken } = store.approve(proposal.id);
  current = () => 1;
  await assert.rejects(
    () => store.apply(proposal.id, { approvalToken, currentState: { when: new Date(0), big: 255n }, apply: async () => {} }),
    (error) => error?.type === 'tool_failed',
    'a function binding introduced after approval cannot pass the binding revision check',
  );
  assert.equal(store.get(proposal.id).status, 'failed', 'the proposal is failed, not silently applied');
}

// 5: one-shot approval semantics survive the guard (rename kind, see 3b).
{
  const store = new ProposalStore({ evidenceStore, binding: () => ({ binaryId: 'bin-A' }) });
  const before = { when: new Date(0), big: 255n };
  const proposal = store.create({ kind: 'rename', target: { address: '0x1000' }, before, after: 'new-name', evidenceIds: ['e1'] });
  const { approvalToken } = store.approve(proposal.id);
  await store.apply(proposal.id, { approvalToken, currentState: { when: new Date(0), big: 255n }, apply: async () => {} });
  await assert.rejects(
    () => store.apply(proposal.id, { approvalToken, currentState: { when: new Date(0), big: 255n }, apply: async () => {} }),
    (error) => error?.type === 'approval_required',
    'a consumed approval token cannot be reused',
  );
}

console.log('issue #5754 function/symbol fingerprint refusal: PASS');
