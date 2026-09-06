import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

import {
  checkpointShadowGateEvidence,
  changedPaths,
  checkpointGenerationEvidence,
  emitShadowGateEvidence,
  executeRollingProductGates,
  executeT061MaintenanceGates,
  validatePreflightContracts,
  verifyTaskHandoffs,
  verifyT061MaintenanceGates,
  verifyT061MaintenancePackage,
  verifyT061MaintenanceStructure,
  verifyT061MaintenanceTransfer,
} from '../../tools/validation/final-closure/preflight.mjs';

const SOURCE_ROOT = process.cwd();
const GIT = 'git';
const BASE_SHA = 'b3a43e6974e28d24a9f80fef3a8f847dd2cd54ce';
const PRIOR_COMPONENT_SHA = '22b20128f00a53b75ef2cd9ee07decc1a414fae7';
const ORIGINAL_T052_HANDOFF_SHA = '0a521b282c6aa93afc94e0dfbfe701e705ccdf2a';
const PREIMAGE_BLOB_SHA = 'e808eb0ba83611ea3c147645f6070fcc3cd48823';
const POSTIMAGE_BLOB_SHA = '09a715039737d98ddef107ad477055b37bdde465';
const INVENTORY_PATH = 'specs/005-analysis-final-closure/contracts/integration-inventory.json';
const OWNERSHIP_PATH = 'specs/005-analysis-final-closure/contracts/task-ownership.json';
const TASKS_PATH = 'specs/005-analysis-final-closure/tasks.md';
const T052_PATH = 'tests/final-closure/t052/canonical-operation-registry.test.mjs';
const T061_TEST_PATH = 'tests/final-closure/fixture-maintenance.test.mjs';
const PREFLIGHT_PATH = 'tools/validation/final-closure/preflight.mjs';
const PREFLIGHT_TEST_PATH = 'tests/final-closure/preflight.test.mjs';
const T061_EVIDENCE_PATH = 'specs/005-analysis-final-closure/evidence/t061-maintenance-transfer.md';
const DATA_MODEL_PATH = 'specs/005-analysis-final-closure/data-model.md';
const T061_RECEIPT_SCHEMA = 'hex-final-closure-t061-maintenance-transfer/v1';
const T061_PRODUCT_SCHEMA = 'hex-final-closure-t061-maintenance-product/v1';
const T061_MAINTENANCE_PATHS = Object.freeze([
  'package.json',
  PREFLIGHT_PATH,
  PREFLIGHT_TEST_PATH,
  T061_TEST_PATH,
  TASKS_PATH,
  OWNERSHIP_PATH,
  T052_PATH,
  DATA_MODEL_PATH,
]);
const T061_REQUIRED_COMPONENT_PATHS = Object.freeze([
  PREFLIGHT_PATH,
  T061_TEST_PATH,
  TASKS_PATH,
  OWNERSHIP_PATH,
  T052_PATH,
  DATA_MODEL_PATH,
]);
const T049_GENERATED_PATHS = Object.freeze([
  'js/userscript/deployment-identity.generated.js',
  'userscript/hex.user.template.js',
  'userscript/release-version.json',
]);

