import { EvidenceStore } from '../../../js/ai/evidence.js';
import { ProposalStore, proposalArguments } from '../../../js/ai/proposals.js';

const kinds = {
  'annotation.rename': 'rename',
  'annotation.comment': 'comment',
  'annotation.set-type': 'type',
  'annotation.struct-field': 'struct-field',
  'annotation.project': 'project-annotation',
  'patch.create': 'patch',
};

// Exercise mutation handlers with real single-use proposal authority. Tests of
// persistence failures supply their own adapter state; no approval gate is mocked.
export async function executeApprovedCapability(executor, capability, args) {
  const kind = kinds[capability];
  if (!kind) throw new Error(`No proposal kind for ${capability}`);
  const evidenceStore = new EvidenceStore([{ id: 'fixture-evidence', kind: 'read', status: 'unknown' }]);
  const store = new ProposalStore({ evidenceStore });
  const target = { ...args };
  const before = kind === 'patch' ? args.before : null;
  const after = kind === 'patch' ? args.after : kind === 'struct-field' ? {} : args.value;
  if (kind === 'patch') { delete target.before; delete target.after; }
  else if (kind !== 'struct-field') delete target.value;
  const proposal = store.create({ kind, target, before, after, evidenceIds: ['fixture-evidence'] });
  const { approvalToken } = store.approve(proposal.id);
  let result;
  await store.apply(proposal.id, {
    approvalToken,
    currentState: before,
    apply: async (approved, authorization) => {
      result = await executor.execute(capability, proposalArguments(approved), { authorization });
    },
  });
  return result;
}
