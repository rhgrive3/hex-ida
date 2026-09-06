import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  canonicalStageAConvergenceDigest,
  canonicalJson,
  deriveStageAConvergenceCheckpointBinding,
  runComponentGates,
  stageAConvergenceContractBundle,
  validatePreflightContracts,
  validateStageAConvergence,
  verifyStageAConvergenceCheckpointBinding,
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
  ['owned', 'rolling'].map((kind) => [kind, {
    gateId: `${taskId.toLowerCase()}-${kind}`,
    argv: ['node', 'tests/phase8/foundation/readiness.test.mjs'],
    caseIds: oracleCases.filter((row) => row.taskId === taskId).map((row) => row.id),
  }]),
);
const missingContentShadowContract = (taskId, gateId) => ({
  id: gateId,
  argv: ['node', 'tools/validation/final-closure/preflight.mjs', '--emit-shadow-evidence', '--task', taskId],
  contract: {
    schemaVersion: 'hex-final-closure-shadow-contract/v1',
    taskId,
    gateId,
    activationRequired: false,
    cases: [{
      id: `${taskId.toLowerCase()}-missing-content-shadow`,
      projection: {
        kind: 'process-exit-v1',
        argv: ['node', 'tests/phase8/foundation/readiness.test.mjs'],
        timeoutMs: 60000,
      },
      oracleObservation: { exitCode: 0, signal: null, errorCode: null },
      failureCounterIds: ['semanticMismatch'],
    }],
  },
});
const missingContentShadow = (taskId) => {
  const gate = missingContentShadowContract(taskId, `${taskId.toLowerCase()}-shadow`);
  gate.contractSha256 = createHash('sha256').update(canonicalJson(gate.contract)).digest('hex');
  return gate;
};
const missingContentGateRows = (taskId) => ({
  ...incompleteBindings(taskId),
  shadow: {
    gateId: `${taskId.toLowerCase()}-shadow`,
    argv: ['node', 'tools/validation/final-closure/preflight.mjs', '--emit-shadow-evidence', '--task', taskId],
    caseIds: oracleCases.filter((row) => row.taskId === taskId).map((row) => row.id),
  },
});
const registeredMissingContent = structuredClone(contract);
registeredMissingContent.status = 'ACTIVE';
registeredMissingContent.candidateGates = {
  status: 'REGISTERED',
  requiredTaskIds: ['T063', 'T064'],
  tasks: { T063: {
    owned: [{ id: 't063-owned', argv: ['node', 'tests/phase8/foundation/readiness.test.mjs'] }],
    rolling: [{ id: 't063-rolling', argv: ['node', 'tests/phase8/foundation/readiness.test.mjs'] }],
    shadow: [missingContentShadow('T063')],
  }, T064: {
    owned: [{ id: 't064-owned', argv: ['node', 'tests/phase8/foundation/readiness.test.mjs'] }],
    rolling: [{ id: 't064-rolling', argv: ['node', 'tests/phase8/foundation/readiness.test.mjs'] }],
    shadow: [missingContentShadow('T064')],
  } },
  reason: 'independent product oracle is pending content binding',
  oracleSpecification: {
    schemaVersion: 'hex-final-closure-stage-a-convergence-oracle/v1',
    kind: 'actual-product-behavior-v1',
    source: null,
    fixture: null,
    results: null,
    independence: null,
    lifecycle: {
      registrationStatus: 'REGISTERED',
      productStatus: 'NONPASS',
      semanticPass: false,
      acceptance: false,
      blockedFindings: ['PO-001'],
      resultSha256: '0'.repeat(64),
    },
    cases: oracleCases,
    commandBindings: {
      T063: missingContentGateRows('T063'),
      T064: missingContentGateRows('T064'),
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
assert.ok(missingContentResult.errors.includes('stage-a-convergence-oracle-results-binding-invalid'));
assert.ok(missingContentResult.errors.includes('stage-a-convergence-oracle-independence-binding-invalid'));
assert.ok(missingContentResult.errors.includes('stage-a-convergence-active-oracle-not-admitted'));

const gitRun = (cwd, argv, encoding = 'utf8') => {
  const result = spawnSync('git', argv, {
    cwd,
    encoding,
    env: process.env,
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(result.status, 0, String(result.stderr || '').trim() || argv.join(' '));
  return encoding === null ? result.stdout : String(result.stdout).trim();
};
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const artifactAt = (root, commitSha, repoPath) => {
  const content = gitRun(root, ['show', `${commitSha}:${repoPath}`], null);
  return {
    path: repoPath,
    sourceCommitSha: commitSha,
    sourceTreeSha: gitRun(root, ['rev-parse', `${commitSha}^{tree}`]),
    gitBlobSha1: gitRun(root, ['rev-parse', `${commitSha}:${repoPath}`]),
    sha256: sha256(content),
  };
};

// This fixture is a real Git/blob registration self-test. Its files are
// committed only in a detached temporary worktree and removed in finally;
// they never become T063/T064 product ownership or acceptance evidence.
const selfTestRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-stage-a-oracle-registration-'));
let selfTestWorktree = false;
try {
  const sourceHead = gitRun(ROOT, ['rev-parse', 'HEAD']);
  gitRun(ROOT, ['worktree', 'add', '--detach', selfTestRoot, sourceHead]);
  selfTestWorktree = true;

  const selfTestDir = path.join(selfTestRoot, 'tests/final-closure/oracle-self-test');
  fs.mkdirSync(selfTestDir, { recursive: true });
  const observerPath = 'tests/final-closure/oracle-self-test/observer.mjs';
  const fixturePath = 'tests/final-closure/oracle-self-test/fixtures.mjs';
  const resultsPath = 'tests/final-closure/oracle-self-test/results.mjs';
  const receiptPath = 'tests/final-closure/oracle-self-test/independent-review.md';
  const entrypoint = `${observerPath}#observeCase`;
  const selfCases = oracleCases.map((row) => ({
    ...row,
    entrypoint,
    observes: ['producer.result', 'registration.status'],
    expectedOutcome: 'NONPASS:producer-unimplemented',
  }));
  const selfCaseMap = Object.fromEntries(selfCases.map((row) => [row.id, row]));
  const sourceMarkers = selfCases.map((row) => `HEX_STAGE_A_ORACLE_SOURCE_V1 ${row.id} ${canonicalJson({
    entrypoint: row.entrypoint,
    observes: row.observes,
  })}`);
  const fixtureMarkers = selfCases.map((row) => `HEX_STAGE_A_ORACLE_FIXTURE_V1 ${row.id} ${canonicalJson({
    fixtureIds: row.fixtureIds,
    negativeCounterexample: row.negativeCounterexample,
  })}`);
  const resultMarkers = selfCases.map((row) => `HEX_STAGE_A_ORACLE_RESULT_V1 ${row.id} ${canonicalJson({
    expectedOutcome: row.expectedOutcome,
  })}`);
  const sourceText = [
    `const CASES = ${JSON.stringify(selfCaseMap)};`,
    'export function observeCase({ caseId } = {}) {',
    '  const row = CASES[caseId];',
    "  if (!row) throw new Error('unknown-case');",
    `  return { caseId, entrypoint: ${JSON.stringify(entrypoint)}, observes: row.observes, expectedOutcome: row.expectedOutcome };`,
    '}',
    "if (process.argv.includes('--case-id')) {",
    "  process.stdout.write(JSON.stringify(observeCase({ caseId: process.argv[process.argv.indexOf('--case-id') + 1] })));",
    '}',
    ...sourceMarkers.map((marker) => `// ${marker}`),
    '',
  ].join('\n');
  const fixtureText = [
    `export const fixtures = ${JSON.stringify(selfCases.map((row) => ({
      caseId: row.id,
      fixtureIds: row.fixtureIds,
      negativeCounterexample: row.negativeCounterexample,
    })))};`,
    ...fixtureMarkers.map((marker) => `// ${marker}`),
    '',
  ].join('\n');
  const resultText = [
    `export const results = ${JSON.stringify(selfCases.map((row) => ({
      caseId: row.id,
      expectedOutcome: row.expectedOutcome,
    })))};`,
    '// HEX_STAGE_A_ORACLE_STATUS_V1 NONPASS',
    ...resultMarkers.map((marker) => `// ${marker}`),
    '',
  ].join('\n');
  fs.writeFileSync(path.join(selfTestRoot, observerPath), sourceText);
  fs.writeFileSync(path.join(selfTestRoot, fixturePath), fixtureText);
  fs.writeFileSync(path.join(selfTestRoot, resultsPath), resultText);
  fs.writeFileSync(path.join(selfTestRoot, receiptPath), [
    '# independently authored observer review',
    '',
    'This detached self-test receipt covers source, fixture, and result content.',
    '',
  ].join('\n'));
  gitRun(selfTestRoot, ['add', observerPath, fixturePath, resultsPath, receiptPath]);
  gitRun(selfTestRoot, [
    '-c', 'user.name=Codex', '-c', 'user.email=codex@openai.com',
    'commit', '--no-gpg-sign', '-m', 'test: bind convergence oracle self-test blobs',
  ]);
  const dataCommit = gitRun(selfTestRoot, ['rev-parse', 'HEAD']);
  const dataTree = gitRun(selfTestRoot, ['rev-parse', 'HEAD^{tree}']);
  const source = artifactAt(selfTestRoot, dataCommit, observerPath);
  const fixture = { ...artifactAt(selfTestRoot, dataCommit, fixturePath), caseIds: selfCases.map((row) => row.id) };
  const results = {
    ...artifactAt(selfTestRoot, dataCommit, resultsPath),
    caseIds: selfCases.map((row) => row.id),
    status: 'NONPASS',
  };
  const receipt = artifactAt(selfTestRoot, dataCommit, receiptPath);

  const dynamicShadowGate = (taskId, gateId) => {
    const contractDefinition = {
      schemaVersion: 'hex-final-closure-shadow-contract/v1',
      taskId,
      gateId,
      activationRequired: false,
      cases: [{
        id: `${taskId.toLowerCase()}-self-test-shadow`,
        projection: {
          kind: 'process-exit-v1',
          argv: ['node', 'tests/phase8/foundation/readiness.test.mjs'],
          timeoutMs: 60000,
        },
        oracleObservation: { exitCode: 0, signal: null, errorCode: null },
        failureCounterIds: ['semanticMismatch'],
      }],
    };
    return {
      id: gateId,
      argv: ['node', 'tools/validation/final-closure/preflight.mjs', '--emit-shadow-evidence', '--task', taskId],
      contract: contractDefinition,
      contractSha256: sha256(canonicalJson(contractDefinition)),
    };
  };
  const selfGateRows = (taskId) => {
    const taskCaseIds = selfCases.filter((row) => row.taskId === taskId).map((row) => row.id);
    const ownedId = `${taskId.toLowerCase()}-self-test-owned`;
    const rollingId = `${taskId.toLowerCase()}-self-test-rolling`;
    const shadowId = `${taskId.toLowerCase()}-self-test-shadow`;
    return {
      owned: [{ id: ownedId, argv: ['node', observerPath] }],
      rolling: [{ id: rollingId, argv: ['node', observerPath] }],
      shadow: [dynamicShadowGate(taskId, shadowId)],
      bindings: {
        owned: { gateId: ownedId, argv: ['node', observerPath], caseIds: taskCaseIds },
        rolling: { gateId: rollingId, argv: ['node', observerPath], caseIds: taskCaseIds },
        shadow: {
          gateId: shadowId,
          argv: ['node', 'tools/validation/final-closure/preflight.mjs', '--emit-shadow-evidence', '--task', taskId],
          caseIds: taskCaseIds,
        },
      },
    };
  };
  const t063Gates = selfGateRows('T063');
  const t064Gates = selfGateRows('T064');
  const oracle = {
    schemaVersion: 'hex-final-closure-stage-a-convergence-oracle/v1',
    kind: 'actual-product-behavior-v1',
    source,
    fixture,
    results,
    independence: {
      ownerTaskId: 'T009',
      reviewerId: 'independent-oracle-review/observer-26d',
      receiptPath,
      receiptCommitSha: dataCommit,
      receiptTreeSha: dataTree,
      receiptGitBlobSha1: receipt.gitBlobSha1,
      receiptSha256: receipt.sha256,
      reviewedSourceSha256: source.sha256,
      reviewedFixtureSha256: fixture.sha256,
      reviewedResultsSha256: results.sha256,
    },
    lifecycle: {
      registrationStatus: 'REGISTERED',
      productStatus: 'NONPASS',
      semanticPass: false,
      acceptance: false,
      blockedFindings: ['PO-001', 'PO-002', 'PO-003', 'PO-004'],
      resultSha256: results.sha256,
    },
    cases: selfCases,
    commandBindings: {
      T063: t063Gates.bindings,
      T064: t064Gates.bindings,
    },
  };
  const registered = structuredClone(contract);
  registered.status = 'ACTIVE';
  registered.candidateGates = {
    status: 'REGISTERED',
    requiredTaskIds: ['T063', 'T064'],
    tasks: { T063: {
      owned: t063Gates.owned,
      rolling: t063Gates.rolling,
      shadow: t063Gates.shadow,
    }, T064: {
      owned: t064Gates.owned,
      rolling: t064Gates.rolling,
      shadow: t064Gates.shadow,
    } },
    reason: 'independently authored observer is registered; product remains NONPASS until implementation',
    oracleSpecification: oracle,
  };
  registered.ownershipExtension.candidateGates = structuredClone(registered.candidateGates);
  reidentity(registered);
  const stagePath = 'specs/005-analysis-final-closure/contracts/stage-a-convergence.json';
  fs.writeFileSync(path.join(selfTestRoot, stagePath), `${JSON.stringify(registered, null, 2)}\n`);
  gitRun(selfTestRoot, ['add', stagePath]);
  gitRun(selfTestRoot, [
    '-c', 'user.name=Codex', '-c', 'user.email=codex@openai.com',
    'commit', '--no-gpg-sign', '-m', 'test: materialize registered convergence oracle',
  ]);
  const authoritySha = gitRun(selfTestRoot, ['rev-parse', 'HEAD']);
  gitRun(selfTestRoot, [
    '-c', 'user.name=Codex', '-c', 'user.email=codex@openai.com',
    'commit', '--no-gpg-sign', '--allow-empty', '-m', 'test: convergence component candidate',
  ]);
  const candidateSha = gitRun(selfTestRoot, ['rev-parse', 'HEAD']);
  const candidateTree = gitRun(selfTestRoot, ['rev-parse', 'HEAD^{tree}']);
  assert.equal(gitRun(selfTestRoot, ['show', '-s', '--format=%P', candidateSha]), authoritySha);
  assert.equal(gitRun(selfTestRoot, ['status', '--porcelain', '--untracked-files=all']), '');

  const bundle = stageAConvergenceContractBundle({ root: selfTestRoot });
  const preflightResult = validatePreflightContracts({ ...bundle, root: selfTestRoot });
  assert.equal(preflightResult.ok, true, preflightResult.errors.join('\n'));
  assert.equal(preflightResult.stageAConvergenceResult.active, true);
  const contentTamper = structuredClone(registered);
  contentTamper.candidateGates.oracleSpecification.cases[0].expectedOutcome = 'PASS:unknown';
  contentTamper.ownershipExtension.candidateGates = structuredClone(contentTamper.candidateGates);
  reidentity(contentTamper);
  const contentTamperErrors = [];
  const contentTamperResult = validateStageAConvergence({
    stageAConvergence: contentTamper,
    tasksText: bundle.tasksText,
    ownership: bundle.baseOwnership,
    ownershipText: bundle.ownershipText,
    taskIds: ['T062', 'T063', 'T064'],
    requireActive: true,
    root: selfTestRoot,
    errors: contentTamperErrors,
  });
  assert.equal(contentTamperResult.active, false);
  assert.ok(contentTamperErrors.includes(
    'stage-a-convergence-oracle-case-results-content-mismatch:t063-positive',
  ));

  const componentPreflight = {
    headSha: candidateSha,
    treeSha: candidateTree,
    componentHeadSha: candidateSha,
    componentActualChangedPaths: [],
    componentInventoryDigest: '0'.repeat(32),
    initialCandidateGateDigest: '0'.repeat(32),
  };
  const runSelfTestComponent = (taskId) => runComponentGates({
    root: selfTestRoot,
    environment: {},
    authorityOverride: {
      mode: 'component',
      taskId,
      baseSha: authoritySha,
      headSha: candidateSha,
    },
    preflightOverride: componentPreflight,
    bundleOverride: bundle,
    oracleSelfTest: { oracle, caseIds: selfCases.filter((row) => row.taskId === taskId).map((row) => row.id) },
  });
  const t063Component = runSelfTestComponent('T063');
  const t064Component = runSelfTestComponent('T064');
  for (const component of [t063Component, t064Component]) {
    assert.equal(component.verdict, 'SELF_TEST_COMPONENT_GATES_PASS');
    assert.equal(component.selfTestOnly, true);
    assert.equal(component.productStatus, 'NONPASS');
    assert.equal(component.productSemanticPass, false);
    assert.equal(component.productAcceptance, false);
    assert.equal(component.oracleSelfTest.status, 'SELF_TEST_PASS');
  }

  const checkpointRow = {
    checkpointProduct: { commitSha: candidateSha, treeSha: candidateTree },
  };
  checkpointRow.stageAConvergenceBinding = deriveStageAConvergenceCheckpointBinding({
    root: selfTestRoot,
    row: checkpointRow,
  });
  const checkpointBinding = verifyStageAConvergenceCheckpointBinding({
    root: selfTestRoot,
    row: checkpointRow,
  });
  assert.deepEqual(checkpointBinding, checkpointRow.stageAConvergenceBinding);
  const tamperedCheckpoint = structuredClone(checkpointRow);
  tamperedCheckpoint.stageAConvergenceBinding.effectiveOwnershipIdentity = '0'.repeat(64);
  assert.throws(
    () => verifyStageAConvergenceCheckpointBinding({ root: selfTestRoot, row: tamperedCheckpoint }),
    /stage-a-convergence-checkpoint-binding-mismatch/,
  );
} finally {
  if (selfTestWorktree) {
    gitRun(ROOT, ['worktree', 'remove', '--force', selfTestRoot]);
  }
  fs.rmSync(selfTestRoot, { recursive: true, force: true });
}

console.log('T064 closure ordering and fail-closed activation validator: PASS');