function runGit(root, args, { input = undefined, env = process.env, encoding = 'utf8' } = {}) {
  const result = spawnSync(GIT, args, {
    cwd: root,
    env,
    encoding,
    input,
    maxBuffer: 128 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(String(result.stderr || `git ${args.join(' ')} failed`).trim());
  }
  return encoding === null ? result.stdout : String(result.stdout).trim();
}

function readAt(root, commitSha, repoPath) {
  const result = spawnSync(GIT, ['show', `${commitSha}:${repoPath}`], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`missing ${commitSha}:${repoPath}`);
  return String(result.stdout);
}

function readOptionalAt(root, commitSha, repoPath) {
  const result = spawnSync(GIT, ['show', `${commitSha}:${repoPath}`], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
  return result.status === 0 ? String(result.stdout) : null;
}

function writeFile(root, repoPath, content) {
  const target = path.join(root, repoPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function commit(root, message) {
  runGit(root, ['add', '--all']);
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'T061 maintenance fixture',
    GIT_AUTHOR_EMAIL: 't061-fixture@example.invalid',
    GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
    GIT_COMMITTER_NAME: 'T061 maintenance fixture',
    GIT_COMMITTER_EMAIL: 't061-fixture@example.invalid',
    GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
  };
  runGit(root, ['commit', '--quiet', '-m', message], { env });
  return runGit(root, ['rev-parse', 'HEAD']);
}

function commitTree(root, treeSha, parents, message) {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'T061 maintenance fixture',
    GIT_AUTHOR_EMAIL: 't061-fixture@example.invalid',
    GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
    GIT_COMMITTER_NAME: 'T061 maintenance fixture',
    GIT_COMMITTER_EMAIL: 't061-fixture@example.invalid',
    GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
  };
  const args = ['commit-tree', treeSha];
  for (const parent of parents) args.push('-p', parent);
  args.push('-m', message);
  return runGit(root, args, { env });
}

function hashBlob(root, content) {
  return runGit(root, ['hash-object', '--stdin'], { input: content });
}

function replaceOnce(source, before, after) {
  assert.equal(source.includes(before), true, `fixture replacement is missing: ${before.slice(0, 40)}`);
  return source.replace(before, after);
}

function amendT049Dependencies(tasks) {
  const start = tasks.indexOf('- [ ] T049 ');
  assert.notEqual(start, -1, 'fixture T049 task is present');
  const next = tasks.slice(start).search(/\n- \[[ xX]\] T\d{3}\b/);
  const end = next === -1 ? tasks.length : start + next;
  const block = tasks.slice(start, end);
  const amended = replaceOnce(
    block,
    'Dependencies: T046, T058, and T060.',
    'Dependencies: T046, T058, T060, and T061.',
  );
  return `${tasks.slice(0, start)}${amended}${tasks.slice(end)}`;
}

function completeT061Task(tasks) {
  const start = tasks.indexOf('- [ ] T061 ');
  assert.notEqual(start, -1, 'fixture T061 task is present');
  const next = tasks.slice(start).search(/\n- \[[ xX]\] T\d{3}\b/);
  const end = next === -1 ? tasks.length : start + next;
  let block = tasks.slice(start, end);
  block = replaceOnce(block, '- [ ] T061 ', '- [x] T061 ');
  block = replaceOnce(block, 'Status: PENDING.', 'Status: DONE.');
  return `${tasks.slice(0, start)}${block}${tasks.slice(end)}`;
}

function reviewedT052Postimage(preimage) {
  let postimage = preimage;
  postimage = replaceOnce(
    postimage,
    "  assert.equal(invalid.normalized, false);\n  assert.equal(invalid.error?.message, 'operation-action-unsupported');",
    "  assert.equal(invalid, null, 'the current canonical helper publishes no authority on invalid input');",
  );
  postimage = replaceOnce(
    postimage,
    "  const malformedResult = log.applyOperation(malformed);\n  assert.equal(malformedResult.status, 'rejected');\n  assert.equal(malformedResult.reason, 'operation-target-entity-required');",
    "  assert.throws(\n    () => log.applyOperation(malformed),\n    (error) => error instanceof TypeError && error.message === 'operation-target-entity-required',\n  );",
  );
  postimage = replaceOnce(
    postimage,
    "  const badParents = log.applyOperation(rawOperation('op:bad-parents', { causalParents: 'op:parent' }));\n  assert.equal(badParents.status, 'rejected');\n  assert.equal(badParents.reason, 'operation-causal-parents-invalid');",
    "  assert.throws(\n    () => log.applyOperation(rawOperation('op:bad-parents', { causalParents: 'op:parent' })),\n    (error) => error instanceof TypeError && error.message === 'operation-causal-parents-invalid',\n  );\n  assert.deepEqual(log.appliedOperationIds(), []);\n  assert.deepEqual(log.snapshot().facts, {});\n  assert.equal(log.pending.size, 0);",
  );
  postimage = replaceOnce(
    postimage,
    "  const unsupported = rawOperation('op:add', { action: 'add' });\n  assert.throws(\n",
    "  const unsupported = rawOperation('op:add', { action: 'add' });\n  const beforeUnsupported = log.digest();\n  assert.throws(\n",
  );
  postimage = replaceOnce(
    postimage,
    "      operationId: 'op:add',\n      stateDigest: log.digest(),\n",
    '',
  );
  postimage = replaceOnce(
    postimage,
    "  );\n  assert.equal(log.applyBatch([unsupported]).reason, 'operation-action-unsupported');",
    "  );\n  assert.equal(log.digest(), beforeUnsupported, 'unsupported actions cannot mutate canonical state');\n  assert.equal(log.applyBatch([unsupported]).reason, 'operation-action-unsupported');",
  );
  postimage = replaceOnce(
    postimage,
    "    (error) => error instanceof TypeError && error.message === 'operation-pending-id-mismatch',",
    "    (error) => error instanceof TypeError && error.message === 'changelog-pending-id-mismatch',",
  );
  return postimage;
}

function stageLedger(root, commitSha, inventory) {
  const evidence = readAt(root, commitSha, inventory.checkpoint.evidencePath);
  const marker = '```json final-closure-stage-a-checkpoints';
  const start = evidence.indexOf(marker);
  assert.notEqual(start, -1, 'fixture must retain the Stage A checkpoint ledger');
  const jsonStart = evidence.indexOf('\n', start) + 1;
  const end = evidence.indexOf('\n```', jsonStart);
  assert.notEqual(end, -1, 'fixture checkpoint ledger must be fenced');
  return JSON.parse(evidence.slice(jsonStart, end));
}

function bundleAt(root, commitSha) {
  const text = (repoPath) => readAt(root, commitSha, repoPath);
  const json = (repoPath) => JSON.parse(text(repoPath));
  const inventory = json(INVENTORY_PATH);
  const ownership = json(OWNERSHIP_PATH);
  const authorityPaths = ownership?.candidateGates?.shadowEvidence?.authorityArtifacts
    ?.map((artifact) => artifact.path)
    || [
      'tools/validation/final-closure/shadow/foundation/registry.json',
      'tools/validation/final-closure/shadow/foundation/contracts.json',
      'tools/validation/final-closure/shadow/foundation/oracle-observer.mjs',
      'tools/validation/final-closure/shadow/foundation/product-observer.mjs',
    ];
  const shadowAuthority = Object.fromEntries(authorityPaths.map((repoPath) => [
    repoPath,
    text(repoPath),
  ]));
  return {
    tasksText: text(TASKS_PATH),
    ownership,
    integrationInventory: inventory,
    platformLocks: json('specs/005-analysis-final-closure/contracts/final-platform-locks.json'),
    performanceLocks: json('specs/005-analysis-final-closure/contracts/performance-locks.json'),
    packageJson: json('package.json'),
    workflowText: text('.github/workflows/final-closure-preflight.yml'),
    preFanoutText: text('specs/005-analysis-final-closure/evidence/pre-fanout.md'),
    checkpointEvidenceText: readOptionalAt(root, commitSha, inventory.checkpoint.evidencePath),
    shadowAuthority,
    verifierText: text(PREFLIGHT_PATH),
  };
}

function createFixture({ packageTransform = null, dataModelTransform = null, tasksTransform = null,
  splitComponent = false } = {}) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-t061-maintenance-'));
  const root = path.join(sandbox, 'repo');
  runGit(SOURCE_ROOT, ['clone', '--quiet', '--shared', '--no-checkout', SOURCE_ROOT, root]);
  runGit(root, ['checkout', '--quiet', '--detach', BASE_SHA]);
  runGit(root, ['config', 'user.name', 'T061 maintenance fixture']);
  runGit(root, ['config', 'user.email', 't061-fixture@example.invalid']);

  const integration = runGit(root, ['rev-parse', 'HEAD']);
  const priorInventory = JSON.parse(readAt(root, integration, INVENTORY_PATH));
  assert.equal(priorInventory.stageAMaintenanceTransfer, undefined);
  assert.equal(priorInventory.taskHandoffs.T052.headSha, ORIGINAL_T052_HANDOFF_SHA);
  const preimage = readAt(root, ORIGINAL_T052_HANDOFF_SHA, T052_PATH);
  assert.equal(hashBlob(root, preimage), PREIMAGE_BLOB_SHA);
  const postimage = reviewedT052Postimage(preimage);
  assert.equal(hashBlob(root, postimage), POSTIMAGE_BLOB_SHA);
  const priorLedger = stageLedger(root, integration, priorInventory);
  const priorRow = priorLedger.checkpoints.at(-1);

  // C contains the bounded verifier/governance/test amendment. The T061 row
  // is pending here; P is the only commit that changes it to DONE.
  const sourcePreflight = fs.readFileSync(path.join(SOURCE_ROOT, PREFLIGHT_PATH), 'utf8');
  writeFile(root, PREFLIGHT_PATH, `${sourcePreflight}\n// T061 fixture component boundary\n`);
  const sourceFixtureTest = fs.readFileSync(path.join(SOURCE_ROOT, T061_TEST_PATH), 'utf8');
  writeFile(root, T061_TEST_PATH, `${sourceFixtureTest}\n// T061 fixture replay boundary\n`);
  const sourceDataModel = fs.readFileSync(path.join(SOURCE_ROOT, DATA_MODEL_PATH), 'utf8');
  const initialDataModel = splitComponent
    ? readAt(SOURCE_ROOT, PRIOR_COMPONENT_SHA, DATA_MODEL_PATH)
    : sourceDataModel;
  writeFile(root, DATA_MODEL_PATH, dataModelTransform
    ? dataModelTransform(initialDataModel, readAt(root, integration, DATA_MODEL_PATH))
    : initialDataModel);
  writeFile(root, T052_PATH, postimage);

  const t061Task = [
    '- [ ] T061 [CAMP] Transfer the reviewed T052 maintenance fixture under a bounded continuation',
    '  - **Contract** — Objective: carry the reviewed T052 fixture correction through one typed maintenance transfer while retaining the original T052 handoff. Current evidence: T052 is DONE with a sealed preimage and the current main fixture contract requires the reviewed postimage. Owner/model: SOL Ultra integration owner with separate Luna Max review. Risk: RELEASE. Dependencies: T052 and T060. Owned paths: bounded maintenance verifier, fixture regression, task and ownership continuation, and transfer evidence. Delta: add one pending maintenance row and prove the exact T052 preimage-to-postimage transfer through an ordinary product checkpoint. Negative counterexample: direct T052 reseal, owner reassignment without a receipt, rewritten historic handoff, or stale product proof. Tests: actual Git lineage, receipt deletion and rewrite, wrong-head and stale-blob negatives. Integration test: unchanged T052 owned, rolling, and central shadow proof over the fixed accepted task IDs. Completion evidence: one immutable transfer receipt, exact owner transition, and replayable generated product. Status: PENDING.',
  ].join('\n') + '\n';
  const amendedTasks = amendT049Dependencies(readAt(root, integration, TASKS_PATH));
  const amendedTaskText = `${amendedTasks.trimEnd()}\n\n${t061Task}`;
  writeFile(root, TASKS_PATH, tasksTransform ? tasksTransform(amendedTaskText) : amendedTaskText);

  const amendedOwnership = JSON.parse(readAt(root, integration, OWNERSHIP_PATH));
  amendedOwnership.tasks.T061 = {
    maintenanceClass: 'STAGE_A_MAINTENANCE',
    allowedPaths: [...T061_MAINTENANCE_PATHS, T061_EVIDENCE_PATH],
    forbiddenOverlap: [
      'one-time T052 to T061 ownership transfer only',
      'existing T052, T058 and T060 handoffs and candidate gates remain immutable',
      'no production collaboration source or generated-output ownership',
    ],
  };
  writeFile(root, OWNERSHIP_PATH, `${JSON.stringify(amendedOwnership, null, 2)}\n`);
  if (packageTransform) writeFile(root, 'package.json',
    packageTransform(readAt(root, integration, 'package.json')));
  let code = commit(root, 'T061 pending bounded maintenance component');
  let codeTree = runGit(root, ['rev-parse', `${code}^{tree}`]);
  if (splitComponent) {
    writeFile(root, DATA_MODEL_PATH, dataModelTransform
      ? dataModelTransform(sourceDataModel, readAt(root, integration, DATA_MODEL_PATH))
      : sourceDataModel);
    code = commit(root, 'T061 append bounded data-model suffix');
    codeTree = runGit(root, ['rev-parse', `${code}^{tree}`]);
  }
  const codePaths = changedPaths(root, integration, code);
  assert.deepEqual(codePaths, [...T061_REQUIRED_COMPONENT_PATHS, ...(packageTransform ? ['package.json'] : [])].sort((a, b) => Buffer.from(a).compare(Buffer.from(b))));

  const acceptedMergeTree = codeTree;
  const merge = commitTree(root, acceptedMergeTree, [integration, code], 'T061 accepted maintenance merge');
  runGit(root, ['checkout', '--quiet', '--detach', merge]);

  // G is a generated-only child of M. The structural verifier checks this
  // scope; runtime verification later authenticates the two build replay.
  const deploymentPath = path.join(root, 'js/userscript/deployment-identity.generated.js');
  fs.appendFileSync(deploymentPath, '\n// T061 generated product fixture\n');
  const templatePath = path.join(root, 'userscript/hex.user.template.js');
  fs.appendFileSync(templatePath, '\n// T061 generated product fixture\n');
  const releasePath = path.join(root, 'userscript/release-version.json');
  const release = JSON.parse(fs.readFileSync(releasePath, 'utf8'));
  release.serial = Number.isSafeInteger(release.serial) ? release.serial + 1 : 1;
  fs.writeFileSync(releasePath, `${JSON.stringify(release, null, 2)}\n`);
  const generated = commit(root, 'T061 generated product fixture');
  const generatedTree = runGit(root, ['rev-parse', `${generated}^{tree}`]);
  const candidateIdentity = { headSha: generated, treeSha: generatedTree };
  const generatedOwnership = JSON.parse(readAt(root, generated, OWNERSHIP_PATH));
  const rollingProductGates = executeRollingProductGates({
    root,
    ownership: generatedOwnership,
    ownershipCommitSha: generated,
    taskIds: priorRow.rollingProductGates.taskIds,
    candidateIdentity,
    spawn: successfulMaintenanceSpawn,
  });
  const shadowReports = priorRow.rollingProductGates.taskIds.map((taskId) => {
    const gate = generatedOwnership.candidateGates?.tasks?.[taskId]?.shadow?.[0];
    assert.ok(gate, `fixture shadow gate is present for ${taskId}`);
    return emitShadowGateEvidence({
      root,
      taskId,
      expectedSha: generated,
      expectedTree: generatedTree,
      authoritySha: merge,
      spawn: (_command, argv) => {
        const side = argv.some((value) => String(value).includes('oracle-observer'))
          ? 'oracle' : 'product';
        const priorReport = priorRow.independentShadowVerifier.reports.find(
          (report) => report.taskId === taskId && report.gateId === gate.id,
        );
        assert.ok(priorReport, `fixture shadow observation is present for ${taskId}`);
        return {
          status: 0,
          signal: null,
          error: null,
          stdout: JSON.stringify(priorReport.observations[side]),
          stderr: '',
        };
      },
    });
  });
  const independentShadowVerifier = checkpointShadowGateEvidence(candidateIdentity, shadowReports);
  const maintenanceGates = executeT061MaintenanceGates({
    root,
    candidateIdentity: { headSha: generated, treeSha: generatedTree },
    spawn: successfulMaintenanceSpawn,
    assertCandidateState: (label) => assertEphemeralStateClean(root, label),
  });
  const acceptedMerge = { commitSha: merge, treeSha: acceptedMergeTree };
  const checkpointProduct = { commitSha: generated, treeSha: generatedTree };
  const integrationReconciliation = {
    schemaVersion: 'hex-final-closure-product-reconciliation/v1',
    ownerTaskId: 'T049',
    mergeCommitSha: merge,
    productCommitSha: generated,
    paths: [],
    pathCount: 0,
    stableDigest: '09612b07b5ecb5a5359f19cb0456e970',
  };
  const generation = checkpointGenerationEvidence(root, {
    acceptedMerge,
    checkpointProduct,
    integrationReconciliation,
  });
  const acceptedTaskIds = priorLedger.checkpoints.map((row) => row.acceptedTaskId);
  const product = {
    schemaVersion: T061_PRODUCT_SCHEMA,
    acceptedTaskIds,
    acceptedMerge,
    checkpointProduct,
    integrationReconciliation,
    generation,
    rollingProductGates,
    independentShadowVerifier,
    initialCandidateGateDigest: priorRow.initialCandidateGateDigest,
    maintenanceGates,
  };

  const evidenceText = [
    '# T061 maintenance transfer fixture',
    '',
    `Integration predecessor: ${integration}`,
    `Component head: ${code}`,
    `Component tree: ${codeTree}`,
    `Accepted merge: ${merge}`,
    `Generated product: ${generated}`,
    `Original T052 handoff: ${ORIGINAL_T052_HANDOFF_SHA}`,
    `Preimage blob: ${PREIMAGE_BLOB_SHA}`,
    `Postimage blob: ${POSTIMAGE_BLOB_SHA}`,
  ].join('\n') + '\n';
  writeFile(root, T061_EVIDENCE_PATH, evidenceText);
  const evidence = commit(root, 'T061 maintenance transfer evidence');
  const evidenceTree = runGit(root, ['rev-parse', `${evidence}^{tree}`]);

  const receipt = {
    schemaVersion: T061_RECEIPT_SCHEMA,
    predecessor: {
      taskId: 'T052',
      integration: { headSha: integration, treeSha: runGit(root, ['rev-parse', `${integration}^{tree}`]) },
      originalHandoff: structuredClone(priorInventory.taskHandoffs.T052),
    },
    successorTaskId: 'T061',
    component: { headSha: code, treeSha: codeTree, paths: codePaths },
    product,
    evidence: { headSha: evidence, treeSha: evidenceTree },
    paths: [...codePaths, T061_EVIDENCE_PATH],
    transfer: {
      path: T052_PATH,
      oldOwnerTaskId: 'T052',
      newOwnerTaskId: 'T061',
      preimageBlobSha1: PREIMAGE_BLOB_SHA,
      postimageBlobSha1: POSTIMAGE_BLOB_SHA,
    },
  };

  // P is deliberately the only publication/activation commit. It changes
  // exactly inventory + tasks, changes only T061 to DONE, and publishes the
  // owner/blob transfer with no T052 handoff rewrite.
  const publishedInventory = structuredClone(priorInventory);
  publishedInventory.stageAMaintenanceTransfer = receipt;
  publishedInventory.taskHandoffs.T061 = {
    headSha: code,
    treeSha: codeTree,
    evidencePath: T061_TEST_PATH,
  };
  const pathsAtEvidence = changedPaths(root, priorInventory.baseSha, evidence);
  const priorEntryPaths = new Set(priorInventory.entries.map((entry) => entry.path));
  assert.deepEqual(
    pathsAtEvidence.filter((repoPath) => !priorEntryPaths.has(repoPath)),
    [...T049_GENERATED_PATHS, T061_TEST_PATH, T061_EVIDENCE_PATH]
      .filter((repoPath) => !priorEntryPaths.has(repoPath))
      .sort((left, right) => Buffer.from(left).compare(Buffer.from(right))),
    'fixture must account for only the bounded generated and T061 paths',
  );
  publishedInventory.expectedChangedPaths = pathsAtEvidence;
  publishedInventory.actualChangedPaths = pathsAtEvidence;
  publishedInventory.unionChangedPaths = pathsAtEvidence;
  const entries = new Map((priorInventory.entries || []).map((entry) => [entry.path, entry]));
  for (const repoPath of pathsAtEvidence) {
    if (!entries.has(repoPath)) {
      const ownerTaskId = T049_GENERATED_PATHS.includes(repoPath) ? 'T049' : 'T061';
      entries.set(repoPath, { path: repoPath, ownerTaskId });
    }
  }
  entries.set(T052_PATH, { ...entries.get(T052_PATH), ownerTaskId: 'T061' });
  publishedInventory.entries = [...entries.values()]
    .filter((entry) => pathsAtEvidence.includes(entry.path));
  writeFile(root, INVENTORY_PATH, `${JSON.stringify(publishedInventory, null, 2)}\n`);
  const evidenceTasks = readAt(root, evidence, TASKS_PATH);
  const publishedTasks = completeT061Task(evidenceTasks);
  writeFile(root, TASKS_PATH, publishedTasks);
  const publication = commit(root, 'T061 publish maintenance transfer and handoff');
  const actualPaths = changedPaths(root, priorInventory.baseSha, publication);
  assert.deepEqual(actualPaths, pathsAtEvidence, 'publication must not widen the inventory path set');
  assert.deepEqual(
    JSON.parse(readAt(root, publication, INVENTORY_PATH)).expectedChangedPaths,
    actualPaths,
  );
  return Object.freeze({
    sandbox,
    root,
    integration,
    code,
    codeTree,
    merge,
    generated,
    generatedTree,
    evidence,
    evidenceTree,
    publication,
    receipt,
    priorInventory,
    publishedInventory,
    acceptedTaskIds,
    maintenanceGates,
  });
}

function mutatePublication(fixture, label, mutator) {
  runGit(fixture.root, ['checkout', '--quiet', '--detach', fixture.publication]);
  const inventory = JSON.parse(fs.readFileSync(path.join(fixture.root, INVENTORY_PATH), 'utf8'));
  mutator(inventory);
  writeFile(fixture.root, INVENTORY_PATH, `${JSON.stringify(inventory, null, 2)}\n`);
  return commit(fixture.root, label);
}

// Construct the first publication from its E parent. This keeps the receipt
// immutable from the verifier's point of view: each mutation is present in
// the first receipt-bearing commit, so a rejection cannot be explained only
// by a later receipt rewrite.
function firstPublicationMutation(fixture, label, mutator, parentSha = fixture.evidence) {
  runGit(fixture.root, ['checkout', '--quiet', '--detach', parentSha]);
  const inventory = JSON.parse(readAt(fixture.root, fixture.publication, INVENTORY_PATH));
  const tasks = readAt(fixture.root, fixture.publication, TASKS_PATH);
  mutator(inventory);
  writeFile(fixture.root, INVENTORY_PATH, `${JSON.stringify(inventory, null, 2)}\n`);
  writeFile(fixture.root, TASKS_PATH, tasks);
  return commit(fixture.root, label);
}

function firstEscapedReceiptPublication(fixture) {
  runGit(fixture.root, ['checkout', '--quiet', '--detach', fixture.evidence]);
  const inventory = JSON.parse(readAt(fixture.root, fixture.publication, INVENTORY_PATH));
  const tasks = readAt(fixture.root, fixture.publication, TASKS_PATH);
  const serialized = JSON.stringify(inventory, null, 2)
    .replace('"stageAMaintenanceTransfer":', '"\\u0073tageAMaintenanceTransfer":');
  writeFile(fixture.root, INVENTORY_PATH, `${serialized}\n`);
  writeFile(fixture.root, TASKS_PATH, tasks);
  return commit(fixture.root, 'T061 escaped-key receipt publication');
}

function rebindMaintenanceEvidence(fixture, text, identities) {
  let rebound = text;
  rebound = replaceOnce(rebound, `Integration predecessor: ${fixture.integration}`,
    `Integration predecessor: ${identities.integration}`);
  rebound = replaceOnce(rebound, `Component head: ${fixture.code}`,
    `Component head: ${identities.code}`);
  rebound = replaceOnce(rebound, `Component tree: ${fixture.codeTree}`,
    `Component tree: ${identities.codeTree}`);
  rebound = replaceOnce(rebound, `Accepted merge: ${fixture.merge}`,
    `Accepted merge: ${identities.merge}`);
  rebound = replaceOnce(rebound, `Generated product: ${fixture.generated}`,
    `Generated product: ${identities.generated}`);
  return rebound;
}

function firstPublicationWithProductLineage(fixture, label, {
  merge = fixture.merge,
  mergeTree = fixture.codeTree,
  generated = fixture.generated,
  generatedTree = fixture.generatedTree,
  evidence = fixture.evidence,
  evidenceTree = fixture.evidenceTree,
} = {}, parentSha = evidence) {
  return firstPublicationMutation(fixture, label, (inventory) => {
    const receipt = inventory.stageAMaintenanceTransfer;
    receipt.product.acceptedMerge = { commitSha: merge, treeSha: mergeTree };
    receipt.product.checkpointProduct = { commitSha: generated, treeSha: generatedTree };
    receipt.evidence = { headSha: evidence, treeSha: evidenceTree };
  }, parentSha);
}

function makeBadMergeParentLineage(fixture) {
  const badMerge = commitTree(fixture.root, fixture.codeTree,
    [fixture.code, fixture.integration], 'T061 invalid reversed merge parents');
  const badGenerated = commitTree(fixture.root, fixture.generatedTree,
    [badMerge], 'T061 generated child of invalid merge');
  runGit(fixture.root, ['checkout', '--quiet', '--detach', badGenerated]);
  const evidenceText = rebindMaintenanceEvidence(
    fixture,
    readAt(fixture.root, fixture.evidence, T061_EVIDENCE_PATH),
    { integration: fixture.integration, code: fixture.code, codeTree: fixture.codeTree,
      merge: badMerge, generated: badGenerated },
  );
  writeFile(fixture.root, T061_EVIDENCE_PATH, evidenceText);
  const badEvidence = commit(fixture.root, 'T061 evidence for invalid merge parents');
  return {
    merge: badMerge,
    mergeTree: fixture.codeTree,
    generated: badGenerated,
    generatedTree: fixture.generatedTree,
    evidence: badEvidence,
    evidenceTree: runGit(fixture.root, ['rev-parse', `${badEvidence}^{tree}`]),
  };
}

function makeBadGeneratedParentLineage(fixture) {
  const badGenerated = commitTree(fixture.root, fixture.generatedTree,
    [fixture.integration], 'T061 invalid generated parent');
  runGit(fixture.root, ['checkout', '--quiet', '--detach', badGenerated]);
  const evidenceText = rebindMaintenanceEvidence(
    fixture,
    readAt(fixture.root, fixture.evidence, T061_EVIDENCE_PATH),
    { integration: fixture.integration, code: fixture.code, codeTree: fixture.codeTree,
      merge: fixture.merge, generated: badGenerated },
  );
  writeFile(fixture.root, T061_EVIDENCE_PATH, evidenceText);
  const badEvidence = commit(fixture.root, 'T061 evidence for invalid generated parent');
  return {
    merge: fixture.merge,
    mergeTree: fixture.codeTree,
    generated: badGenerated,
    generatedTree: fixture.generatedTree,
    evidence: badEvidence,
    evidenceTree: runGit(fixture.root, ['rev-parse', `${badEvidence}^{tree}`]),
  };
}

function makeEvidenceScopeLineage(fixture) {
  runGit(fixture.root, ['checkout', '--quiet', '--detach', fixture.generated]);
  writeFile(fixture.root, T061_EVIDENCE_PATH,
    readAt(fixture.root, fixture.evidence, T061_EVIDENCE_PATH));
  const extraPath = 'tests/final-closure/t061-maintenance-extra-evidence.txt';
  writeFile(fixture.root, extraPath, 'unexpected evidence-scope path\n');
  const badEvidence = commit(fixture.root, 'T061 evidence with an extra path');
  return {
    merge: fixture.merge,
    mergeTree: fixture.codeTree,
    generated: fixture.generated,
    generatedTree: fixture.generatedTree,
    evidence: badEvidence,
    evidenceTree: runGit(fixture.root, ['rev-parse', `${badEvidence}^{tree}`]),
  };
}

function expectInvalid(action, reason = null) {
  assert.throws(action, (error) => {
    assert.match(String(error?.message), /t061-maintenance-invalid:/);
    if (reason) assert.match(String(error?.message), new RegExp(`t061-maintenance-invalid:${reason}`));
    return true;
  });
}

function cloneAt(source, commitSha) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-t061-gate-'));
  const root = path.join(sandbox, 'repo');
  runGit(source, ['clone', '--quiet', '--shared', '--no-checkout', source, root]);
  runGit(root, ['checkout', '--quiet', '--detach', commitSha]);
  runGit(root, ['config', 'user.name', 'T061 maintenance gate fixture']);
  runGit(root, ['config', 'user.email', 't061-gate@example.invalid']);
  return { root, sandbox };
}

