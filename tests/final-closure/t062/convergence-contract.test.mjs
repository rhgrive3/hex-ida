import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  authenticateStageAConvergenceHistory,
  canonicalStageAConvergenceDigest,
  validateStageAConvergence,
} from '../../../tools/validation/final-closure/preflight.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (repoPath) => fs.readFileSync(path.join(ROOT, repoPath), 'utf8');
const contract = JSON.parse(read('specs/005-analysis-final-closure/contracts/stage-a-convergence.json'));
const tasksText = read('specs/005-analysis-final-closure/tasks.md');
const ownershipText = read('specs/005-analysis-final-closure/contracts/task-ownership.json');
const ownership = JSON.parse(ownershipText);

const routeTaskIds = ['T062', 'T063', 'T064'];
const validate = (candidate = contract, options = {}) => {
  const errors = [];
  const result = validateStageAConvergence({
    stageAConvergence: candidate,
    tasksText,
    ownership,
    ownershipText,
    taskIds: [...routeTaskIds],
    requireActive: options.requireActive ?? false,
    root: options.root ?? null,
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
const assertError = (candidate, code, message, options = {}) => {
  const { errors } = validate(candidate, options);
  assert.ok(errors.some((error) => error === code || error.startsWith(`${code}:`)),
    `${message}\nexpected ${code}\nactual:\n${errors.join('\n')}`);
};

const draft = validate();
assert.equal(draft.result.valid, true, draft.errors.join('\n'));
assert.equal(
  draft.result.historyAuthentication.authenticated,
  false,
  'structural validation without a Git root must remain visibly unauthenticated',
);
assert.equal(draft.result.active, false);
assert.equal(draft.result.candidateGateRegistered, false);
assert.deepEqual(draft.result.ownership.tasks.T062, contract.ownershipExtension.tasks.T062);
assert.equal(contract.candidateGates.status, 'UNREGISTERED');
assert.deepEqual(contract.candidateGates.tasks, {});
assert.equal(
  contract.candidateGates.reason,
  'No independently specified actual producer behavioral oracle is admitted in this draft; shape-only governance tests cannot certify T063 or T064.',
);

const activeDraft = reidentity(structuredClone(contract));
activeDraft.status = 'ACTIVE';
activeDraft.candidateGates = {
  status: 'REGISTERED',
  requiredTaskIds: ['T063', 'T064'],
  tasks: { T063: { owned: [] }, T064: { owned: [] } },
  reason: contract.candidateGates.reason,
};
reidentity(activeDraft);
assertError(
  activeDraft,
  'stage-a-convergence-actual-oracle-unspecified',
  'ACTIVE registration requires an actual product behavioral oracle, not registry-shaped tests',
  { requireActive: true },
);

const badIdentity = structuredClone(contract);
badIdentity.identity.sha256 = '0'.repeat(64);
assertError(badIdentity, 'stage-a-convergence-identity-invalid', 'contract identity is bound to all unsigned bytes');

const badPrefix = structuredClone(contract);
badPrefix.predecessor.tasksPrefixSha256 = '0'.repeat(64);
reidentity(badPrefix);
assertError(badPrefix, 'stage-a-convergence-task-prefix-mismatch', 'historical task bytes cannot be replaced by a recomputed suffix');

const badOwner = structuredClone(contract);
badOwner.ownershipExtension.tasks.T062.allowedPaths.push('js/ir-core.js');
reidentity(badOwner);
assertError(badOwner, 'stage-a-convergence-owner-row-invalid', 'extension ownership cannot widen T062 into production source');

const badExistingOwner = structuredClone(contract);
badExistingOwner.ownershipExtension.tasks.T063.allowedPaths = [
  'js/decompiler/pipeline.js',
  ...badExistingOwner.ownershipExtension.tasks.T063.allowedPaths.slice(1),
];
reidentity(badExistingOwner);
assertError(badExistingOwner, 'stage-a-convergence-owner-row-invalid', 'retained T011 paths remain protected from convergence reassignment');

const noActivation = validate(contract, { requireActive: true });
assert.equal(noActivation.result.valid, false);
assert.ok(noActivation.errors.includes('stage-a-convergence-candidate-gates-unregistered'));

const authenticated = validate(contract, { root: ROOT });
assert.equal(authenticated.result.valid, true, authenticated.errors.join('\n'));
assert.equal(authenticated.result.historyAuthentication.authenticated, true);
for (const mutate of [
  (candidate) => { candidate.predecessor.headSha = '0'.repeat(40); },
  (candidate) => { candidate.predecessor.treeSha = '0'.repeat(40); },
  (candidate) => { candidate.predecessor.integrationInventorySha256 = '0'.repeat(64); },
  (candidate) => { candidate.predecessor.closureLedgerSha256 = '0'.repeat(64); },
  (candidate) => { candidate.historicalAuthentication.blobs.integrationInventory.sha256 = '0'.repeat(64); },
  (candidate) => { candidate.historicalAuthentication.blobs.closureLedger.gitBlobSha1 = '0'.repeat(40); },
  (candidate) => { candidate.predecessor.acceptedCheckpoint.acceptedTaskId = 'T056'; },
]) {
  const historicalMutation = reidentity(structuredClone(contract));
  mutate(historicalMutation);
  reidentity(historicalMutation);
  const errors = [];
  const result = authenticateStageAConvergenceHistory({
    root: ROOT,
    stageAConvergence: historicalMutation,
    errors,
  });
  assert.equal(result.authenticated, false);
  assert.ok(errors.length > 0, 'historical mutation must be rejected');
}

console.log('T062 convergence validator, append-only extension, and fail-closed admission: PASS');
