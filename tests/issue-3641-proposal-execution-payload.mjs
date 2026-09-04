import assert from 'node:assert/strict';
import { ProposalStore } from '../js/ai/proposals.js';
import { ProposalExecutor } from '../js/ai/interaction/proposal-executor.js';

const evidenceStore = { has: (id) => id === 'verified-evidence' };

async function applyProjectAnnotation(after, mutateAfterCreate = null) {
  const app = { projectAnnotations: [{ id: 'demo', value: null }] };
  const store = new ProposalStore({ evidenceStore });
  const proposal = store.create({
    kind: 'project-annotation',
    target: { id: 'demo' },
    before: null,
    after,
    evidenceIds: ['verified-evidence'],
  });
  mutateAfterCreate?.(after);

  const capabilityExecutor = {
    async execute(capability, args) {
      assert.equal(capability, 'annotation.project');
      const item = app.projectAnnotations.find((entry) => entry.id === args.id);
      assert.ok(item, 'target project annotation must exist');
      item.value = structuredClone(args.value);
      return { value: item.value };
    },
  };
  const executor = new ProposalExecutor({ store, capabilityExecutor, app });
  await executor.approveAndApply(proposal.id);
  return { proposal, applied: app.projectAnnotations[0].value };
}

const oversizedArray = Array.from({ length: 1001 }, (_, index) => index);
const arrayRun = await applyProjectAnnotation(oversizedArray, (value) => value.push(1001));
assert.equal(arrayRun.proposal.after.length, 1000, 'display projection remains bounded');
assert.equal(arrayRun.applied.length, 1001, 'execution preserves the full array snapshot');
assert.equal(arrayRun.applied[1000], 1000);
assert.equal(arrayRun.applied.includes(1001), false, 'caller mutation after create must not alter approved payload');

const oversizedObject = Object.fromEntries(Array.from({ length: 201 }, (_, index) => [`k${index}`, index]));
const objectRun = await applyProjectAnnotation(oversizedObject);
assert.equal(Object.keys(objectRun.proposal.after).length, 200, 'display object projection remains bounded');
assert.equal(Object.keys(objectRun.applied).length, 201, 'execution preserves every object key');
assert.equal(objectRun.applied.k200, 200);

let deepValue = 'leaf';
for (let depth = 0; depth < 12; depth++) deepValue = { next: deepValue };
const deepRun = await applyProjectAnnotation(deepValue);
let cursor = deepRun.applied;
for (let depth = 0; depth < 12; depth++) cursor = cursor.next;
assert.equal(cursor, 'leaf', 'execution preserves values beyond display depth limit');

console.log('issue-3641 proposal execution payload regression: ok');