function assertEphemeralStateClean(root, label) {
  const result = spawnSync(GIT, [
    'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching',
  ], { cwd: root, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  if (result.status !== 0 || String(result.stdout) !== '') {
    throw new Error(`t061-maintenance-invalid:runtime-product-mutated:${label}`);
  }
}

function successfulMaintenanceSpawn(command, argv) {
  return {
    status: 0,
    signal: null,
    error: null,
    stdout: Buffer.from(`fixture gate: ${command} ${argv.join(' ')}\n`),
    stderr: Buffer.alloc(0),
  };
}

function maintenanceGateProduct(fixture, mutate) {
  const product = structuredClone(fixture.receipt.product);
  mutate(product.maintenanceGates, product);
  return product;
}

const fixture = createFixture();
test.after(() => fs.rmSync(fixture.sandbox, { recursive: true, force: true }));

  test('T061 exact actual-Git receipt structure accepts the one-time transfer', () => {
    const result = verifyT061MaintenanceStructure(
      fixture.root,
      bundleAt(fixture.root, fixture.publication),
      { expectedSha: fixture.publication },
    );
    assert.equal(result.integration, fixture.integration);
    assert.equal(result.code, fixture.code);
    assert.equal(result.evidence, fixture.evidence);
    assert.equal(result.publication, fixture.publication);
    assert.equal(result.transfer.preimageBlobSha1, PREIMAGE_BLOB_SHA);
    assert.equal(result.transfer.postimageBlobSha1, POSTIMAGE_BLOB_SHA);
  });

  test('T061 maintenance bridge exempts only the authenticated T046 data-model path', () => {
    const contract = validatePreflightContracts(bundleAt(fixture.root, fixture.publication));
    assert.equal(contract.ok, true, contract.errors?.join('\n'));
    const handoffResult = verifyTaskHandoffs(
      fixture.root,
      contract,
      fixture.publication,
    );
    assert.equal(handoffResult.maintenancePublicationCommitSha, fixture.publication);

    const unrelated = contract.taskHandoffResult.inventoryEntries.find(
      (entry) => entry.ownerTaskId === 'T046' && entry.path !== DATA_MODEL_PATH,
    );
    assert.ok(unrelated, 'the fixture must retain an unrelated T046-owned path');
    for (const repoPath of [DATA_MODEL_PATH, unrelated.path]) {
      runGit(fixture.root, ['checkout', '--quiet', '--detach', fixture.publication]);
      fs.appendFileSync(path.join(fixture.root, repoPath), '\n');
      const mutatedHead = commit(fixture.root, `T061 mutate T046-owned path ${repoPath}`);
      assert.throws(
        () => verifyTaskHandoffs(fixture.root, contract, mutatedHead),
        (error) => {
          assert.match(
            String(error?.message),
            new RegExp(`task-handoff-owned-path-changed:T046:${repoPath}`),
          );
          return true;
        },
      );
    }
  });

  test('T061 transfer wrapper accepts only the recorded maintenance gate proof', () => {
    const result = verifyT061MaintenanceTransfer(
      fixture.root,
      bundleAt(fixture.root, fixture.publication),
      { expectedSha: fixture.publication },
    );
    assert.equal(result.publication, fixture.publication);
    assert.deepEqual(result.product.maintenanceGates, fixture.maintenanceGates);
  });

  test('T061 maintenance execution rejects failed, signalled, errored, or empty gate results', () => {
    const identity = { headSha: fixture.generated, treeSha: fixture.generatedTree };
    const cases = [
      {
        label: 'nonzero',
        spawn: () => ({ ...successfulMaintenanceSpawn('node', []), status: 1 }),
        reason: 'gate-failed:t052-owned-regressions:1',
      },
      {
        label: 'signal',
        spawn: () => ({ ...successfulMaintenanceSpawn('node', []), signal: 'SIGTERM' }),
        reason: 'gate-failed:t052-owned-regressions:0',
      },
      {
        label: 'spawn-error',
        spawn: () => ({ ...successfulMaintenanceSpawn('node', []), error: { code: 'ENOENT' } }),
        reason: 'gate-failed:t052-owned-regressions:0',
      },
      {
        label: 'empty-stdout',
        spawn: () => ({ ...successfulMaintenanceSpawn('node', []), stdout: Buffer.alloc(0) }),
        reason: 'gate-empty:t052-owned-regressions',
      },
    ];
    for (const { spawn, reason } of cases) {
      const { root, sandbox } = cloneAt(fixture.root, fixture.generated);
      try {
        expectInvalid(() => executeT061MaintenanceGates({
          root,
          candidateIdentity: identity,
          spawn,
          assertCandidateState: (label) => assertEphemeralStateClean(root, label),
        }), reason);
      } finally {
        fs.rmSync(sandbox, { recursive: true, force: true });
      }
    }
  });

  test('T061 maintenance execution rejects candidate tree mutation after a gate', () => {
    const { root, sandbox } = cloneAt(fixture.root, fixture.generated);
    try {
      let calls = 0;
      expectInvalid(() => executeT061MaintenanceGates({
        root,
        candidateIdentity: { headSha: fixture.generated, treeSha: fixture.generatedTree },
        assertCandidateState: (label) => assertEphemeralStateClean(root, label),
        spawn: (command, argv) => {
          calls += 1;
          const result = successfulMaintenanceSpawn(command, argv);
          if (calls === 1) fs.appendFileSync(path.join(root, 'package.json'), '\n');
          return result;
        },
      }), 'runtime-product-mutated');
      assert.equal(calls, 1);
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test('T061 maintenance execution requires candidate-state callback', () => {
    const { root, sandbox } = cloneAt(fixture.root, fixture.generated);
    try {
      let calls = 0;
      expectInvalid(() => executeT061MaintenanceGates({
        root,
        candidateIdentity: { headSha: fixture.generated, treeSha: fixture.generatedTree },
        spawn: (command, argv) => {
          calls += 1;
          return successfulMaintenanceSpawn(command, argv);
        },
      }), 'runtime-state-check-required');
      assert.equal(calls, 0, 'the helper must fail before running a gate without state proof');
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test('T061 maintenance execution rejects ignored mutation through candidate-state callback', () => {
    const { root, sandbox } = cloneAt(fixture.root, fixture.generated);
    try {
      fs.appendFileSync(path.join(root, '.git', 'info', 'exclude'), '\n.t061-ignored-probe\n');
      const ignoredPath = path.join(root, '.t061-ignored-probe');
      let gateCalls = 0;
      const callbackLabels = [];
      expectInvalid(() => executeT061MaintenanceGates({
        root,
        candidateIdentity: { headSha: fixture.generated, treeSha: fixture.generatedTree },
        assertCandidateState: (label) => {
          callbackLabels.push(label);
          assertEphemeralStateClean(root, label);
        },
        spawn: (command, argv) => {
          gateCalls += 1;
          if (gateCalls === 1) fs.writeFileSync(ignoredPath, 'ignored mutation\n');
          return successfulMaintenanceSpawn(command, argv);
        },
      }), 'runtime-product-mutated');
      assert.equal(gateCalls, 1, 'the ignored mutation must stop replay after the first gate');
      assert.ok(callbackLabels.length >= 2, 'state callback must run before and after gate execution');
      assert.equal(fs.existsSync(ignoredPath), true);
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test('T061 maintenance execution rejects ignored mutation without callback support', () => {
    const { root, sandbox } = cloneAt(fixture.root, fixture.generated);
    try {
      fs.appendFileSync(path.join(root, '.git', 'info', 'exclude'), '\n.t061-self-contained-ignored\n');
      const ignoredPath = path.join(root, '.t061-self-contained-ignored');
      let gateCalls = 0;
      expectInvalid(() => executeT061MaintenanceGates({
        root,
        candidateIdentity: { headSha: fixture.generated, treeSha: fixture.generatedTree },
        assertCandidateState: () => {},
        spawn: (command, argv) => {
          gateCalls += 1;
          if (gateCalls === 1) fs.writeFileSync(ignoredPath, 'ignored mutation\n');
          return successfulMaintenanceSpawn(command, argv);
        },
      }), 'runtime-ephemeral-mutated');
      assert.equal(gateCalls, 1, 'the canonical manifest must stop replay after the first gate');
      assert.equal(fs.existsSync(ignoredPath), true);
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test('T061 recorded maintenance gates reject envelope and identity mutations', () => {
    const cases = [
      {
        label: 'argv',
        mutate: (record) => { record.results[0].argv[0] = 'sh'; },
        reason: 'maintenance-gates-command',
      },
      {
        label: 'omitted-result',
        mutate: (record) => { record.results.pop(); },
        reason: 'maintenance-gates-schema',
      },
      {
        label: 'empty-output',
        mutate: (record) => { record.results[0].stdout.byteLength = 0; },
        reason: 'maintenance-gates-empty',
      },
      {
        label: 'nonzero',
        mutate: (record) => { record.results[0].exitCode = 1; },
        reason: 'maintenance-gates-command',
      },
      {
        label: 'old-head',
        mutate: (record) => { record.candidateIdentity.headSha = fixture.merge; },
        reason: 'maintenance-gates-schema',
      },
      {
        label: 'old-verifier',
        mutate: (record) => { record.verifier.sha256 = '0'.repeat(64); },
        reason: 'maintenance-gates-schema',
      },
    ];
    expectInvalid(
      () => verifyT061MaintenanceGates(fixture.root, maintenanceGateProduct(fixture,
        (_record, product) => { delete product.maintenanceGates; })),
      'maintenance-gates-schema',
    );
    for (const { mutate, reason } of cases) {
      expectInvalid(
        () => verifyT061MaintenanceGates(fixture.root, maintenanceGateProduct(fixture, mutate)),
        reason,
      );
    }
  });

  test('T061 absent receipt returns null only when Git history has no publication', () => {
    const result = verifyT061MaintenanceTransfer(
      fixture.root,
      bundleAt(fixture.root, fixture.integration),
      { expectedSha: fixture.integration },
    );
    assert.equal(result, null);
  });

  test('T061 rejects a stale expected head and a mismatched bundle', () => {
    expectInvalid(
      () => verifyT061MaintenanceStructure(
        fixture.root,
        bundleAt(fixture.root, fixture.publication),
        { expectedSha: fixture.integration },
      ),
      'bundle',
    );
  });

  test('T061 rejects first-publication predecessor, component tree, and scope mutations', () => {
    const wrongPredecessor = firstPublicationMutation(fixture, 'T061 wrong predecessor', (inventory) => {
      inventory.stageAMaintenanceTransfer.predecessor.integration.headSha = fixture.code;
    });
    expectInvalid(() => verifyT061MaintenanceStructure(
      fixture.root,
      bundleAt(fixture.root, wrongPredecessor),
      { expectedSha: wrongPredecessor },
    ), 'integration-identity');

    const wrongPredecessorState = firstPublicationMutation(
      fixture,
      'T061 wrong predecessor state',
      (inventory) => {
        inventory.stageAMaintenanceTransfer.predecessor.originalHandoff.treeSha = fixture.codeTree;
      },
    );
    expectInvalid(() => verifyT061MaintenanceStructure(
      fixture.root,
      bundleAt(fixture.root, wrongPredecessorState),
      { expectedSha: wrongPredecessorState },
    ), 'predecessor-state');

    const wrongTree = firstPublicationMutation(fixture, 'T061 wrong component tree', (inventory) => {
      inventory.stageAMaintenanceTransfer.component.treeSha = fixture.integration.slice(0, 39) + '0';
    });
    expectInvalid(() => verifyT061MaintenanceStructure(
      fixture.root,
      bundleAt(fixture.root, wrongTree),
      { expectedSha: wrongTree },
    ), 'component-identity');

    const widened = firstPublicationMutation(fixture, 'T061 widened component scope', (inventory) => {
      inventory.stageAMaintenanceTransfer.component.paths.push('js/collaboration/index.js');
    });
    expectInvalid(() => verifyT061MaintenanceStructure(
      fixture.root,
      bundleAt(fixture.root, widened),
      { expectedSha: widened },
    ), 'code-path-set');
  });

  test('T061 rejects first-publication stale transfer blobs and historic handoff rewrites', () => {
    const wrongBlob = firstPublicationMutation(fixture, 'T061 wrong transfer blob', (inventory) => {
      inventory.stageAMaintenanceTransfer.transfer.preimageBlobSha1 = POSTIMAGE_BLOB_SHA;
    });
    expectInvalid(() => verifyT061MaintenanceStructure(
      fixture.root,
      bundleAt(fixture.root, wrongBlob),
      { expectedSha: wrongBlob },
    ), 'transfer');

    const rewrittenHandoff = firstPublicationMutation(fixture, 'T061 rewritten original handoff', (inventory) => {
      inventory.taskHandoffs.T052.treeSha = fixture.codeTree;
    });
    expectInvalid(() => verifyT061MaintenanceStructure(
      fixture.root,
      bundleAt(fixture.root, rewrittenHandoff),
      { expectedSha: rewrittenHandoff },
    ), 'inventory-delta');
  });

  test('T061 rejects first-publication M, G, E, and P lineage scope mutations', () => {
    const badMerge = makeBadMergeParentLineage(fixture);
    const badMergePublication = firstPublicationWithProductLineage(
      fixture,
      'T061 publication with reversed merge parents',
      badMerge,
      badMerge.evidence,
    );
    expectInvalid(() => verifyT061MaintenanceStructure(
      fixture.root,
      bundleAt(fixture.root, badMergePublication),
      { expectedSha: badMergePublication },
    ), 'merge');

    const badGenerated = makeBadGeneratedParentLineage(fixture);
    const badGeneratedPublication = firstPublicationWithProductLineage(
      fixture,
      'T061 publication with wrong generated parent',
      badGenerated,
      badGenerated.evidence,
    );
    expectInvalid(() => verifyT061MaintenanceStructure(
      fixture.root,
      bundleAt(fixture.root, badGeneratedPublication),
      { expectedSha: badGeneratedPublication },
    ), 'generation-scope');

    const badEvidence = makeEvidenceScopeLineage(fixture);
    const badEvidencePublication = firstPublicationWithProductLineage(
      fixture,
      'T061 publication with extra evidence path',
      badEvidence,
      badEvidence.evidence,
    );
    expectInvalid(() => verifyT061MaintenanceStructure(
      fixture.root,
      bundleAt(fixture.root, badEvidencePublication),
      { expectedSha: badEvidencePublication },
    ), 'evidence-scope');

    const extraPath = 'tests/final-closure/t061-maintenance-extra-publication.txt';
    const badPublication = firstPublicationMutation(
      fixture,
      'T061 publication with extra path',
      (inventory) => {
        writeFile(fixture.root, extraPath, 'unexpected publication-scope path\n');
        // Keep the receipt itself unchanged; the extra path must be rejected
        // by the E-to-P publication scope check.
        assert.ok(inventory.stageAMaintenanceTransfer);
      },
    );
    expectInvalid(() => verifyT061MaintenanceStructure(
      fixture.root,
      bundleAt(fixture.root, badPublication),
      { expectedSha: badPublication },
    ), 'publication-scope');
  });

  test('T061 rejects receipt deletion and receipt rewrite after publication', () => {
    const deleted = mutatePublication(fixture, 'T061 delete published receipt', (inventory) => {
      delete inventory.stageAMaintenanceTransfer;
    });
    expectInvalid(() => verifyT061MaintenanceStructure(
      fixture.root,
      bundleAt(fixture.root, deleted),
      { expectedSha: deleted },
    ), 'receipt-removed');

    const rewritten = mutatePublication(fixture, 'T061 rewrite published receipt', (inventory) => {
      inventory.stageAMaintenanceTransfer.successorTaskId = 'T052';
    });
    expectInvalid(() => verifyT061MaintenanceStructure(
      fixture.root,
      bundleAt(fixture.root, rewritten),
      { expectedSha: rewritten },
    ), 'receipt-rewritten');
  });

  test('T061 rejects receipt removal after escaped semantic publication', () => {
    const escapedPublication = firstEscapedReceiptPublication(fixture);
    const removed = JSON.parse(readAt(fixture.root, escapedPublication, INVENTORY_PATH));
    delete removed.stageAMaintenanceTransfer;
    delete removed.taskHandoffs.T061;
    writeFile(fixture.root, INVENTORY_PATH, `${JSON.stringify(removed, null, 2)}\n`);
    const removal = commit(fixture.root, 'T061 remove escaped-key receipt');
    expectInvalid(() => verifyT061MaintenanceStructure(
      fixture.root,
      bundleAt(fixture.root, removal),
      { expectedSha: removal },
    ), 'receipt-removed');
  });

  test('T061 distinguishes draft text from corrupted published receipt history', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 't061-draft-history-'));
    try {
      runGit(root, ['init', '--quiet']);
      writeFile(root, INVENTORY_PATH, 'prefanout fixture: inventory draft\n');
      commit(root, 'inventory predates maintenance protocol');
      writeFile(root, INVENTORY_PATH, '{"taskHandoffs":{}}\n');
      const head = commit(root, 'valid inventory without maintenance');
      assert.equal(verifyT061MaintenanceStructure(root, null, { expectedSha:head }), null);
    } finally {
      fs.rmSync(root, { recursive:true, force:true });
    }

    runGit(fixture.root, ['checkout', '--quiet', '--detach', fixture.publication]);
    const published = readAt(fixture.root, fixture.publication, INVENTORY_PATH);
    writeFile(fixture.root, INVENTORY_PATH, 'unreadable after publication\n');
    commit(fixture.root, 'corrupt published maintenance inventory');
    writeFile(fixture.root, INVENTORY_PATH, published);
    const restored = commit(fixture.root, 'restore current inventory after corruption');
    expectInvalid(() => verifyT061MaintenanceStructure(
      fixture.root, bundleAt(fixture.root, restored), { expectedSha:restored },
    ), 'receipt-unreadable');
  });

  test('T061 rejects owner regression after the explicit transfer', () => {
    const reverted = mutatePublication(fixture, 'T061 revert transferred owner', (inventory) => {
      const entry = inventory.entries.find((candidate) => candidate.path === T052_PATH);
      entry.ownerTaskId = 'T052';
    });
    expectInvalid(() => verifyT061MaintenanceStructure(
      fixture.root,
      bundleAt(fixture.root, reverted),
      { expectedSha: reverted },
    ), 'owner-regressed');
  });

  test('T061 rejects a historical data-model rewrite in the actual Git component', () => {
    const invalid = createFixture({ dataModelTransform: (text) => text.replace(
      '## ExternalBlocker', '## ExternalBlocker rewritten',
    ) });
    try {
      expectInvalid(() => verifyT061MaintenanceStructure(
        invalid.root, null, { expectedSha: invalid.publication },
      ), 'data-model-prefix');
    } finally { fs.rmSync(invalid.sandbox, { recursive: true, force: true }); }
  });

  test('T061 rejects an unbounded data-model suffix in the actual Git component', () => {
    const invalid = createFixture({ dataModelTransform: (text) =>
      `${text}\nUnreviewed maintenance prose.\n` });
    try {
      expectInvalid(() => verifyT061MaintenanceStructure(
        invalid.root, null, { expectedSha: invalid.publication },
      ), 'data-model-suffix');
    } finally { fs.rmSync(invalid.sandbox, { recursive: true, force: true }); }
  });

  test('T061 accepts a two-commit component that appends the bounded data-model suffix', () => {
    const split = createFixture({ splitComponent: true });
    try {
      assert.ok(verifyT061MaintenanceStructure(
        split.root, null, { expectedSha: split.publication },
      ));
    } finally { fs.rmSync(split.sandbox, { recursive: true, force: true }); }
  });

  test('T061 rejects prose trailing the bounded final task block', () => {
    const invalid = createFixture({ tasksTransform: (text) =>
      `${text}\nMaintenance note outside the T061 contract.\n` });
    try {
      expectInvalid(() => verifyT061MaintenanceStructure(
        invalid.root, null, { expectedSha: invalid.publication },
      ), 'tasks-text');
    } finally { fs.rmSync(invalid.sandbox, { recursive: true, force: true }); }
  });


test('T061 package preservation retains main commands and rejects either parent losing required gates', () => {
  const main = { name: 'fixture', scripts: { test: 'node base.mjs && node new-regression.mjs',
    'core:test': 'node core.mjs && node new-core-regression.mjs' }, dependencies: { example: '1.2.3' } };
  const candidate = structuredClone(main);
  candidate.scripts.test = `node tests/final-closure/run.mjs && ${main.scripts.test}`;
  assert.equal(verifyT061MaintenancePackage(JSON.stringify(main), JSON.stringify(candidate)), true);
  for (const mutate of [
    (value) => { value.scripts.test = main.scripts.test; },
    (value) => { value.scripts.test = 'node tests/final-closure/run.mjs && node base.mjs'; },
    (value) => { value.scripts['core:test'] = 'node core.mjs'; },
    (value) => { value.dependencies.example = '2.0.0'; },
  ]) {
    const invalid = structuredClone(candidate);
    mutate(invalid);
    assert.throws(() => verifyT061MaintenancePackage(JSON.stringify(main), JSON.stringify(invalid)),
      /package-main-preservation/);
  }
  assert.equal(verifyT061MaintenancePackage(JSON.stringify(candidate), JSON.stringify(candidate)), true);
  assert.throws(() => verifyT061MaintenancePackage('{}', JSON.stringify(candidate)), /package-main-preservation/);
});


test('T061 package preservation names every latest-main test and retains integration commands', () => {
  const main = {
    name: 'fixture',
    scripts: {
      test: 'node base.mjs && node integration-test.mjs',
      'core:test': 'node core.mjs && node tests/issue-4251-core-identity-slice-index.test.mjs',
      'platform:test': 'node platform.mjs && node tests/issue-6223-platform-regions-uncovered-segments.mjs',
      'binary:test': 'node binary.mjs && node tests/issue-6159-fingerprint-short-read-fail-closed.mjs && node tests/issue-6230-audit-executable-owner-resolution.mjs && node tests/issue-6234-fingerprint-uncovered-segments.mjs',
    },
    dependencies: { example: '1.2.3' },
  };
  const integration = {
    name: 'fixture',
    scripts: {
      test: 'node tests/final-closure/run.mjs && node base.mjs && node integration-test.mjs',
      'core:test': 'node core.mjs',
      'platform:test': 'node platform.mjs',
      'binary:test': 'node binary.mjs',
    },
    dependencies: { example: '1.2.3' },
  };
  const candidate = structuredClone(main);
  candidate.scripts.test = `node tests/final-closure/run.mjs && ${main.scripts.test}`;
  assert.equal(verifyT061MaintenancePackage(
    JSON.stringify(main), JSON.stringify(candidate), JSON.stringify(integration),
  ), true);

  const latestMainTests = [
    ['core:test', 'node tests/issue-4251-core-identity-slice-index.test.mjs'],
    ['platform:test', 'node tests/issue-6223-platform-regions-uncovered-segments.mjs'],
    ['binary:test', 'node tests/issue-6159-fingerprint-short-read-fail-closed.mjs'],
    ['binary:test', 'node tests/issue-6230-audit-executable-owner-resolution.mjs'],
    ['binary:test', 'node tests/issue-6234-fingerprint-uncovered-segments.mjs'],
  ];
  for (const [script, command] of latestMainTests) {
    const invalid = structuredClone(candidate);
    invalid.scripts[script] = invalid.scripts[script].split(' && ')
      .filter((entry) => entry !== command).join(' && ');
    assert.throws(() => verifyT061MaintenancePackage(
      JSON.stringify(main), JSON.stringify(invalid), JSON.stringify(integration),
    ), /package-main-preservation/);
  }

  // With the main expectation weakened in lockstep, only the authenticated
  // integration subsequence assertion can catch the dropped legacy command.
  const missingIntegrationMain = structuredClone(main);
  missingIntegrationMain.scripts.test = 'node base.mjs';
  const missingIntegrationCandidate = structuredClone(missingIntegrationMain);
  missingIntegrationCandidate.scripts.test =
    'node tests/final-closure/run.mjs && node base.mjs';
  assert.throws(() => verifyT061MaintenancePackage(
    JSON.stringify(missingIntegrationMain), JSON.stringify(missingIntegrationCandidate),
    JSON.stringify(integration),
  ), /package-main-preservation/);
});


test('T061 package preservation is enforced on the authenticated Git component', () => {
  const valid = createFixture({ packageTransform: (text) => JSON.stringify(JSON.parse(text), null, 4) + '\n' });
  try {
    assert.ok(verifyT061MaintenanceStructure(valid.root, null, { expectedSha: valid.publication }));
  } finally { fs.rmSync(valid.sandbox, { recursive: true, force: true }); }
  const invalid = createFixture({ packageTransform: (text) => {
    const value = JSON.parse(text);
    value.scripts['core:test'] = 'node tests/core-identity-contracts.mjs';
    return JSON.stringify(value, null, 2) + '\n';
  } });
  try {
    assert.throws(() => verifyT061MaintenanceStructure(invalid.root, null, { expectedSha: invalid.publication }),
      /package-main-preservation/);
  } finally { fs.rmSync(invalid.sandbox, { recursive: true, force: true }); }
});
