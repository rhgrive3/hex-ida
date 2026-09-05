import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  computeFoundationOwnershipDigest,
  validatePreflightContracts,
} from '../../tools/validation/final-closure/preflight.mjs';

const prefix = 'specs/005-analysis-final-closure/';
const text = (file) => fs.readFileSync(file, 'utf8');
const json = (file) => JSON.parse(text(file));
const bundle = {
  tasksText: text(`${prefix}tasks.md`),
  ownership: json(`${prefix}contracts/task-ownership.json`),
  integrationInventory: json(`${prefix}contracts/integration-inventory.json`),
  platformLocks: json(`${prefix}contracts/final-platform-locks.json`),
  performanceLocks: json(`${prefix}contracts/performance-locks.json`),
  workflowText: text('.github/workflows/final-closure-preflight.yml'),
  preFanoutText: text(`${prefix}evidence/pre-fanout.md`),
};
// Normalize only the checkpoint state under test, not its task ownership or
// dependency contracts. This regression remains valid after real acceptance.
const componentIds = Object.keys(bundle.ownership.candidateGates.tasks);
const componentSet = new Set(componentIds);
bundle.integrationInventory.campaignStage = 'STAGE_A';
bundle.tasksText = bundle.tasksText.split(/(?=^- \[[ x]\] T\d{3} )/m).map((block) => {
  const taskId = block.match(/^- \[[ x]\] (T\d{3}) /)?.[1];
  if (!componentSet.has(taskId)) return block;
  return block.replace(/^- \[[ x]\]/, '- [ ]').replace(/Status: DONE\./, 'Status: PENDING.');
}).join('');
bundle.integrationInventory.checkpoint = {
  schemaVersion: 'hex-final-closure-integration-checkpoint-state/v1',
  sequence: 0,
  state: 'PREFANOUT',
  acceptedTaskId: null,
  evidencePath: `${prefix}evidence/stage-a-checkpoints.md`,
};
bundle.integrationInventory.entries = bundle.integrationInventory.entries
  .filter((entry) => !componentSet.has(entry.ownerTaskId));
for (const taskId of componentIds) delete bundle.integrationInventory.taskHandoffs[taskId];
for (const key of ['expectedChangedPaths', 'actualChangedPaths', 'unionChangedPaths']) {
  bundle.integrationInventory[key] = bundle.integrationInventory.entries.map(({ path }) => path);
}
const errors = (overrides = {}) => validatePreflightContracts({ ...bundle, ...overrides }).errors;

assert.equal(computeFoundationOwnershipDigest(bundle.ownership), '17c869290b57aef76a1ee1d68ea32338',
  'the forward amendment must not redefine the original T001–T057 ownership');
const widened = structuredClone(bundle.ownership);
widened.tasks.T058.allowedPaths.push(`${prefix}evidence/pre-fanout.md`);
assert.ok(errors({ ownership: widened }).includes('ownership-forward-amendment-digest-mismatch'),
  'the successor may not acquire the immutable original evidence');
const missingMetricsOwner = structuredClone(bundle.ownership);
missingMetricsOwner.tasks.T014.allowedPaths = missingMetricsOwner.tasks.T014.allowedPaths
  .filter((entry) => entry !== 'tools/validation/phase9/tiered-solver-metrics.mjs');
assert.ok(errors({ ownership: missingMetricsOwner }).includes('ownership-forward-amendment-digest-mismatch'),
  'the approved locked-metrics ownership addition cannot silently disappear');
const reassigned = structuredClone(bundle.integrationInventory);
reassigned.entries.find((entry) => entry.path === `${prefix}spec.md`).ownerTaskId = 'T003';
assert.ok(errors({ integrationInventory: reassigned }).includes('foundation-amendment-reassignment-set-invalid'),
  'an otherwise permitted owner cannot hide an amended path from the successor seal');
const stale = '```json final-closure-stage-a-checkpoints\n{"checkpoints":[{"acceptedTaskId":"T051"}]}\n```';
assert.ok(errors({ checkpointEvidenceText: stale }).includes('checkpoint-prefanout-evidence-present'),
  'an unaccepted old checkpoint cannot be carried through sequence zero');
const handedOff = structuredClone(bundle.integrationInventory);
handedOff.taskHandoffs.T051 = {
  headSha: 'a'.repeat(40), treeSha: 'b'.repeat(40),
  evidencePath: 'tests/final-closure/t051/ai-snapshot-dev-scope.test.mjs',
};
assert.ok(errors({ integrationInventory: handedOff })
  .includes('checkpoint-prefanout-component-handoff:T051'));
const componentPath = structuredClone(bundle.integrationInventory);
componentPath.entries.push({ path: 'js/ai/snapshot.js', ownerTaskId: 'T051' });
assert.ok(errors({ integrationInventory: componentPath })
  .includes('checkpoint-prefanout-component-path-present:T051'));
console.log('foundation amendment: immutable original ownership and stale-proposal rejection PASS');
