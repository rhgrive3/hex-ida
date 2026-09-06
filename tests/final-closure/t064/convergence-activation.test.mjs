import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
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

const validate = (candidate = contract, candidateTasks = tasksText, options = {}) => {
  const errors = [];
  const result = validateStageAConvergence({
    stageAConvergence: candidate,
    tasksText: candidateTasks,
    ownership,
    ownershipText,
    taskIds: routeTaskIds,
    requireActive: options.requireActive ?? false,
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
const assertError = (candidate, code, message, candidateTasks = tasksText) => {
  const { errors } = validate(candidate, candidateTasks);
  assert.ok(errors.some((error) => error === code || error.startsWith(`${code}:`)),
    `${message}\nexpected ${code}\nactual:\n${errors.join('\n')}`);
};

const draft = validate();
assert.equal(draft.result.valid, true, draft.errors.join('\n'));
assert.deepEqual(contract.pathAssignments.T064.allowedPaths, ['tests/final-closure/t064/**']);
assert.equal(contract.taskClasses.T064.role, 'post-handoff-verification');
assert.equal(contract.taskClasses.T064.checkpoint, true);
assert.deepEqual(contract.closureRules.t064MayNotGate, ['T013']);
assert.deepEqual(contract.closureRules.staticTaskDependencyAdditions, []);
assert.deepEqual(contract.closureRules.t049StaticDependencyAdditions, []);
assert.equal(contract.candidateGates.status, 'UNREGISTERED');
assert.equal(draft.result.active, false);
assert.deepEqual(
  contract.effectiveExecution.consumers,
  [
    'validatePreflightContracts',
    'validateComponentLane',
    'runComponentGates',
    'verifyCheckpointOperationalEvidence',
    'verifyCheckpointProductProof',
    'verifyCheckpointRuntimeEvidence',
  ],
);

const splitBundle = structuredClone(contract);
splitBundle.effectiveExecution.candidateGateSource = 'base-registry-only';
reidentity(splitBundle);
assertError(
  splitBundle,
  'stage-a-convergence-effective-execution-contract-invalid',
  'all canonical consumers must use one effective ownership and gate bundle',
);

const t013StaticRewrite = tasksText.replace(
  /(^- \[ \] T013\b[\s\S]*?Dependencies: [^.]*)(\. Owned paths:)/m,
  '$1 and T064$2',
);
assert.notEqual(t013StaticRewrite, tasksText);
assertError(
  contract,
  'stage-a-convergence-t064-static-dependency-on-t013',
  'T064 cannot become a static prerequisite of T013',
  t013StaticRewrite,
);

const t018StaticRewrite = tasksText.replace(
  /(^- \[ \] T018\b[\s\S]*?Dependencies: [^.]*)(\. Owned paths:)/m,
  '$1 and T064$2',
);
assert.notEqual(t018StaticRewrite, tasksText);
assertError(
  contract,
  'stage-a-convergence-t064-static-dependency-on-t018',
  'T018 historical dependencies cannot be rewritten as a string-only activation shortcut',
  t018StaticRewrite,
);

const closureRewrite = structuredClone(contract);
closureRewrite.closureRules.t013Admission = 'requires-an-accepted-T063-producer-checkpoint-and-T064';
reidentity(closureRewrite);
assertError(closureRewrite, 'stage-a-convergence-closure-rules-invalid', 'the machine closure rule must leave T064 after T013');

const borrowedProductionPath = structuredClone(contract);
borrowedProductionPath.ownershipExtension.tasks.T064.allowedPaths.push('js/ir-core.js');
reidentity(borrowedProductionPath);
assertError(borrowedProductionPath, 'stage-a-convergence-owner-row-invalid', 'T064 verification cannot acquire production ownership');

const activeWithoutOracle = structuredClone(contract);
activeWithoutOracle.status = 'ACTIVE';
activeWithoutOracle.candidateGates = {
  status: 'REGISTERED',
  requiredTaskIds: ['T063', 'T064'],
  tasks: { T063: { owned: [] }, T064: { owned: [] } },
  reason: contract.candidateGates.reason,
};
reidentity(activeWithoutOracle);
const activeResult = validate(activeWithoutOracle, tasksText, { requireActive: true });
assert.equal(activeResult.result.active, false);
assert.ok(activeResult.errors.includes('stage-a-convergence-actual-oracle-unspecified'));
assert.ok(activeResult.errors.includes('stage-a-convergence-active-oracle-not-admitted'));

const oracleCases = [
  ['t063-positive', 'T063', 'positive'],
  ['t063-negative', 'T063', 'negative'],
  ['t063-boundary', 'T063', 'boundary'],
  ['t063-stale', 'T063', 'stale'],
  ['t063-cancellation', 'T063', 'cancellation'],
  ['t063-malformed', 'T063', 'malformed'],
  ['t064-positive', 'T064', 'positive'],
  ['t064-negative', 'T064', 'negative'],
  ['t064-boundary', 'T064', 'boundary'],
  ['t064-rollback', 'T064', 'rollback'],
  ['t064-performance', 'T064', 'performance'],
].map(([id, taskId, kind]) => ({
  id,
  taskId,
  kind,
  entrypoint: `producer-${taskId.toLowerCase()}`,
  fixtureIds: [id],
  negativeCounterexample: `negative-${id}`,
  observes: ['actual-product-behavior'],
  expectedOutcome: `expected-${id}`,
}));
const incompleteBindings = (taskId) => Object.fromEntries(
  ['owned', 'rolling', 'shadow'].map((kind) => [kind, {
    gateId: `${taskId.toLowerCase()}-${kind}`,
    argv: ['node', 'tests/phase8/foundation/readiness.test.mjs'],
    caseIds: oracleCases.filter((row) => row.taskId === taskId).map((row) => row.id),
  }]),
);
const registeredMissingContent = structuredClone(contract);
registeredMissingContent.status = 'ACTIVE';
registeredMissingContent.candidateGates = {
  status: 'REGISTERED',
  requiredTaskIds: ['T063', 'T064'],
  tasks: { T063: {
    owned: [{ id: 't063-owned', argv: ['node', 'tests/phase8/foundation/readiness.test.mjs'] }],
    rolling: [{ id: 't063-rolling', argv: ['node', 'tests/phase8/foundation/readiness.test.mjs'] }],
    shadow: [{ id: 't063-shadow', argv: ['node', 'tests/phase8/foundation/readiness.test.mjs'] }],
  }, T064: {
    owned: [{ id: 't064-owned', argv: ['node', 'tests/phase8/foundation/readiness.test.mjs'] }],
    rolling: [{ id: 't064-rolling', argv: ['node', 'tests/phase8/foundation/readiness.test.mjs'] }],
    shadow: [{ id: 't064-shadow', argv: ['node', 'tests/phase8/foundation/readiness.test.mjs'] }],
  } },
  reason: 'independent product oracle is pending content binding',
  oracleSpecification: {
    schemaVersion: 'hex-final-closure-stage-a-convergence-oracle/v1',
    kind: 'actual-product-behavior-v1',
    source: null,
    fixture: null,
    independence: null,
    cases: oracleCases,
    commandBindings: {
      T063: incompleteBindings('T063'),
      T064: incompleteBindings('T064'),
    },
  },
};
registeredMissingContent.ownershipExtension.candidateGates = structuredClone(
  registeredMissingContent.candidateGates,
);
reidentity(registeredMissingContent);
const missingContentResult = validate(registeredMissingContent, tasksText, { requireActive: true });
assert.equal(missingContentResult.result.active, false);
assert.ok(missingContentResult.errors.includes('stage-a-convergence-oracle-source-binding-invalid'));
assert.ok(missingContentResult.errors.includes('stage-a-convergence-oracle-fixture-binding-invalid'));
assert.ok(missingContentResult.errors.includes('stage-a-convergence-oracle-independence-binding-invalid'));
assert.ok(missingContentResult.errors.includes('stage-a-convergence-active-oracle-not-admitted'));

console.log('T064 closure ordering and fail-closed activation validator: PASS');
