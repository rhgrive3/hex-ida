// Regression for #6171: ProposalExecutor (and proposalArguments) normalized
// patch before/after bytes with a per-element `Number` coercion. Schema-invalid
// proposal bytes ('1', true, null, 257) were laundered into canonical numbers
// before the strict capability validator saw them, so a malformed approved
// patch executed as if it contained valid bytes. Byte identity is now
// validated at both normalization points instead of being coerced.
import assert from 'node:assert/strict';
import { ProposalStore } from '../js/ai/proposals.js';
import { ProposalExecutor } from '../js/ai/interaction/proposal-executor.js';

function patchStore() {
  const evidenceStore = { has: () => true, get: () => ({ id: 'ev1', status: 'verified' }) };
  return new ProposalStore({ evidenceStore, binding: () => ({ binaryId: 'fixture:1' }) });
}

const applied = [];
const capabilityExecutor = {
  async execute(capability, args) {
    applied.push({ capability, args });
    return { after: args.after, ok: true };
  },
};
const app = {
  backend: { async readAt() { return { found: true, bytes: [1] }; } },
};

async function expectRejected(name, before, after) {
  const store = patchStore();
  const proposal = store.create({
    kind: 'patch',
    target: { address: '0x1000' },
    before,
    after,
    evidenceIds: ['ev1'],
    reason: 'validity probe',
  });
  const executor = new ProposalExecutor({ store, capabilityExecutor, app });
  const appliedBefore = applied.length;
  await assert.rejects(
    () => executor.approveAndApply(proposal.id),
    (error) => error?.type === 'invalid_tool_call' || /non-byte|Array or Uint8Array/.test(error?.message || ''),
    `${name} must be rejected instead of laundered into canonical bytes`,
  );
  assert.equal(applied.length, appliedBefore, `${name} must never reach the mutation authority`);
}

// Element type and range remain strict.
await expectRejected('string bytes', ['1'], ['2']);
await expectRejected('boolean/null bytes', [true], [null]);
await expectRejected('out-of-range byte', [256], [0]);

// Only the two supported byte containers are accepted. Array.from() must not
// silently broaden this contract to array-like objects, Sets, or other views.
await expectRejected('array-like object', { 0: 1, length: 1 }, { 0: 2, length: 1 });
await expectRejected('Set bytes', new Set([1]), new Set([2]));
await expectRejected('Uint16Array bytes', new Uint16Array([1]), new Uint16Array([2]));
await expectRejected('scalar bytes', 1, 2);
await expectRejected('null bytes', null, null);

// Valid Array bytes keep working end to end.
{
  const store = patchStore();
  const proposal = store.create({
    kind: 'patch',
    target: { address: '0x1000' },
    before: [1],
    after: [2],
    evidenceIds: ['ev1'],
    reason: 'valid patch',
  });
  const executor = new ProposalExecutor({ store, capabilityExecutor, app });
  const { execution } = await executor.approveAndApply(proposal.id);
  assert.ok(execution, 'a valid Array patch still executes');
  assert.deepEqual(applied.at(-1)?.args?.before, [1]);
  assert.deepEqual(applied.at(-1)?.args?.after, [2]);
}

// Uint8Array is also part of the accepted internal contract. Its payload is
// canonicalized once so revision checks compare the same bytes returned by the
// backend and sent to the capability authority.
{
  const store = patchStore();
  const proposal = store.create({
    kind: 'patch',
    target: { address: '0x1000' },
    before: new Uint8Array([1]),
    after: new Uint8Array([2]),
    evidenceIds: ['ev1'],
    reason: 'valid typed patch',
  });
  const executor = new ProposalExecutor({ store, capabilityExecutor, app });
  const { execution } = await executor.approveAndApply(proposal.id);
  assert.ok(execution, 'a valid Uint8Array patch still executes');
  assert.deepEqual(applied.at(-1)?.args?.before, [1]);
  assert.deepEqual(applied.at(-1)?.args?.after, [2]);
}

console.log('issue #6171 strict patch-byte regressions PASS');
