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
  await assert.rejects(
    () => executor.approveAndApply(proposal.id),
    (error) => error?.code === 'invalid_tool_call' || error?.type === 'invalid_tool_call' || /non-byte/.test(error?.message || ''),
    `${name} must be rejected instead of laundered into canonical bytes`,
  );
  assert.equal(applied.length, 0, `${name} must never reach the mutation authority`);
}

{
  // The issue's example: string bytes.
  await expectRejected('string bytes', ['1'], ['2']);
}
{
  // Booleans and null launder through Number() as 1/0.
  await expectRejected('boolean/null bytes', [true], [null]);
}
{
  // Out-of-range numbers are not bytes either.
  await expectRejected('out-of-range byte', [256], [0]);
}
{
  // Valid byte arrays keep working end to end.
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
  assert.ok(execution, 'a valid patch still executes');
  assert.deepEqual(applied[0]?.args?.before, [1]);
  assert.deepEqual(applied[0]?.args?.after, [2]);
}
