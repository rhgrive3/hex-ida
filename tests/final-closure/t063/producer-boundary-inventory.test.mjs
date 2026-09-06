import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  canonicalStageAConvergenceDigest,
  materializeStageAConvergenceOwnership,
  validateStageAConvergence,
} from '../../../tools/validation/final-closure/preflight.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (repoPath) => fs.readFileSync(path.join(ROOT, repoPath), 'utf8');
const contract = JSON.parse(read('specs/005-analysis-final-closure/contracts/stage-a-convergence.json'));
const tasksText = read('specs/005-analysis-final-closure/tasks.md');
const ownershipText = read('specs/005-analysis-final-closure/contracts/task-ownership.json');
const baseOwnership = JSON.parse(ownershipText);
const routeTaskIds = ['T062', 'T063', 'T064'];
const sixProducerPaths = contract.pathAssignments.T063.allowedPaths.filter((repoPath) => repoPath.startsWith('js/'));

const ownersFor = (ownership, repoPath) => Object.entries(ownership.tasks)
  .filter(([, row]) => (row.allowedPaths || []).some((pattern) => pattern === repoPath
    || (pattern.endsWith('/**') && repoPath.startsWith(pattern.slice(0, -2)))))
  .map(([taskId]) => taskId);
const validate = (candidate = contract, candidateOwnership = baseOwnership) => {
  const errors = [];
  const result = validateStageAConvergence({
    stageAConvergence: candidate,
    tasksText,
    ownership: candidateOwnership,
    ownershipText,
    taskIds: routeTaskIds,
    requireActive: false,
    errors,
  });
  return { result, errors };
};
const reidentity = (candidate) => {
  delete candidate.identity;
  candidate.identity = {
    algorithm: 'sha256-canonical-json-without-identity-v1',
    sha256: canonicalStageAConvergenceDigest(candidate),
  };
  return candidate;
};
const assertError = (candidate, code, message, candidateOwnership = baseOwnership) => {
  const { errors } = validate(candidate, candidateOwnership);
  assert.ok(errors.some((error) => error === code || error.startsWith(`${code}:`)),
    `${message}\nexpected ${code}\nactual:\n${errors.join('\n')}`);
};

const draft = validate();
assert.equal(draft.result.valid, true, draft.errors.join('\n'));
const effective = materializeStageAConvergenceOwnership({
  ownership: baseOwnership,
  stageAConvergence: contract,
  errors: [],
});
for (const repoPath of sixProducerPaths) {
  assert.equal(fs.existsSync(path.join(ROOT, repoPath)), true, `${repoPath} must exist`);
  assert.deepEqual(ownersFor(baseOwnership, repoPath), [], `${repoPath} is unassigned in the frozen base registry`);
  assert.deepEqual(ownersFor(effective, repoPath), ['T063'], `${repoPath} is assigned only by the extension`);
}
assert.deepEqual(
  effective.tasks.T063.allowedPaths,
  contract.pathAssignments.T063.allowedPaths,
);
assert.equal(contract.taskClasses.T063.stageB, false);
assert.equal(contract.taskClasses.T063.requiresT048, false);
assert.deepEqual(contract.candidateGates.tasks, {}, 'T063 has no semantic gate until an actual oracle is specified');

const registeredGateRows = (taskId) => ({
  owned: [{ id: `${taskId.toLowerCase()}-owned`, argv: ['node', 'tests/phase8/ordinary-oracle.test.mjs'] }],
  rolling: [{ id: `${taskId.toLowerCase()}-rolling`, argv: ['node', 'tests/phase8/ordinary-oracle.test.mjs'] }],
  shadow: [{
    id: `${taskId.toLowerCase()}-shadow`,
    argv: ['node', 'tests/phase8/ordinary-oracle.test.mjs'],
    contract: {},
    contractSha256: '0'.repeat(64),
  }],
});
const registered = structuredClone(contract);
registered.candidateGates = {
  status: 'REGISTERED',
  requiredTaskIds: ['T063', 'T064'],
  tasks: {
    T063: registeredGateRows('T063'),
    T064: registeredGateRows('T064'),
  },
  reason: 'independently reviewed product oracle is bound by a successor receipt',
  oracleSpecification: {},
};
registered.ownershipExtension.candidateGates = structuredClone(registered.candidateGates);
const registeredEffective = materializeStageAConvergenceOwnership({
  ownership: baseOwnership,
  stageAConvergence: registered,
  errors: [],
});
assert.deepEqual(
  registeredEffective.candidateGates.tasks.T063,
  registered.candidateGates.tasks.T063,
  'registered extension gates must be visible to the effective execution bundle',
);
assert.deepEqual(
  registeredEffective.candidateGates.tasks.T064,
  registered.candidateGates.tasks.T064,
  'registered T064 gates must use the same effective bundle as T063',
);

const wrongClass = structuredClone(contract);
wrongClass.taskClasses.T063.stageB = true;
reidentity(wrongClass);
assertError(wrongClass, 'stage-a-convergence-task-classes-invalid', 'T063 must remain a Stage A component');

const omittedBoundary = structuredClone(contract);
omittedBoundary.ownershipExtension.tasks.T063.allowedPaths.pop();
reidentity(omittedBoundary);
assertError(omittedBoundary, 'stage-a-convergence-owner-row-invalid', 'the validator must reject an incomplete producer inventory');

const borrowedBoundary = structuredClone(contract);
borrowedBoundary.ownershipExtension.tasks.T063.allowedPaths[0] = 'js/decompiler/pipeline.js';
reidentity(borrowedBoundary);
assertError(borrowedBoundary, 'stage-a-convergence-owner-row-invalid', 'the validator must reject a retained T011 path');

const duplicateBaseOwner = structuredClone(baseOwnership);
duplicateBaseOwner.tasks.T012.allowedPaths.push(sixProducerPaths[0]);
assertError(contract, 'stage-a-convergence-owner-path-not-exclusive', 'a concurrent unrelated owner cannot be hidden by the extension', duplicateBaseOwner);

console.log('T063 producer boundary materialization and ownership classification: PASS');
