import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

import { stableDigest } from '../../js/core/identity/index.js';
import {
  discoverFinalClosureTests,
  ownedFinalClosureTestSubtrees,
  runFinalClosureTests,
} from './run.mjs';
import {
  EXPECTED_TASK_IDS,
  EXPECTED_EP_IDS,
  STAGE_B_RESIDUAL_COVERAGE_BLOCK,
  STAGE_B_RESIDUAL_COVERAGE_PATH,
  STAGE_B_RESIDUAL_COVERAGE_SCHEMA_VERSION,
  STAGE_B_ROADMAP_IDS,
  FROZEN_INITIAL_CANDIDATE_GATE_DIGEST,
  FROZEN_FOUNDATION_OWNERSHIP_DIGEST,
  FROZEN_PERFORMANCE_IDENTITIES,
  FROZEN_PLATFORM_IDENTITIES,
  assertExactHead,
  assertTerminalShadowCounterEvidence,
  canonicalTaskHandoffAnchor,
  changedPaths,
  checkpointGenerationEvidence,
  checkpointShadowGateEvidence,
  computeFoundationOwnershipDigest,
  computeInitialCandidateGateDigest,
  createShadowGateEvidence,
  deriveShadowProof,
  emitShadowGateEvidence,
  executeRollingProductGates,
  hashDirectoryTree,
  localWorkspaceIdentity,
  localStageWorktreeIdentity,
  persistentRefSnapshot,
  assertOnlyAllowedRefChanges,
  performanceSourceSnapshot,
  performanceThresholdSnapshot,
  prepareComponentCandidate,
  runComponentGates,
  runPreflight,
  stageBLocalReportSha256,
  staleEvidenceFields,
  validateIntegrationInventory,
  validatePreflightContracts,
  validateStageBApplicability,
  validateTaskInventory,
  verifyCheckpointOperationalEvidence,
  verifyCheckpointRuntimeEvidence,
  verifyLocalStageBWorktree,
  verifyStageBOperationalEvidence,
  verifyTaskHandoffs,
} from '../../tools/validation/final-closure/preflight.mjs';

const SOURCE_ROOT = process.cwd();
const tasksText = fs.readFileSync('specs/005-analysis-final-closure/tasks.md', 'utf8');
const ownership = JSON.parse(fs.readFileSync('specs/005-analysis-final-closure/contracts/task-ownership.json', 'utf8'));
const integrationInventory = JSON.parse(fs.readFileSync('specs/005-analysis-final-closure/contracts/integration-inventory.json', 'utf8'));
const platformLocks = JSON.parse(fs.readFileSync('specs/005-analysis-final-closure/contracts/final-platform-locks.json', 'utf8'));
const performanceLocks = JSON.parse(fs.readFileSync('specs/005-analysis-final-closure/contracts/performance-locks.json', 'utf8'));
const workflowText = fs.readFileSync('.github/workflows/final-closure-preflight.yml', 'utf8');
const preFanoutText = fs.readFileSync('specs/005-analysis-final-closure/evidence/pre-fanout.md', 'utf8');
const shadowAuthority = Object.fromEntries(
  ownership.candidateGates.shadowEvidence.authorityArtifacts.map((artifact) => [
    artifact.path,
    fs.readFileSync(artifact.path, 'utf8'),
  ]),
);
const shadowRegistry = JSON.parse(shadowAuthority[
  'tools/validation/final-closure/shadow/foundation/registry.json'
]);
const shadowContracts = JSON.parse(shadowAuthority[
  'tools/validation/final-closure/shadow/foundation/contracts.json'
]);

function validate(overrides = {}) {
  return validatePreflightContracts({
    tasksText,
    ownership,
    integrationInventory,
    platformLocks,
    performanceLocks,
    workflowText,
    preFanoutText,
    shadowAuthority,
    ...overrides,
  });
}

function assertIncludes(errors, code, message) {
  assert.ok(
    errors.some((error) => error === code || error.startsWith(`${code}:`)),
    `${message}\nexpected ${code}\nactual:\n${errors.join('\n')}`,
  );
}

function fixtureTaskBlocks(source) {
  return String(source || '')
    .split(/(?=^- \[[ x]\] T\d{3}\b)/m)
    .filter((block) => /^- \[[ x]\] T\d{3}\b/m.test(block));
}

function rewriteDependencies(source, taskId, replacement) {
  const expression = new RegExp(`(^- \\[[ x]\\] ${taskId}\\b[\\s\\S]*?Dependencies:)\\s*[\\s\\S]*?(\\.\\s+Owned paths:)`, 'm');
  const rewritten = source.replace(expression, `$1 ${replacement}$2`);
  assert.notEqual(rewritten, source, `dependency fixture must find ${taskId}`);
  return rewritten;
}

function rewriteTaskBlock(source, taskId, mutator) {
  const startMatch = new RegExp(`^- \\[[ x]\\] ${taskId}\\b`, 'm').exec(source);
  assert.ok(startMatch, `task fixture must find ${taskId}`);
  const start = startMatch.index;
  const tail = source.slice(start + 1);
  const nextOffset = tail.search(/\n- \[[ x]\] T\d{3}\b|\n---/);
  const end = nextOffset === -1 ? source.length : start + 1 + nextOffset;
  const rewritten = `${source.slice(0, start)}${mutator(source.slice(start, end))}${source.slice(end)}`;
  assert.notEqual(rewritten, source, `task fixture must change ${taskId}`);
  return rewritten;
}

function rewriteTaskStatus(source, taskId, status) {
  const marker = `] ${taskId} `;
  const block = fixtureTaskBlocks(source).find((candidate) => candidate.split('\n', 1)[0].includes(marker));
  assert.ok(block, `task fixture must find ${taskId}`);
  const expectedPrefix = `- [${status === 'DONE' ? 'x' : ' '}] ${taskId} `;
  if (block.startsWith(expectedPrefix) && block.includes(`Status: ${status}.`)) return source;
  return rewriteTaskBlock(source, taskId, (block) => block
    .replace(new RegExp(`^- \\[[ x]\\] ${taskId} `), `- [${status === 'DONE' ? 'x' : ' '}] ${taskId} `)
    .replace(/Status: (?:PENDING|BLOCKED_BY_CONCURRENT_WORK|DONE)\./, `Status: ${status}.`));
}

const valid = validate();
assert.equal(valid.ok, true, valid.errors.join('\n'));
assert.deepEqual(valid.taskIds, EXPECTED_TASK_IDS);
assert.equal(valid.requiredRuntimeClassCount, 2);
assert.equal(valid.requiredWorkloadCount, 14);
assert.equal(valid.integrationPathCount, integrationInventory.unionChangedPaths.length);
assert.equal(valid.foundationOwnershipDigest, FROZEN_FOUNDATION_OWNERSHIP_DIGEST);
assert.equal(computeFoundationOwnershipDigest(ownership), FROZEN_FOUNDATION_OWNERSHIP_DIGEST);
assert.equal(EXPECTED_EP_IDS.length, 30);
assert.deepEqual(
  valid.checkpointResult.remainingComponentTaskIds,
  [
    'T011', 'T012', 'T013', 'T014', 'T015', 'T016', 'T017',
    'T051', 'T052', 'T053', 'T054', 'T055', 'T056', 'T057',
  ],
  'T051-T057 are frozen Stage A components before any rolling checkpoint',
);
assert.deepEqual(
  Object.keys(ownership.candidateGates.tasks.T051.shadow[0]).sort(),
  ['argv', 'id'],
  'a frozen T051 shadow gate must resolve central authority instead of carrying a dynamic inline contract',
);

const incompletePreMortem = preFanoutText.replace(/^\| EP-030 .*$/m, '');
assertIncludes(
  validate({ preFanoutText: incompletePreMortem }).errors,
  'premortem-ep-set-invalid',
  'the pre-mortem must classify every EP-001 through EP-030 exactly once',
);

const discoveredFinalClosureTests = discoverFinalClosureTests(path.join(SOURCE_ROOT, 'tests/final-closure'));
assert.ok(
  discoveredFinalClosureTests.includes('preflight.test.mjs'),
  'the canonical runner must always discover its preflight regression',
);
assert.equal(
  new Set(discoveredFinalClosureTests).size,
  discoveredFinalClosureTests.length,
  'the canonical runner discovery list must be duplicate-free',
);
assert.deepEqual(
  discoveredFinalClosureTests,
  [...discoveredFinalClosureTests].sort((left, right) => Buffer.from(left).compare(Buffer.from(right))),
  'the canonical runner discovery list must be bytewise sorted',
);
const ownedTestSubtrees = ownedFinalClosureTestSubtrees(ownership);
assert.ok(ownedTestSubtrees.length > 0, 'component test subtrees must be machine-readable');
const sentinelRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-final-closure-discovery-'));
try {
  const passingSentinel = 'import assert from "node:assert/strict";\nassert.equal(2 + 2, 4);\n';
  write(sentinelRoot, 'preflight.test.mjs', passingSentinel);
  write(sentinelRoot, 't049/nested/future.test.mjs', passingSentinel);
  const expectedSentinels = ['preflight.test.mjs', 't049/nested/future.test.mjs'];
  for (const subtree of ownedTestSubtrees) {
    const runnerRelativeSubtree = subtree.slice('tests/final-closure/'.length);
    const sentinel = `${runnerRelativeSubtree}/nested/sentinel.test.mjs`;
    write(sentinelRoot, sentinel, passingSentinel);
    expectedSentinels.push(sentinel);
  }
  assert.deepEqual(
    discoverFinalClosureTests(sentinelRoot),
    expectedSentinels.sort((left, right) => Buffer.from(left).compare(Buffer.from(right))),
    'owned nested sentinels and the first future task test must be discovered without closing the test world',
  );
  const nestedRun = runFinalClosureTests([], { root: sentinelRoot });
  assert.equal(nestedRun.selected, expectedSentinels.length, 'the shared phase runner must execute every passing sentinel');
} finally {
  fs.rmSync(sentinelRoot, { recursive: true, force: true });
}
assert.ok(
  JSON.parse(fs.readFileSync('package.json', 'utf8')).scripts.test.startsWith('node tests/final-closure/run.mjs &&'),
  'npm test must invoke the canonical final-closure runner',
);
assert.ok(
  fs.readFileSync('tests/final-closure/run.mjs', 'utf8').includes('../support/phase-node-test-runner.mjs'),
  'final closure must reuse the repository canonical phase runner abstraction',
);

function dynamicShadowGate(taskId, gateId, judgePath, activationRequired = false) {
  const contract = {
    schemaVersion: 'hex-final-closure-shadow-contract/v1',
    taskId,
    gateId,
    activationRequired,
    cases: activationRequired ? [] : [{
      id: `${taskId.toLowerCase()}-process-regression`,
      projection: { kind: 'process-exit-v1', argv: ['node', judgePath], timeoutMs: 60000 },
      oracleObservation: { exitCode: 0, signal: null, errorCode: null },
      failureCounterIds: ['semanticMismatch'],
    }],
  };
  return {
    id: gateId,
    argv: ['node', 'tools/validation/final-closure/preflight.mjs', '--emit-shadow-evidence', '--task', taskId],
    contract,
    contractSha256: createHash('sha256').update(canonicalFixtureJson(contract)).digest('hex'),
  };
}

function shadowRawObservation(taskId, gateId, state = 'OBSERVED') {
  const contract = shadowContracts.contracts[shadowRegistry.tasks[taskId].contractId];
  return {
    schemaVersion: 'hex-final-closure-shadow-raw-observation/v1',
    taskId,
    gateId,
    observations: contract.cases.map((row) => state === 'OBSERVED'
      ? { caseId: row.id, state, value: row.oracleObservation }
      : { caseId: row.id, state, reason: 'bounded-product-unknown' }),
  };
}

function passingShadowProviderResult(command, argv) {
  if (!String(argv?.[0] || '').includes('shadow/foundation/')) {
    return { status: 0, stdout: '' };
  }
  const taskId = argv[argv.indexOf('--task') + 1];
  const gateId = argv[argv.indexOf('--gate') + 1];
  return { status: 0, stdout: `${JSON.stringify(shadowRawObservation(taskId, gateId))}\n` };
}

const extendedTasksText = `${tasksText}\n- [ ] T058 [CAMP] Dynamically materialized residual proof
  - **Contract** — Objective: prove dynamic task coverage. Current evidence: test fixture. Owner/model: SOL Ultra. Risk: MEDIUM. Dependencies: T048. Owned paths: evidence only. Delta: none. Negative counterexample: missing owner. Tests: focused. Integration test: preflight. Completion evidence: fixture. Status: PENDING.\n`;
const extendedOwnership = structuredClone(ownership);
extendedOwnership.tasks.T058 = {
  allowedPaths: [
    'specs/005-analysis-final-closure/evidence/dynamic-residual.md',
    'tests/final-closure/t058/**',
  ],
  forbiddenOverlap: ['production, test, generated-output, and Git ref mutation'],
};
extendedOwnership.candidateGates.tasks.T058 = {
  owned: [{ id: 't058-owned', argv: ['node', 'tests/final-closure/t058/owned.test.mjs'] }],
  rolling: [{ id: 't058-rolling', argv: ['npm', 'run', 'phase8:test'] }],
  shadow: [dynamicShadowGate('T058', 't058-shadow', 'tests/issue-914-stack-return-state.mjs')],
};
const extended = validate({ tasksText: extendedTasksText, ownership: extendedOwnership });
assert.equal(extended.ok, true, extended.errors.join('\n'));
assert.equal(extended.taskIds.at(-1), 'T058', 'T048 may append a fully contracted T058+ task without weakening T001-T057 ownership');
assert.ok(
  Object.hasOwn(extendedOwnership.candidateGates.tasks.T058.shadow[0], 'contract'),
  'T058+ is the first dynamic range and must carry a pinned inline shadow contract',
);
const inactiveDynamicOwnership = structuredClone(extendedOwnership);
inactiveDynamicOwnership.candidateGates.tasks.T058.shadow = [
  dynamicShadowGate('T058', 't058-shadow', 'tests/issue-914-stack-return-state.mjs', true),
];
assertIncludes(
  validate({ tasksText: extendedTasksText, ownership: inactiveDynamicOwnership }).errors,
  'candidate-shadow-contract-activation-required:T058',
  'a T058+ row with no activated integration-owned semantic contract fails closed',
);
assertIncludes(
  validate({
    tasksText: rewriteDependencies(extendedTasksText, 'T058', 'T046'),
    ownership: extendedOwnership,
  }).errors,
  'tasks-dynamic-t048-dependency-missing',
  'every dynamically materialized Stage B lane must remain transitively gated by T048',
);

const completedLaneText = rewriteTaskStatus(tasksText, 'T046', 'DONE');
assert.equal(
  rewriteTaskStatus(completedLaneText, 'T046', 'DONE'),
  completedLaneText,
  'the permanent preflight suite must remain runnable after the T046 DONE transition',
);
const completedLaneInventory = structuredClone(integrationInventory);
completedLaneInventory.taskHandoffs.T046 = {
  headSha: 'd7eb37dd3c5b4842f127a74183547e64bef2be9f',
  treeSha: '3233b538f984befbecf091aaf2eeb4dbcea10707',
  evidencePath: 'specs/005-analysis-final-closure/evidence/pre-fanout.md',
};
const completedLane = validate({
  tasksText: completedLaneText,
  integrationInventory: completedLaneInventory,
});
assert.equal(completedLane.ok, true, completedLane.errors.join('\n'));

const blockedLaneText = rewriteTaskStatus(tasksText, 'T011', 'BLOCKED_BY_CONCURRENT_WORK');
const blockedLane = validate({ tasksText: blockedLaneText });
assert.equal(blockedLane.ok, true, blockedLane.errors.join('\n'));

const invalidBlockedStatus = rewriteTaskBlock(tasksText, 'T011', (block) => block
  .replace('Status: PENDING.', 'Status: BLOCKED_BY_DEPENDENCY.'));
assertIncludes(
  validate({ tasksText: invalidBlockedStatus }).errors,
  'task-status-invalid',
  'BLOCKED_BY_DEPENDENCY is a durable roadmap state, not an accepted machine task status',
);

const checkedBlocked = rewriteTaskStatus(tasksText, 'T011', 'BLOCKED_BY_CONCURRENT_WORK')
  .replace('- [ ] T011 ', '- [x] T011 ');
assertIncludes(
  validate({ tasksText: checkedBlocked }).errors,
  'task-checkbox-status-mismatch',
  'BLOCKED_BY_CONCURRENT_WORK must remain unchecked',
);

const prematureStageB = rewriteTaskStatus(tasksText, 'T047', 'DONE');
assertIncludes(
  validate({ tasksText: prematureStageB }).errors,
  'tasks-done-dependency-not-done',
  'T047 cannot be DONE before its T024 merge dependency is DONE',
);

const checkedPending = tasksText.replace('- [ ] T011 ', '- [x] T011 ');
assertIncludes(
  validate({ tasksText: checkedPending }).errors,
  'task-checkbox-status-mismatch',
  'a checked task cannot retain PENDING machine status',
);

const uncheckedDone = rewriteTaskBlock(tasksText, 'T011', (block) => block.replace('Status: PENDING.', 'Status: DONE.'));
assertIncludes(
  validate({ tasksText: uncheckedDone }).errors,
  'task-checkbox-status-mismatch',
  'an open task cannot claim DONE machine status',
);

const emptyTaskField = rewriteTaskBlock(tasksText, 'T011', (block) => block.replace(/Tests:[\s\S]*?\. Integration test:/, 'Tests: . Integration test:'));
assertIncludes(
  validate({ tasksText: emptyTaskField }).errors,
  'task-field-value-empty',
  'required task fields must have nonempty values',
);

const disguisedMissingField = rewriteTaskBlock(tasksText, 'T011', (block) => block
  .replace('Tests:', 'Verification:')
  .replace('Negative counterexample:', 'Negative counterexample: the token Tests: appears here;'));
assertIncludes(
  validate({ tasksText: disguisedMissingField }).errors,
  'task-field-boundary',
  'a required-field token inside another value is not a structural field',
);

const duplicateTaskField = rewriteTaskBlock(tasksText, 'T011', (block) => block.replace('Tests:', 'Tests: duplicate. Tests:'));
assertIncludes(
  validate({ tasksText: duplicateTaskField }).errors,
  'task-field-count',
  'duplicate field labels must fail',
);

const misorderedTaskFields = rewriteTaskBlock(tasksText, 'T011', (block) => block
  .replace('Tests:', '__TESTS__')
  .replace('Integration test:', 'Tests:')
  .replace('__TESTS__', 'Integration test:'));
assertIncludes(
  validate({ tasksText: misorderedTaskFields }).errors,
  'task-field-order',
  'required task fields must stay in canonical order',
);

const shaA = 'a'.repeat(40);
const shaB = 'b'.repeat(40);
assert.equal(assertExactHead(shaA, shaA), shaA);
assert.throws(() => assertExactHead('', shaA), /expected-head-sha-invalid/);
assert.throws(() => assertExactHead('A'.repeat(40), shaA), /expected-head-sha-invalid/);
assert.throws(() => assertExactHead(shaA, shaB), /exact-head-mismatch/);

const missingTask = structuredClone(ownership);
delete missingTask.tasks.T048;
assertIncludes(validate({ ownership: missingTask }).errors, 'ownership-task-set-mismatch', 'a missing owner must block');

const emptyOverlap = structuredClone(ownership);
emptyOverlap.tasks.T011.forbiddenOverlap = [];
assertIncludes(
  validate({ ownership: emptyOverlap }).errors,
  'ownership-forbidden-overlap-empty',
  'an empty forbidden-overlap contract must block preflight',
);

const emptyGlobalForbidden = structuredClone(ownership);
emptyGlobalForbidden.globalForbidden = [];
assertIncludes(
  validate({ ownership: emptyGlobalForbidden }).errors,
  'ownership-global-forbidden-empty',
  'the global ownership prohibition set must not be empty',
);

const mutatedGlobalForbidden = structuredClone(ownership);
mutatedGlobalForbidden.globalForbidden[0] = 'anything is allowed';
assertIncludes(
  validate({ ownership: mutatedGlobalForbidden }).errors,
  'ownership-foundation-digest-mismatch',
  'globalForbidden is part of the frozen foundation identity',
);

assert.equal(computeInitialCandidateGateDigest(ownership), FROZEN_INITIAL_CANDIDATE_GATE_DIGEST);
const driftedShadowAuthority = { ...shadowAuthority };
driftedShadowAuthority[ownership.candidateGates.shadowEvidence.authorityArtifacts[0].path] += '\n';
assertIncludes(
  validate({ shadowAuthority: driftedShadowAuthority }).errors,
  'candidate-shadow-authority-content-mismatch',
  'every central shadow registry, contract, and provider byte is content-pinned',
);
const componentOwnedShadowAuthority = structuredClone(ownership);
componentOwnedShadowAuthority.tasks.T011.allowedPaths.push(
  'tools/validation/final-closure/shadow/foundation/**',
);
assertIncludes(
  validate({ ownership: componentOwnedShadowAuthority }).errors,
  'candidate-shadow-authority-component-owned',
  'no component allowlist may own the registry, contracts, or observer adapters',
);
assert.equal(
  new Set(Object.values(shadowRegistry.tasks).map((row) => row.contractId)).size,
  Object.keys(shadowRegistry.tasks).length,
  'every initial component binds a distinct central contract',
);
const inactiveShadowContracts = structuredClone(shadowContracts);
inactiveShadowContracts.contracts[shadowRegistry.tasks.T011.contractId].activationRequired = true;
assertIncludes(
  validate({
    shadowAuthority: {
      ...shadowAuthority,
      'tools/validation/final-closure/shadow/foundation/contracts.json': JSON.stringify(inactiveShadowContracts),
    },
  }).errors,
  'candidate-shadow-contract-activation-required:T011',
  'an unactivated task-specific contract must block admission',
);
const unmappedShadowContracts = structuredClone(shadowContracts);
for (const contract of Object.values(unmappedShadowContracts.contracts)) {
  for (const row of contract.cases) {
    row.failureCounterIds = row.failureCounterIds.filter((id) => id !== 'falseExactIndirectTarget');
  }
}
assertIncludes(
  validate({
    shadowAuthority: {
      ...shadowAuthority,
      'tools/validation/final-closure/shadow/foundation/contracts.json': JSON.stringify(unmappedShadowContracts),
    },
  }).errors,
  'candidate-shadow-counter-unmapped:falseExactIndirectTarget',
  'every policy-required counter must be mapped by at least one pinned foundation case',
);
const t032Judge = shadowContracts.contracts[shadowRegistry.tasks.T032.contractId]
  .cases[0].projection.argv[1];
assert.equal(t032Judge, 'tests/symbol-identity.mjs');
assert.equal(
  spawnSync('node', [t032Judge], { cwd: SOURCE_ROOT, stdio: 'ignore' }).status,
  0,
  'the frozen T032 symbol-identity judge must be green on the authority baseline',
);
const liveT032Contract = shadowContracts.contracts[shadowRegistry.tasks.T032.contractId];
const forgedOracle = structuredClone(shadowRawObservation('T032', liveT032Contract.gateId));
forgedOracle.observations[0].value.exitCode = 1;
const forgedProduct = structuredClone(forgedOracle);
assert.equal(
  deriveShadowProof({
    oracleObservation: forgedOracle,
    productObservation: forgedProduct,
    contract: liveT032Contract,
    policy: ownership.candidateGates.shadowEvidence,
    contractIdentity: createHash('sha256')
      .update(canonicalFixtureJson(liveT032Contract)).digest('hex'),
  }).verdict,
  'FAIL',
  'matching forged observations cannot replace the pinned oracle observation',
);
for (const side of ['oracle', 'product']) {
  const provider = shadowRegistry.providers[side];
  const child = spawnSync(provider.argv[0], [
    ...provider.argv.slice(1),
    '--task', 'T032',
    '--gate', liveT032Contract.gateId,
  ], {
    cwd: SOURCE_ROOT,
    input: canonicalFixtureJson(liveT032Contract),
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  assert.equal(child.status, 0, `${side} observer must execute live:\n${child.stderr}`);
  const raw = JSON.parse(child.stdout);
  assert.deepEqual(Object.keys(raw).sort(), ['gateId', 'observations', 'schemaVersion', 'taskId']);
  assert.deepEqual(raw.observations[0].value, { exitCode: 0, signal: null, errorCode: null });
  assert.equal(/verdict|hash|counter/i.test(child.stdout), false, 'providers emit raw observations only');
}
const tamperedDynamicPin = structuredClone(extendedOwnership);
tamperedDynamicPin.candidateGates.tasks.T058.shadow[0].contract.cases[0].projection.timeoutMs += 1;
assertIncludes(
  validate({ tasksText: extendedTasksText, ownership: tamperedDynamicPin }).errors,
  'candidate-shadow-dynamic-pin-invalid:T058',
  'a dynamic contract cannot change without its integration-owned content pin changing',
);
const injectedCandidateGate = structuredClone(ownership);
injectedCandidateGate.candidateGates.tasks.T011.owned[0].argv.push('&&touch');
assertIncludes(
  validate({ ownership: injectedCandidateGate }).errors,
  'candidate-gate-argv-invalid',
  'candidate gate argv must reject shell metacharacters',
);
const missingCandidateGateKind = structuredClone(ownership);
missingCandidateGateKind.candidateGates.tasks.T011.shadow = [];
assertIncludes(
  validate({ ownership: missingCandidateGateKind }).errors,
  'candidate-gate-kind-empty',
  'every component needs nonempty owned, rolling, and shadow gates',
);
const unknownCandidateScript = structuredClone(ownership);
unknownCandidateScript.candidateGates.tasks.T011.rolling[0].argv = ['npm', 'run', 'not-a-real-script'];
assertIncludes(
  validate({ ownership: unknownCandidateScript }).errors,
  'candidate-gate-npm-script-invalid',
  'candidate gates may invoke only declared npm scripts',
);
for (const [unsafeFlag, unsafeArgv] of [
  ['--eval', ['node', '--eval', '0', 'tests/decompiler-semantic.mjs']],
  ['--require', ['node', '--require', 'tests/decompiler-semantic.mjs', 'tests/decompiler-semantic.mjs']],
]) {
  const unsafeNodeCandidateGate = structuredClone(ownership);
  unsafeNodeCandidateGate.candidateGates.tasks.T011.owned[0].argv = unsafeArgv;
  assertIncludes(
    validate({ ownership: unsafeNodeCandidateGate }).errors,
    'candidate-gate-node-path-invalid',
    `candidate gates must reject Node ${unsafeFlag}`,
  );
}

const emptyAllowlist = structuredClone(ownership);
emptyAllowlist.tasks.T011.allowedPaths = [];
assertIncludes(
  validate({ ownership: emptyAllowlist }).errors,
  'ownership-allowed-paths-empty',
  'a prose-only owner contract must not authorize changed files',
);

const rewrittenFoundationOwner = structuredClone(ownership);
rewrittenFoundationOwner.tasks.T011.allowedPaths.push('js/decompiler/foundation-rewrite.js');
assertIncludes(
  validate({ ownership: rewrittenFoundationOwner }).errors,
  'ownership-foundation-digest-mismatch',
  'later campaign tasks cannot rewrite an existing T001-T057 ownership row',
);

for (const invalidPattern of ['**', 'js/decompiler/**/semantic.js', 'js/decompiler/*']) {
  const invalidGlob = structuredClone(ownership);
  invalidGlob.tasks.T011.allowedPaths.push(invalidPattern);
  assertIncludes(
    validate({ ownership: invalidGlob }).errors,
    'ownership-allowed-paths-invalid',
    `unsupported ownership glob ${invalidPattern} must fail closed`,
  );
  assert.equal(
    validateTaskInventory({ taskId: 'T011', actualPaths: ['dist/generated/hex.user.js'], ownership: invalidGlob }).ok,
    false,
    `unsupported ownership glob ${invalidPattern} must not authorize a path`,
  );
}

const concurrentOverlap = structuredClone(ownership);
concurrentOverlap.tasks.T012.allowedPaths.push('js/decompiler/semantic.js');
assertIncludes(
  validate({ ownership: concurrentOverlap }).errors,
  'ownership-concurrent-path-overlap',
  'dependency-incomparable implementation lanes may not own the same path',
);

const unorderedGovernanceReuse = rewriteDependencies(tasksText, 'T009', 'T008');
assertIncludes(
  validate({ tasksText: unorderedGovernanceReuse }).errors,
  'ownership-concurrent-path-overlap',
  'broad/subpath governance ownership such as T009/T010 must be dependency ordered',
);
assert.equal(
  valid.errors.some((error) => error.startsWith('ownership-concurrent-path-overlap:T009:T010:')),
  false,
  'the explicit T009 dependency on T010 must authorize their ordered path reuse',
);

const dynamicPairTasksText = `${extendedTasksText}- [ ] T059 [US3] Dynamically materialized sibling implementation
  - **Contract** — Objective: prove future overlap coverage. Current evidence: test fixture. Owner/model: Sol. Risk: HIGH. Dependencies: T048. Owned paths: implementation fixture. Delta: none. Negative counterexample: sibling overlap. Tests: focused. Integration test: preflight. Completion evidence: fixture. Status: PENDING.\n`;
const dynamicOverlapOwnership = structuredClone(extendedOwnership);
dynamicOverlapOwnership.tasks.T058.allowedPaths = [
  'js/decompiler/future-shared.js',
  'tests/final-closure/t058/**',
];
dynamicOverlapOwnership.tasks.T059 = {
  allowedPaths: ['js/decompiler/future-shared.js', 'tests/final-closure/t059/**'],
  forbiddenOverlap: ['all sibling implementation lanes'],
};
dynamicOverlapOwnership.candidateGates.tasks.T059 = {
  owned: [{ id: 't059-owned', argv: ['node', 'tests/final-closure/t059/owned.test.mjs'] }],
  rolling: [{ id: 't059-rolling', argv: ['npm', 'run', 'phase8:test'] }],
  shadow: [dynamicShadowGate('T059', 't059-shadow', 'tests/issue-429-exception-state.mjs')],
};
assertIncludes(
  validate({ tasksText: dynamicPairTasksText, ownership: dynamicOverlapOwnership }).errors,
  'ownership-concurrent-path-overlap',
  'dynamically appended sibling implementation tasks must participate in overlap analysis',
);

const unknownDependency = rewriteDependencies(tasksText, 'T011', 'T009, T046, and T999');
assertIncludes(
  validate({ tasksText: unknownDependency }).errors,
  'tasks-dependency-unknown',
  'unknown dependency IDs must fail before they can waive ownership overlap',
);

const selfDependency = rewriteDependencies(tasksText, 'T011', 'T009, T011, and T046');
assertIncludes(
  validate({ tasksText: selfDependency }).errors,
  'tasks-dependency-self',
  'self dependencies must fail',
);

let cyclicDependencies = rewriteDependencies(tasksText, 'T011', 'T009, T012, and T046');
cyclicDependencies = rewriteDependencies(cyclicDependencies, 'T012', 'T009, T011, and T046');
const cyclicOverlapOwnership = structuredClone(ownership);
cyclicOverlapOwnership.tasks.T012.allowedPaths.push('js/decompiler/semantic.js');
assertIncludes(
  validate({ tasksText: cyclicDependencies, ownership: cyclicOverlapOwnership }).errors,
  'tasks-dependency-cycle',
  'a reciprocal dependency may not legalize an otherwise concurrent ownership overlap',
);

const missingPrivateBoundary = structuredClone(ownership);
missingPrivateBoundary.tasks.T011.forbiddenOverlap = missingPrivateBoundary.tasks.T011.forbiddenOverlap
  .filter((entry) => !entry.includes('tests/phase8/performance/**'));
assertIncludes(
  validate({ ownership: missingPrivateBoundary }).errors,
  'ownership-special-rule-missing',
  'the decompiler/performance lane boundary must remain explicit',
);

const allowedLane = validateTaskInventory({
  taskId: 'T011',
  actualPaths: ['js/decompiler/semantic.js', 'tests/final-closure/t011/stack-return.test.mjs'],
  ownership,
});
assert.equal(allowedLane.ok, true, allowedLane.errors.join('\n'));

const derivedCorpusManifestPath = 'tests/phase7/corpus/manifest.json';
for (const taskId of ['T049', 'T050']) {
  const manifestOwner = validateTaskInventory({
    taskId,
    actualPaths: [derivedCorpusManifestPath],
    ownership,
  });
  assert.equal(
    manifestOwner.ok,
    true,
    `${taskId} must own canonical corpus-manifest regeneration: ${manifestOwner.errors.join('\n')}`,
  );
}
assertIncludes(
  validateTaskInventory({
    taskId: 'T055',
    actualPaths: [derivedCorpusManifestPath],
    ownership,
  }).errors,
  'inventory-path-outside-allowlist',
  'the type component must not commit its integration-generated corpus manifest',
);
assert.equal(
  validateTaskInventory({
    taskId: 'T017',
    actualPaths: [
      'js/api-cross-binary-families.js',
      'tests/final-closure/t017/battlecats-api-coverage.test.mjs',
    ],
    ownership,
  }).ok,
  true,
  'T017 must own its bounded cross-binary ground-truth table repair',
);

for (const [taskId, ownedPaths] of [
  ['T015', [
    'js/metadata/objc.js',
    'js/metadata/swift.js',
    'tests/apple-knowledge-x02.test.mjs',
    'tests/issue-569-chained-segment-bounds.mjs',
    'tests/issue-570-macho-metadata-budget.mjs',
    'tests/issue-572-bounded-leb.mjs',
  ]],
  ['T016', [
    'tests/stage2/rebuild-transaction.test.mjs',
    'tools/validation/discovery/x03-ownership.mjs',
    'tools/validation/discovery/x03-verify.mjs',
  ]],
  ['T017', [
    'js/semantics/compat/machine-effects-to-v1.js',
    'js/semantics/compat/semantic-ir-v2-to-v1-nodes.js',
    'js/semantics/ir/from-machine-effects.js',
  ]],
  ['T013', ['js/decompiler/phase8/sccp.js']],
]) {
  const selectiveOwner = validateTaskInventory({
    taskId,
    actualPaths: ownedPaths,
    ownership,
  });
  assert.equal(
    selectiveOwner.ok,
    true,
    `${taskId} must own its selectively reconciled paths: ${selectiveOwner.errors.join('\n')}`,
  );
}

for (const [taskId, rejectedPath] of [
  ['T011', 'js/decompiler/phase8/sccp.js'],
  ['T012', 'js/decompiler/phase8/sccp.js'],
  ['T014', 'tools/validation/phase9/profile.json'],
  ['T014', 'tests/phase9/integration/ai-tools.test.mjs'],
  ['T015', 'docs/analysis-improvement-finding-ledger.md'],
  ['T016', 'js/ai/tools/registry-base.js'],
  ['T016', 'js/rebuild/format-safe.js'],
  ['T017', 'js/decompiler/phase8/sccp.js'],
]) {
  assertIncludes(
    validateTaskInventory({
      taskId,
      actualPaths: [rejectedPath],
      ownership,
    }).errors,
    'inventory-path-outside-allowlist',
    `${taskId} must reject composite-candidate path ${rejectedPath}`,
  );
}

for (const repoPath of [
  'docs/README.md',
  'tools/validation/final-closure/preflight.mjs',
  'js/decompiler/phase8/analysis-identity.js',
  'dist/generated/hex.user.js',
]) {
  assertIncludes(
    validateTaskInventory({ taskId: 'T011', actualPaths: [repoPath], ownership }).errors,
    'inventory-path-outside-allowlist',
    `T011 must reject out-of-lane path ${repoPath}`,
  );
}

for (const [taskId, reservedPath] of [
  ['T013', 'js/decompiler/phase8/analysis-identity.js'],
  ['T013', 'js/decompiler/phase8/valuenumber.js'],
  ['T014', 'tools/validation/phase9/profile.json'],
]) {
  assertIncludes(
    validateTaskInventory({ taskId, actualPaths: [reservedPath], ownership }).errors,
    'inventory-path-outside-allowlist',
    `${taskId} must reject expressly reserved path ${reservedPath}`,
  );
}

const exactIntegration = validateIntegrationInventory({
  integrationInventory,
  ownership,
  taskIds: EXPECTED_TASK_IDS,
  actualChangedPaths: integrationInventory.unionChangedPaths,
  expectedBaseSha: integrationInventory.baseSha,
});
assert.equal(exactIntegration.ok, true, exactIntegration.errors.join('\n'));

const missingCompletedHandoff = structuredClone(integrationInventory);
delete missingCompletedHandoff.taskHandoffs.T010;
assertIncludes(
  validate({ integrationInventory: missingCompletedHandoff }).errors,
  'task-handoff-completed-set-mismatch',
  'every DONE task must retain a full machine handoff',
);

const missingActualPath = integrationInventory.unionChangedPaths.slice(1);
assertIncludes(
  validateIntegrationInventory({
    integrationInventory,
    ownership,
    taskIds: EXPECTED_TASK_IDS,
    actualChangedPaths: missingActualPath,
    expectedBaseSha: integrationInventory.baseSha,
  }).errors,
  'integration-inventory-git-diff-mismatch',
  'the actual aggregate may not omit an expected component path',
);

assertIncludes(
  validateIntegrationInventory({
    integrationInventory,
    ownership,
    taskIds: EXPECTED_TASK_IDS,
    actualChangedPaths: [...integrationInventory.unionChangedPaths, 'js/unowned-production.js'],
    expectedBaseSha: integrationInventory.baseSha,
  }).errors,
  'integration-inventory-git-diff-mismatch',
  'the actual aggregate may not add an unowned path',
);

const wrongIntegrationOwner = structuredClone(integrationInventory);
wrongIntegrationOwner.entries.find((entry) => entry.path === '.github/workflows/final-closure-preflight.yml').ownerTaskId = 'T011';
assertIncludes(
  validate({ integrationInventory: wrongIntegrationOwner }).errors,
  'inventory-path-outside-allowlist',
  'a verifier-owned path cannot be reassigned to a component lane',
);

const brokenUnion = structuredClone(integrationInventory);
brokenUnion.actualChangedPaths.pop();
assertIncludes(
  validate({ integrationInventory: brokenUnion }).errors,
  'integration-inventory-expected-actual-mismatch',
  'expected, actual, and aggregate inventories must form one exact union',
);

const staleWorkflow = workflowText.replaceAll('github.event.pull_request.head.sha', 'github.sha');
assertIncludes(validate({ workflowText: staleWorkflow }).errors, 'workflow-pr-head-not-exact', 'merge refs are not exact heads');

const baselessWorkflow = workflowText.replaceAll('github.event.pull_request.base.sha', 'github.sha');
assertIncludes(validate({ workflowText: baselessWorkflow }).errors, 'workflow-pr-base-not-exact', 'the live base must be bound');

const unscopedWorkflow = workflowText
  .replace("startsWith(github.head_ref, 'recovery/final-closure-')", 'false')
  .replace("startsWith(github.head_ref, 'analysis/final-closure-')", 'false');
assertIncludes(validate({ workflowText: unscopedWorkflow }).errors, 'workflow-campaign-scope-gate-missing', 'scope is mandatory');

const componentlessWorkflow = workflowText.replace(
  'node tools/validation/final-closure/preflight.mjs --prepare-component-candidate',
  'node tools/validation/final-closure/preflight.mjs',
);
assertIncludes(
  validate({ workflowText: componentlessWorkflow }).errors,
  'workflow-component-candidate-path-missing',
  'component PRs must construct the event-authorized synthetic candidate tree',
);

const authoritylessWorkflow = workflowText
  .replace('pull-request-authority:', 'disabled-pull-request-authority:')
  .replaceAll('needs: pull-request-authority', 'needs: disabled-pull-request-authority');
assertIncludes(
  validate({ workflowText: authoritylessWorkflow }).errors,
  'workflow-pull-request-authority-gate-missing',
  'a wrong-named PR targeting living integration must run a rejecting check rather than skip every job',
);

const mutableActions = workflowText
  .replaceAll('actions/checkout@11d5960a326750d5838078e36cf38b85af677262', 'actions/checkout@v4')
  .replaceAll('actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020', 'actions/setup-node@v4');
assertIncludes(validate({ workflowText: mutableActions }).errors, 'workflow-action-pin-invalid', 'mutable action tags must fail');

const credentialedWorkflow = workflowText.replaceAll('persist-credentials: false', 'persist-credentials: true');
assertIncludes(
  validate({ workflowText: credentialedWorkflow }).errors,
  'workflow-checkout-credentials-persist',
  'PR-controlled verification must not retain checkout credentials',
);

const poisonableDispatchCheckout = workflowText.replace(
  'ref: ${{ github.sha }}',
  'ref: ${{ inputs.expect_sha }}',
);
assertIncludes(
  validate({ workflowText: poisonableDispatchCheckout }).errors,
  'workflow-dispatch-input-checkout-forbidden',
  'workflow_dispatch must never execute source selected only by a string input',
);

const dispatchGuardBlock = `      - name: Reject poisoned dispatch head before execution
        env:
          INPUT_SHA: "\${{ inputs.expect_sha }}"
          WORKFLOW_SHA: "\${{ github.sha }}"
        run: |
          if [[ ! "$INPUT_SHA" =~ ^[0-9a-f]{40}$ || ! "$WORKFLOW_SHA" =~ ^[0-9a-f]{40}$ ]]; then
            echo "workflow_dispatch head identity must be lowercase 40-hex" >&2
            exit 1
          fi
          if [[ "$INPUT_SHA" != "$WORKFLOW_SHA" ]]; then
            echo "workflow_dispatch input does not match the trusted workflow SHA" >&2
            exit 1
          fi
`;
assert.ok(workflowText.includes(dispatchGuardBlock), 'dispatch guard fixture must match the workflow exactly');
assertIncludes(
  validate({ workflowText: workflowText.replace(dispatchGuardBlock, '') }).errors,
  'workflow-dispatch-preexecution-guard-invalid',
  'the dispatch equality guard cannot be removed before untrusted source executes',
);
const mismatchedDispatchGuard = workflowText.replace(
  'WORKFLOW_SHA: "${{ github.sha }}"',
  'WORKFLOW_SHA: "${{ inputs.expect_sha }}"',
);
assertIncludes(
  validate({ workflowText: mismatchedDispatchGuard }).errors,
  'workflow-dispatch-preexecution-guard-invalid',
  'comparing the input to itself cannot establish trusted workflow identity',
);
const dispatchCheckoutBlock = `      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262
        with:
          ref: \${{ github.sha }}
          fetch-depth: 0
          persist-credentials: false
`;
const lateDispatchGuard = workflowText
  .replace(dispatchGuardBlock, '')
  .replace(dispatchCheckoutBlock, `${dispatchCheckoutBlock}${dispatchGuardBlock}`);
assertIncludes(
  validate({ workflowText: lateDispatchGuard }).errors,
  'workflow-dispatch-preexecution-guard-order-invalid',
  'the dispatch guard must run before checkout, setup, dependency install, or repository code',
);

const lexicalDecoyWorkflow = workflowText
  .replaceAll('ref: ${{ github.event.pull_request.head.sha }}', 'ref: ${{ github.sha }}')
  .replaceAll('ref: ${{ inputs.expect_sha }}', 'ref: ${{ github.sha }}')
  .replaceAll('actions/checkout@11d5960a326750d5838078e36cf38b85af677262', 'actions/checkout@v4')
  .replaceAll('actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020', 'actions/setup-node@v4')
  .replaceAll('persist-credentials: false', 'persist-credentials: true')
  .replaceAll(
    'run: node tools/validation/final-closure/preflight.mjs --expect-sha "$EXPECT_SHA" --expect-base-sha "$EXPECT_BASE_SHA"',
    'run: echo bypassed',
  )
  .concat(`
# github.event.pull_request.head.sha github.event.pull_request.base.sha
# --expect-sha "$EXPECT_SHA" --expect-base-sha "$EXPECT_BASE_SHA"
# actions/checkout@11d5960a326750d5838078e36cf38b85af677262
# actions/checkout@11d5960a326750d5838078e36cf38b85af677262
# actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020
# actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020
# persist-credentials: false
# persist-credentials: false
`);
assertIncludes(
  validate({ workflowText: lexicalDecoyWorkflow }).errors,
  'workflow-content-digest-mismatch',
  'comments containing expected literals cannot attest a bypassed workflow',
);

function platformMutation(mutator) {
  const mutated = structuredClone(platformLocks);
  mutator(mutated);
  return validate({ platformLocks: mutated }).errors;
}

assertIncludes(platformMutation((value) => {
  value.denominator.workloads[0].targets[0].threshold = 999999999;
  value.denominatorStableDigest = stableDigest(value.denominator);
}), 'platform-denominator-digest-mismatch', 'a relaxed threshold must fail even if the embedded digest is recomputed');

assertIncludes(platformMutation((value) => {
  value.denominator.workloads[0].targets[0].operator = '>=';
}), 'platform-workloads-digest-mismatch', 'target operators are frozen');

assertIncludes(platformMutation((value) => {
  value.denominator.workloads[0].targets[0].unit = 'seconds';
}), 'platform-workloads-digest-mismatch', 'target units are frozen');

assertIncludes(platformMutation((value) => {
  value.denominator.workloads[1] = structuredClone(value.denominator.workloads[0]);
}), 'platform-required-workload-set-invalid', 'duplicate workload IDs must fail');

assertIncludes(platformMutation((value) => {
  value.denominator.workloads[0].targets = [];
}), 'platform-workload-targets-invalid', 'a targetless required workload must fail');

assertIncludes(platformMutation((value) => {
  const physical = value.runtimeClasses.find((item) => item.id === 'physical-ipad-supported-floor-v1');
  physical.requirements = [];
}), 'platform-physical-ipad-memory-floor-missing', 'physical iPad <=4 GiB proof cannot be removed');

assertIncludes(platformMutation((value) => {
  value.denominator.fixtureSet.descriptor.fixtures[0].sha256 = '0'.repeat(64);
  value.denominator.fixtureSet.stableDigest = stableDigest(value.denominator.fixtureSet.descriptor);
  value.denominatorStableDigest = stableDigest(value.denominator);
}), 'platform-fixture-digest-mismatch', 'fixture drift must fail after embedded digest recomputation');

for (const policyName of Object.keys(platformLocks.requiredRowPolicy)) {
  assertIncludes(platformMutation((value) => {
    value.requiredRowPolicy[policyName] = 'ALLOW';
  }), 'platform-row-policy-digest-mismatch', `row policy ${policyName} is frozen`);
}

assertIncludes(platformMutation((value) => {
  value.identityRequirements.pop();
}), 'platform-identity-requirements-digest-mismatch', 'identity requirements cannot shrink');

assertIncludes(platformMutation((value) => {
  value.measurementProtocol.physicalPeakMemory = 'estimated by desktop proxy';
}), 'platform-measurement-protocol-digest-mismatch', 'measurement protocol cannot use a proxy');

assert.equal(stableDigest(platformLocks), FROZEN_PLATFORM_IDENTITIES.full);
assert.equal(stableDigest(platformLocks.denominator), FROZEN_PLATFORM_IDENTITIES.denominator);
assert.equal(stableDigest(platformLocks.denominator.fixtureSet.descriptor), FROZEN_PLATFORM_IDENTITIES.fixtureDescriptor);

function performanceMutation(mutator) {
  const mutated = structuredClone(performanceLocks);
  mutator(mutated);
  return validate({ performanceLocks: mutated }).errors;
}

assertIncludes(performanceMutation((value) => {
  value.profiles['P-SYM01'].blockingThresholds[0].threshold += 1;
}), 'performance-threshold-digest-mismatch', 'P-SYM01 blocking thresholds are frozen, not documentary');

assertIncludes(performanceMutation((value) => {
  value.profiles['P-SYM01'].sourceScope.paths[0].sha256 = '0'.repeat(64);
}), 'performance-source-digest-mismatch', 'immutable P-SYM01 source identities are frozen');

assert.equal(stableDigest(performanceLocks), FROZEN_PERFORMANCE_IDENTITIES.full);
for (const [profileId, expectedDigest] of Object.entries(FROZEN_PERFORMANCE_IDENTITIES.profiles)) {
  assert.equal(stableDigest(performanceLocks.profiles[profileId]), expectedDigest);
}
assert.equal(stableDigest(performanceThresholdSnapshot(performanceLocks)), FROZEN_PERFORMANCE_IDENTITIES.thresholds);
assert.equal(stableDigest(performanceSourceSnapshot(performanceLocks)), FROZEN_PERFORMANCE_IDENTITIES.sources);

const frozenEvidence = {
  headSha: shaA,
  treeSha: 'c'.repeat(40),
  baseSha: 'd'.repeat(40),
  mergeTreeSha: 'e'.repeat(40),
  verifierIdentity: 'preflight-v1',
  corpusIdentity: 'corpus-v1',
  toolchainIdentity: 'node-22',
  runtimeIdentity: 'webkit-v1',
  deploymentIdentity: 'build-v1',
  generatedArtifactIdentity: 'artifact-v1',
};
assert.deepEqual(staleEvidenceFields(frozenEvidence, structuredClone(frozenEvidence)), []);
assert.deepEqual(
  staleEvidenceFields(frozenEvidence, { ...frozenEvidence, baseSha: shaB, runtimeIdentity: 'webkit-v2' }),
  ['baseSha', 'runtimeIdentity'],
  'moving main or runtime identity changes must invalidate prior evidence',
);

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed:\n${result.stderr}`);
  return result.stdout.trim();
}

function write(root, relativePath, content) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

const IMMUTABLE_SYM01_COMMIT = '0d23cbfa595ea1d8753d5249626695bd9bae5ef3';
const IMMUTABLE_SYM01_REF = 'refs/heads/wip/recovered-sym01-20260904';
const RECOVERY_HANDOFF_REF = 'refs/heads/wip/recovery-handoff-20260904';

function commitAll(root, message) {
  git(root, ['add', '.']);
  git(root, ['commit', '-m', message]);
  return git(root, ['rev-parse', 'HEAD']);
}

function copySourcePath(targetRoot, repoPath) {
  const sourcePath = path.join(SOURCE_ROOT, repoPath);
  const content = fs.existsSync(sourcePath)
    ? fs.readFileSync(sourcePath)
    : Buffer.from(`fixture for ${repoPath}\n`);
  write(targetRoot, repoPath, content);
}

function seedImmutablePerformanceSource(origin) {
  git(SOURCE_ROOT, ['push', origin, `${IMMUTABLE_SYM01_COMMIT}:${IMMUTABLE_SYM01_REF}`]);
}

function restoreImmutablePerformanceSource(origin) {
  git(SOURCE_ROOT, ['push', '--force', origin, `${IMMUTABLE_SYM01_COMMIT}:${IMMUTABLE_SYM01_REF}`]);
}

function bindHandoffsToCommit(inventory, headSha, treeSha) {
  for (const handoff of Object.values(inventory.taskHandoffs)) {
    handoff.headSha = headSha;
    handoff.treeSha = treeSha;
  }
}

function seedPreTransitionHandoffFiles(root) {
  for (const evidencePath of new Set(Object.values(integrationInventory.taskHandoffs)
    .map((handoff) => handoff.evidencePath))) {
    write(root, evidencePath, `foundation evidence for ${evidencePath}\n`);
  }
  const mutableCoordinationPaths = new Set([
    'specs/005-analysis-final-closure/contracts/integration-inventory.json',
    'specs/005-analysis-final-closure/tasks.md',
  ]);
  for (const entry of integrationInventory.entries) {
    if (mutableCoordinationPaths.has(entry.path)) continue;
    copySourcePath(root, entry.path);
  }
  write(
    root,
    'specs/005-analysis-final-closure/tasks.md',
    rewriteTaskStatus(tasksText, 'T046', 'PENDING'),
  );
}

function evidenceBlock(name, value) {
  return `# Fixture evidence\n\n\`\`\`json ${name}\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`;
}

{
  const baseSha = 'a'.repeat(40);
  const sourceHeadSha = 'b'.repeat(40);
  const sourceTreeSha = 'c'.repeat(40);
  const roadmapMatrixText = [
    '| ID | Requirement | Status | Evidence |',
    '|---|---|---|---|',
    ...STAGE_B_ROADMAP_IDS.map((findingId) => `| ${findingId} | fixture | DONE | exact |`),
    '',
  ].join('\n');
  const matrixWithStatus = (findingId, status) => roadmapMatrixText.replace(
    `| ${findingId} | fixture | DONE |`,
    `| ${findingId} | fixture | ${status} |`,
  );
  const staticFindingByTask = {
    T026: 'HEX-C0-01',
    T027: 'HEX-ME-01',
    T028: 'HEX-C4-03',
    T029: 'HEX-C4-04',
    T030: 'HEX-C4-02',
    T031: 'HEX-C4-05',
    T032: 'HEX-SYM-01',
    T033: 'HEX-SYM-02',
    T034: 'HEX-SYM-03',
    T035: 'HEX-X-03',
    T036: 'HEX-X-02',
  };
  let coverageTasksText = rewriteTaskStatus(tasksText, 'T025', 'DONE');
  coverageTasksText = rewriteTaskStatus(coverageTasksText, 'T048', 'DONE');
  for (const taskId of Object.keys(staticFindingByTask)) {
    coverageTasksText = rewriteTaskStatus(coverageTasksText, taskId, 'DONE');
  }
  const coverageInventory = {
    baseSha,
    unionChangedPaths: [STAGE_B_RESIDUAL_COVERAGE_PATH],
    entries: [{ path: STAGE_B_RESIDUAL_COVERAGE_PATH, ownerTaskId: 'T048' }],
    taskHandoffs: {
      T025: {
        headSha: sourceHeadSha,
        treeSha: sourceTreeSha,
        evidencePath: 'specs/005-analysis-final-closure/evidence/roadmap-matrix.md',
      },
      T048: {
        headSha: 'd'.repeat(40),
        treeSha: 'e'.repeat(40),
        evidencePath: STAGE_B_RESIDUAL_COVERAGE_PATH,
      },
    },
  };
  const terminalCoverage = {
    schemaVersion: STAGE_B_RESIDUAL_COVERAGE_SCHEMA_VERSION,
    campaignStage: 'STAGE_B',
    baseSha,
    source: {
      taskId: 'T025',
      headSha: sourceHeadSha,
      treeSha: sourceTreeSha,
      evidencePath: 'specs/005-analysis-final-closure/evidence/roadmap-matrix.md',
      matrixSha256: createHash('sha256').update(roadmapMatrixText).digest('hex'),
    },
    findings: STAGE_B_ROADMAP_IDS.map((findingId) => ({
      findingId,
      status: 'DONE',
      durableDisposition: 'COMPLETE_EXISTING',
    })),
    tasks: [
      ...Object.entries(staticFindingByTask).map(([taskId, findingId]) => ({
        taskId,
        findingId,
        implementationAction: 'NO_EDIT',
      })),
      { taskId: 'T045', findingId: null, implementationAction: 'IMPLEMENT' },
    ],
  };
  const validateCoverage = ({
    coverage = terminalCoverage,
    fixtureTasksText = coverageTasksText,
    inventory = coverageInventory,
    taskIds = EXPECTED_TASK_IDS,
    matrixText = roadmapMatrixText,
    handoffMatrixText = matrixText,
  } = {}) => {
    const errors = [];
    const result = validateStageBApplicability({
      campaignStage: 'STAGE_B',
      blocks: fixtureTaskBlocks(fixtureTasksText),
      taskIds,
      integrationInventory: inventory,
      stageBResidualCoverageText: evidenceBlock(STAGE_B_RESIDUAL_COVERAGE_BLOCK, coverage),
      roadmapMatrixText: matrixText,
      roadmapMatrixSha256: matrixText == null
        ? null
        : createHash('sha256').update(matrixText).digest('hex'),
      roadmapMatrixHandoffSha256: handoffMatrixText == null
        ? null
        : createHash('sha256').update(handoffMatrixText).digest('hex'),
      errors,
    });
    return { result, errors };
  };

  const terminalResult = validateCoverage();
  assert.deepEqual(terminalResult.errors, []);
  assert.equal(terminalResult.result.valid, true);
  assert.deepEqual(terminalResult.result.checkpointTaskIds, ['T045']);
  assert.deepEqual(terminalResult.result.implementationTaskIds, ['T045']);
  assert.deepEqual(
    terminalResult.result.noEditTaskIds,
    Object.keys(staticFindingByTask),
    'terminal-existing findings must remove their task lanes from Stage B execution',
  );

  const implementCoverage = structuredClone(terminalCoverage);
  const implementMatrixText = matrixWithStatus('HEX-C0-01', 'PARTIAL');
  implementCoverage.findings.find((row) => row.findingId === 'HEX-C0-01').status = 'PARTIAL';
  implementCoverage.findings.find((row) => row.findingId === 'HEX-C0-01').durableDisposition = null;
  implementCoverage.tasks.find((row) => row.taskId === 'T026').implementationAction = 'IMPLEMENT';
  implementCoverage.source.matrixSha256 = createHash('sha256').update(implementMatrixText).digest('hex');
  const implementResult = validateCoverage({
    coverage: implementCoverage,
    fixtureTasksText: rewriteTaskStatus(coverageTasksText, 'T026', 'PENDING'),
    matrixText: implementMatrixText,
  });
  assert.deepEqual(implementResult.errors, []);
  assert.deepEqual(implementResult.result.checkpointTaskIds, ['T026', 'T045']);
  assert.deepEqual(implementResult.result.implementationTaskIds, ['T026', 'T045']);

  const reconcileCoverage = structuredClone(implementCoverage);
  reconcileCoverage.tasks.find((row) => row.taskId === 'T026').implementationAction = 'RECONCILE_OWNER';
  const reconcilePendingResult = validateCoverage({
    coverage: reconcileCoverage,
    fixtureTasksText: rewriteTaskStatus(coverageTasksText, 'T026', 'BLOCKED_BY_CONCURRENT_WORK'),
    matrixText: implementMatrixText,
  });
  assert.deepEqual(reconcilePendingResult.errors, []);
  assert.deepEqual(reconcilePendingResult.result.checkpointTaskIds, ['T026', 'T045']);
  assert.deepEqual(reconcilePendingResult.result.implementationTaskIds, ['T045']);

  const reconcileInventory = structuredClone(coverageInventory);
  reconcileInventory.entries.push({ path: 'tests/competitive/adopted-owner.test.mjs', ownerTaskId: 'T026' });
  const reconcileCompletedResult = validateCoverage({
    coverage: reconcileCoverage,
    fixtureTasksText: coverageTasksText,
    inventory: reconcileInventory,
    matrixText: implementMatrixText,
  });
  assert.deepEqual(
    reconcileCompletedResult.errors,
    [],
    'an adopted concurrent-owner lane remains checkpointed after its task reaches DONE',
  );

  const staleMatrixResult = validateCoverage({ matrixText: `${roadmapMatrixText}stale\n` });
  assertIncludes(
    staleMatrixResult.errors,
    'stage-b-residual-coverage-source-invalid',
    'coverage cannot be replayed against a different T025 roadmap matrix',
  );
  assertIncludes(
    validateCoverage({ matrixText: null }).errors,
    'stage-b-roadmap-matrix-missing',
    'T048 cannot activate without the exact T025 matrix bytes',
  );

  const contradictedCoverage = structuredClone(terminalCoverage);
  const contradictedMatrixText = matrixWithStatus('HEX-C0-01', 'PARTIAL');
  contradictedCoverage.source.matrixSha256 = createHash('sha256')
    .update(contradictedMatrixText).digest('hex');
  assertIncludes(
    validateCoverage({
      coverage: contradictedCoverage,
      matrixText: contradictedMatrixText,
    }).errors,
    'stage-b-residual-coverage-matrix-status-mismatch',
    'a correctly hashed packet cannot contradict T025 matrix row statuses',
  );

  const substitutedMatrixCoverage = structuredClone(terminalCoverage);
  const substitutedMatrixText = matrixWithStatus('HEX-C0-01', 'PARTIAL');
  substitutedMatrixCoverage.findings.find((row) => row.findingId === 'HEX-C0-01').status = 'PARTIAL';
  substitutedMatrixCoverage.findings.find((row) => row.findingId === 'HEX-C0-01')
    .durableDisposition = null;
  substitutedMatrixCoverage.tasks.find((row) => row.taskId === 'T026').implementationAction = 'IMPLEMENT';
  substitutedMatrixCoverage.source.matrixSha256 = createHash('sha256')
    .update(substitutedMatrixText).digest('hex');
  assertIncludes(
    validateCoverage({
      coverage: substitutedMatrixCoverage,
      fixtureTasksText: rewriteTaskStatus(coverageTasksText, 'T026', 'PENDING'),
      matrixText: substitutedMatrixText,
      handoffMatrixText: roadmapMatrixText,
    }).errors,
    'stage-b-residual-coverage-source-invalid',
    'a recomputed packet cannot substitute matrix bytes after the T025 handoff commit',
  );

  const mergedNoEditCoverage = structuredClone(terminalCoverage);
  mergedNoEditCoverage.findings.find((row) => row.findingId === 'HEX-C0-01')
    .durableDisposition = 'MERGED';
  assertIncludes(
    validateCoverage({ coverage: mergedNoEditCoverage }).errors,
    'stage-b-residual-coverage-disposition-invalid',
    'NO_EDIT is reserved for COMPLETE_EXISTING and cannot hide merged implementation work',
  );

  const externallyBlockedCoverage = structuredClone(terminalCoverage);
  const externallyBlockedMatrixText = matrixWithStatus('HEX-C0-01', 'BLOCKED');
  const externallyBlockedFinding = externallyBlockedCoverage.findings
    .find((row) => row.findingId === 'HEX-C0-01');
  externallyBlockedFinding.status = 'BLOCKED';
  externallyBlockedFinding.durableDisposition = 'BLOCKED_BY_DEPENDENCY';
  const externallyBlockedTask = externallyBlockedCoverage.tasks
    .find((row) => row.taskId === 'T026');
  externallyBlockedTask.implementationAction = 'NO_EDIT_EXTERNAL_BLOCK';
  externallyBlockedTask.externalBlocker = {
    requirementId: 'HEX-C0-01',
    repositoryLimitation: 'The required target hardware is not available to repository code.',
    externalOwner: 'Target-device laboratory',
    attemptedAlternatives: ['Ran the repository simulator and recorded why it cannot prove the device property.'],
    evidence: ['specs/005-analysis-final-closure/evidence/roadmap-matrix.md#HEX-C0-01'],
    minimumUnblockAction: 'Provide the bound target device and return its signed result packet.',
  };
  externallyBlockedCoverage.source.matrixSha256 = createHash('sha256')
    .update(externallyBlockedMatrixText).digest('hex');
  const externallyBlockedResult = validateCoverage({
    coverage: externallyBlockedCoverage,
    fixtureTasksText: rewriteTaskStatus(coverageTasksText, 'T026', 'PENDING'),
    matrixText: externallyBlockedMatrixText,
  });
  assert.deepEqual(externallyBlockedResult.errors, []);
  const missingBlockerEvidence = structuredClone(externallyBlockedCoverage);
  delete missingBlockerEvidence.tasks.find((row) => row.taskId === 'T026').externalBlocker;
  assertIncludes(
    validateCoverage({
      coverage: missingBlockerEvidence,
      fixtureTasksText: rewriteTaskStatus(coverageTasksText, 'T026', 'PENDING'),
      matrixText: externallyBlockedMatrixText,
    }).errors,
    'stage-b-residual-coverage-external-block-evidence-invalid',
    'an external block cannot be published without the exact blocker evidence object',
  );

  const forbiddenNoEditInventory = structuredClone(coverageInventory);
  forbiddenNoEditInventory.entries.push({ path: 'tests/competitive/forbidden.test.mjs', ownerTaskId: 'T026' });
  assertIncludes(
    validateCoverage({ inventory: forbiddenNoEditInventory }).errors,
    'stage-b-residual-coverage-nonimplementation-inventory-owner',
    'a NO_EDIT lane cannot publish implementation inventory',
  );

  const blockedReconcileInventory = structuredClone(coverageInventory);
  blockedReconcileInventory.entries.push({
    path: 'tests/competitive/unadopted-owner.test.mjs',
    ownerTaskId: 'T026',
  });
  assertIncludes(
    validateCoverage({
      coverage: reconcileCoverage,
      fixtureTasksText: rewriteTaskStatus(coverageTasksText, 'T026', 'BLOCKED_BY_CONCURRENT_WORK'),
      inventory: blockedReconcileInventory,
      matrixText: implementMatrixText,
    }).errors,
    'stage-b-residual-coverage-reconcile-owner-inventory-before-adoption',
    'a still-blocked concurrent owner cannot publish candidate paths before exact adoption',
  );

  const dynamicCoverage = structuredClone(terminalCoverage);
  const dynamicMatrixText = matrixWithStatus('HEX-C1-01', 'REMAINING');
  dynamicCoverage.findings.find((row) => row.findingId === 'HEX-C1-01').status = 'REMAINING';
  dynamicCoverage.findings.find((row) => row.findingId === 'HEX-C1-01').durableDisposition = null;
  dynamicCoverage.source.matrixSha256 = createHash('sha256').update(dynamicMatrixText).digest('hex');
  dynamicCoverage.tasks.push({
    taskId: 'T058',
    findingId: 'HEX-C1-01',
    implementationAction: 'IMPLEMENT',
  });
  const dynamicTasksText = `${coverageTasksText}\n- [ ] T058 dynamic fixture\n  - **Contract** — Objective: fixture. Status: PENDING.\n`;
  const dynamicResult = validateCoverage({
    coverage: dynamicCoverage,
    fixtureTasksText: dynamicTasksText,
    taskIds: [...EXPECTED_TASK_IDS, 'T058'],
    matrixText: dynamicMatrixText,
  });
  assert.deepEqual(dynamicResult.errors, []);
  assert.ok(dynamicResult.result.implementationTaskIds.includes('T058'));

  const duplicateOwnerCoverage = structuredClone(dynamicCoverage);
  duplicateOwnerCoverage.tasks.find((row) => row.taskId === 'T058').findingId = 'HEX-C0-01';
  assertIncludes(
    validateCoverage({
      coverage: duplicateOwnerCoverage,
      fixtureTasksText: dynamicTasksText,
      taskIds: [...EXPECTED_TASK_IDS, 'T058'],
      matrixText: dynamicMatrixText,
    }).errors,
    'stage-b-residual-coverage-finding-owner-duplicate',
    'a roadmap finding cannot be owned by two residual tasks',
  );

  const superfluousDynamicCoverage = structuredClone(terminalCoverage);
  superfluousDynamicCoverage.tasks.push({
    taskId: 'T058',
    findingId: 'HEX-C1-01',
    implementationAction: 'NO_EDIT',
  });
  assertIncludes(
    validateCoverage({
      coverage: superfluousDynamicCoverage,
      fixtureTasksText: rewriteTaskStatus(dynamicTasksText, 'T058', 'DONE'),
      taskIds: [...EXPECTED_TASK_IDS, 'T058'],
    }).errors,
    'stage-b-residual-coverage-superfluous-dynamic-no-edit',
    'T048 cannot append a needless T058+ task for an already-terminal finding',
  );

  const decoyT048Text = rewriteTaskBlock(tasksText, 'T048', (block) => block.replace(
    '  - **Contract** — ',
    '  Status: DONE.\n  - **Contract** — ',
  ));
  const decoyErrors = [];
  const decoyApplicability = validateStageBApplicability({
    campaignStage: 'STAGE_B',
    blocks: fixtureTaskBlocks(decoyT048Text),
    taskIds: EXPECTED_TASK_IDS,
    integrationInventory: coverageInventory,
    stageBResidualCoverageText: null,
    roadmapMatrixText: null,
    errors: decoyErrors,
  });
  assert.equal(decoyApplicability.required, false);
  assert.deepEqual(decoyErrors, []);
}

function sha256File(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function canonicalFixtureJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalFixtureJson(entry)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalFixtureJson(value[key])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

function resignShadowReportEvidence(report) {
  const { evidenceIdentity: _discardedIdentity, ...unsigned } = report;
  return {
    ...unsigned,
    evidenceIdentity: createHash('sha256').update(canonicalFixtureJson(unsigned)).digest('hex'),
  };
}

function resignRollingEvidence(evidence) {
  for (const result of evidence.results) {
    const { identity: _identity, ...resultWithoutIdentity } = result;
    result.identity = createHash('sha256')
      .update(canonicalFixtureJson(resultWithoutIdentity))
      .digest('hex');
  }
  const { identity: _identity, ...envelopeWithoutIdentity } = evidence;
  evidence.identity = createHash('sha256')
    .update(canonicalFixtureJson(envelopeWithoutIdentity))
    .digest('hex');
  return evidence;
}

function exerciseFramedDirectoryHashRegression() {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-framed-tree-hash-'));
  const splitTree = path.join(sandbox, 'split');
  const fusedTree = path.join(sandbox, 'fused');
  const externalTree = path.join(sandbox, 'external');
  fs.mkdirSync(splitTree, { recursive: true });
  fs.mkdirSync(fusedTree, { recursive: true });
  fs.mkdirSync(externalTree, { recursive: true });
  fs.writeFileSync(path.join(splitTree, 'a'), 'prefix');
  fs.writeFileSync(path.join(splitTree, 'b'), 'suffix');
  const secondMode = fs.lstatSync(path.join(splitTree, 'b')).mode;
  fs.writeFileSync(
    path.join(fusedTree, 'a'),
    Buffer.from(`prefixb\0${secondMode}\0suffix`),
  );
  try {
    assert.notEqual(
      hashDirectoryTree(splitTree),
      hashDirectoryTree(fusedTree),
      'typed length framing must distinguish a file payload from a forged following-entry record',
    );
    fs.symlinkSync(path.join(externalTree, 'payload'), path.join(splitTree, 'external-link'));
    fs.writeFileSync(path.join(externalTree, 'payload'), 'host-dependent bytes');
    assert.throws(
      () => hashDirectoryTree(splitTree, { requireContainedSymlinks: true }),
      /checkpoint-directory-symlink-outside-root:external-link/,
      'an exact dependency tree cannot inherit bytes through an external symlink',
    );
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

exerciseFramedDirectoryHashRegression();

function replaceEvidenceBlock(source, name, value) {
  const opening = `\`\`\`json ${name}\n`;
  const start = source.indexOf(opening);
  assert.notEqual(start, -1, `fixture must contain ${name}`);
  const end = source.indexOf('\n\`\`\`', start + opening.length);
  assert.notEqual(end, -1, `fixture must close ${name}`);
  const replacement = evidenceBlock(name, value).replace(/^# Fixture evidence\n\n/, '').trimEnd();
  return `${source.slice(0, start)}${replacement}${source.slice(end + 4)}`;
}

function createRollingCheckpointFixture(acceptedTaskIds, {
  componentWritesGenerated = false,
  moveMainBeforeSecond = false,
  reconcileSharedContractAtLast = false,
} = {}) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-checkpoint-lifecycle-'));
  git(sandbox, ['init', '-b', 'main']);
  git(sandbox, ['config', 'user.name', 'Hex Preflight Test']);
  git(sandbox, ['config', 'user.email', 'preflight@example.invalid']);
  write(sandbox, 'base.txt', 'base\n');
  copySourcePath(sandbox, '.gitignore');
  write(sandbox, 'scripts/build-userscript.mjs', '// deterministic checkpoint fixture generator\n');
  copySourcePath(sandbox, 'js/core/identity/index.js');
  write(sandbox, 'tests/phase8/run.mjs', '// deterministic rolling-gate fixture\n');
  write(sandbox, 'tests/rolling-pass.mjs', '// deterministic rolling npm-script fixture\n');
  for (const contract of Object.values(shadowContracts.contracts)) {
    for (const row of contract.cases) {
      write(sandbox, row.projection.argv[1], '// pinned independent shadow regression fixture\n');
    }
  }
  for (const taskId of acceptedTaskIds) {
    for (const gate of ownership.candidateGates.tasks[taskId].rolling) {
      if (gate.argv[0] !== 'node') continue;
      const entryPath = gate.argv.find((entry) => /^tests\/.+\.mjs$/.test(entry));
      if (entryPath) {
        write(sandbox, entryPath, '// deterministic checkpoint rolling-gate pass fixture\n');
      }
    }
  }
  write(sandbox, 'package-lock.json', `${JSON.stringify({
    name: 'hex-checkpoint-fixture',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': {
        name: 'hex-checkpoint-fixture',
        version: '1.0.0',
      },
    },
  }, null, 2)}\n`);
  write(sandbox, 'js/userscript/deployment-identity.generated.js', 'export const DEPLOYMENT_COMMIT = null;\n');
  write(sandbox, 'userscript/hex.user.template.js', '// checkpoint template base\n');
  write(sandbox, 'userscript/release-version.json', `${JSON.stringify({
    serial: 1,
    releaseIdentity: '0'.repeat(64),
    buildId: '0'.repeat(24),
  }, null, 2)}\n`);
  const baseSha = commitAll(sandbox, 'checkpoint base');
  let advancedMainSha = null;
  if (moveMainBeforeSecond) {
    git(sandbox, ['switch', '-c', 'advanced-main-fixture', baseSha]);
    write(sandbox, 'main-only.txt', 'moving main fixture\n');
    advancedMainSha = commitAll(sandbox, 'advance fixture main');
    git(sandbox, ['switch', 'main']);
  }
  const evidencePath = 'specs/005-analysis-final-closure/evidence/stage-a-checkpoints.md';
  const componentPaths = acceptedTaskIds.map(
    (taskId) => `tests/final-closure/${taskId.toLowerCase()}/checkpoint-fixture.test.mjs`,
  );
  const generatedPaths = [
    'js/userscript/deployment-identity.generated.js',
    'userscript/hex.user.template.js',
    'userscript/release-version.json',
  ];
  const finalPaths = [...new Set([
    ...integrationInventory.unionChangedPaths,
    evidencePath,
    ...componentPaths,
    ...generatedPaths,
  ])];
  const inventory = structuredClone(integrationInventory);
  inventory.baseSha = baseSha;
  inventory.expectedChangedPaths = [...finalPaths];
  inventory.actualChangedPaths = [...finalPaths];
  inventory.unionChangedPaths = [...finalPaths];
  inventory.entries = [
    ...inventory.entries,
    { path: evidencePath, ownerTaskId: 'T049' },
    ...generatedPaths.map((repoPath) => ({ path: repoPath, ownerTaskId: 'T049' })),
    ...componentPaths.map((repoPath, index) => ({
      path: repoPath,
      ownerTaskId: acceptedTaskIds[index],
    })),
  ];
  inventory.checkpoint = {
    schemaVersion: 'hex-final-closure-integration-checkpoint-state/v1',
    sequence: acceptedTaskIds.length,
    state: 'CHECKPOINT_GREEN',
    acceptedTaskId: acceptedTaskIds.at(-1),
    evidencePath,
  };
  inventory.taskHandoffs.T046 = {
    headSha: baseSha,
    treeSha: git(sandbox, ['rev-parse', `${baseSha}^{tree}`]),
    evidencePath: 'specs/005-analysis-final-closure/evidence/pre-fanout.md',
  };

  for (const repoPath of integrationInventory.unionChangedPaths) {
    let content;
    if (repoPath === 'specs/005-analysis-final-closure/contracts/task-ownership.json') {
      content = `${JSON.stringify(ownership, null, 2)}\n`;
    } else if (repoPath === 'package.json') {
      const sourcePackage = JSON.parse(fs.readFileSync(path.join(SOURCE_ROOT, repoPath), 'utf8'));
      const fixturePackage = {
        name: 'hex-checkpoint-fixture',
        version: '1.0.0',
        private: true,
        type: 'module',
        scripts: Object.fromEntries(
          Object.keys(sourcePackage.scripts || {}).map((name) => [name, 'node tests/rolling-pass.mjs']),
        ),
      };
      content = `${JSON.stringify(fixturePackage, null, 2)}\n`;
    } else if (repoPath === 'tools/validation/final-closure/preflight.mjs'
      || repoPath.startsWith('tools/validation/final-closure/shadow/foundation/')) {
      content = fs.readFileSync(path.join(SOURCE_ROOT, repoPath));
    } else {
      content = `prefanout fixture: ${repoPath}\n`;
    }
    write(sandbox, repoPath, content);
  }
  const preFanoutSha = commitAll(sandbox, 'T046 prefanout integration');
  inventory.taskHandoffs.T046 = {
    headSha: preFanoutSha,
    treeSha: git(sandbox, ['rev-parse', `${preFanoutSha}^{tree}`]),
    evidencePath: 'specs/005-analysis-final-closure/evidence/pre-fanout.md',
  };

  let fixtureTasksText = rewriteTaskStatus(tasksText, 'T046', 'DONE');
  write(sandbox, 'specs/005-analysis-final-closure/tasks.md', fixtureTasksText);
  write(
    sandbox,
    'specs/005-analysis-final-closure/contracts/integration-inventory.json',
    `${JSON.stringify(inventory, null, 2)}\n`,
  );
  const t046TransitionSha = commitAll(sandbox, 'T046 activation transition');
  const rows = [];
  const evidenceCommitShas = [];
  const componentHeadShas = [];
  let integrationParentSha = t046TransitionSha;
  let latestMainSha = baseSha;
  for (let index = 0; index < acceptedTaskIds.length; index += 1) {
    const taskId = acceptedTaskIds[index];
    let mainReconciliationMode = 'NOOP';
    let mainReconciliationAutoTreeSha = null;
    if (moveMainBeforeSecond && index === 1) {
      latestMainSha = advancedMainSha;
      mainReconciliationMode = 'EXACT_MERGE';
      mainReconciliationAutoTreeSha = git(sandbox, [
        'merge-tree', '--write-tree', integrationParentSha, latestMainSha,
      ]).split(/\s+/)[0];
      integrationParentSha = git(sandbox, [
        'commit-tree', mainReconciliationAutoTreeSha,
        '-p', integrationParentSha,
        '-p', latestMainSha,
        '-m', 'exact moving-main reconciliation',
      ]);
    }
    fixtureTasksText = rewriteTaskStatus(fixtureTasksText, taskId, 'DONE');
    git(sandbox, ['switch', '-c', `component-${taskId.toLowerCase()}`, integrationParentSha]);
    write(sandbox, componentPaths[index], `// ${taskId} checkpoint fixture\n`);
    if (componentWritesGenerated && index === 0) {
      write(sandbox, 'userscript/hex.user.template.js', '// component-owned generated output\n');
    }
    const componentHeadSha = commitAll(sandbox, `${taskId} component`);
    const componentTreeSha = git(sandbox, ['rev-parse', `${componentHeadSha}^{tree}`]);
    componentHeadShas.push(componentHeadSha);
    inventory.taskHandoffs[taskId] = {
      headSha: componentHeadSha,
      treeSha: componentTreeSha,
      evidencePath: componentPaths[index],
    };
    git(sandbox, ['checkout', '--detach', integrationParentSha]);
    const candidateMergeTreeSha = git(sandbox, [
      'merge-tree', '--write-tree', integrationParentSha, componentHeadSha,
    ]).split(/\s+/)[0];
    const acceptedMergeCommitSha = git(sandbox, [
      'commit-tree', candidateMergeTreeSha,
      '-p', integrationParentSha,
      '-p', componentHeadSha,
      '-m', `${taskId} accepted integration product`,
    ]);
    git(sandbox, ['checkout', '--detach', acceptedMergeCommitSha]);
    const releaseIdentity = stableDigest([taskId, acceptedMergeCommitSha]).padEnd(64, '0');
    const buildId = stableDigest([taskId, candidateMergeTreeSha]).slice(0, 24);
    write(
      sandbox,
      'js/userscript/deployment-identity.generated.js',
      `export const DEPLOYMENT_COMMIT = ${JSON.stringify(acceptedMergeCommitSha)};\n`,
    );
    write(sandbox, 'userscript/hex.user.template.js', `// checkpoint template ${taskId}\n`);
    write(sandbox, 'userscript/release-version.json', `${JSON.stringify({
      serial: index + 2,
      releaseIdentity,
      buildId,
    }, null, 2)}\n`);
    const reconciliationPaths = [];
    if (reconcileSharedContractAtLast && index === acceptedTaskIds.length - 1) {
      const sharedContractPath = 'specs/005-analysis-final-closure/contracts/closure-ledger.md';
      write(sandbox, sharedContractPath, `shared contract reconciled for ${taskId}\n`);
      reconciliationPaths.push(sharedContractPath);
    }
    const checkpointProductCommitSha = commitAll(sandbox, `${taskId} generated checkpoint product`);
    const checkpointProductTreeSha = git(sandbox, ['rev-parse', `${checkpointProductCommitSha}^{tree}`]);
    const acceptedMerge = {
      commitSha: acceptedMergeCommitSha,
      treeSha: candidateMergeTreeSha,
    };
    const checkpointProduct = {
      commitSha: checkpointProductCommitSha,
      treeSha: checkpointProductTreeSha,
    };
    const candidateIdentity = {
      headSha: checkpointProductCommitSha,
      treeSha: checkpointProductTreeSha,
    };
    const integrationReconciliation = {
      schemaVersion: 'hex-final-closure-product-reconciliation/v1',
      ownerTaskId: 'T049',
      mergeCommitSha: acceptedMergeCommitSha,
      productCommitSha: checkpointProductCommitSha,
      paths: reconciliationPaths,
      pathCount: reconciliationPaths.length,
      stableDigest: stableDigest([...reconciliationPaths].sort()),
    };
    const generation = checkpointGenerationEvidence(sandbox, {
      acceptedMerge,
      checkpointProduct,
      integrationReconciliation,
    });
    const rollingProductGates = executeRollingProductGates({
      root: sandbox,
      ownership,
      ownershipCommitSha: checkpointProductCommitSha,
      taskIds: acceptedTaskIds.slice(0, index + 1),
      candidateIdentity,
    });
    const shadowReports = acceptedTaskIds.slice(0, index + 1).flatMap(
      (shadowTaskId) => ownership.candidateGates.tasks[shadowTaskId].shadow
        .map((gate) => {
          return createShadowGateEvidence({
            root: sandbox,
            ownership,
            taskId: shadowTaskId,
            gate,
            headSha: candidateIdentity.headSha,
            treeSha: candidateIdentity.treeSha,
            authoritySha: acceptedMergeCommitSha,
            oracleObservation: shadowRawObservation(shadowTaskId, gate.id),
            productObservation: shadowRawObservation(shadowTaskId, gate.id),
          });
        }),
    );
    const independentShadowVerifier = checkpointShadowGateEvidence(candidateIdentity, shadowReports);
    const checkpointPaths = [...new Set([
      ...integrationInventory.unionChangedPaths,
      evidencePath,
      ...componentPaths.slice(0, index + 1),
      ...generatedPaths,
    ])];
    rows.push({
      sequence: index + 1,
      acceptedTaskId: taskId,
      integrationParentSha,
      mainReconciliation: {
        schemaVersion: 'hex-final-closure-main-reconciliation/v1',
        mode: mainReconciliationMode,
        previousEvidenceSha: index === 0 ? t046TransitionSha : evidenceCommitShas[index - 1],
        currentMainSha: latestMainSha,
        integrationHeadSha: integrationParentSha,
        integrationHeadTreeSha: git(sandbox, ['rev-parse', `${integrationParentSha}^{tree}`]),
        autoMergeTreeSha: mainReconciliationAutoTreeSha,
        adjustmentPaths: [],
        adjustmentStableDigest: stableDigest([]),
      },
      componentHeadSha,
      candidateMergeTreeSha,
      acceptedMerge,
      checkpointProduct,
      integrationReconciliation,
      generation,
      rollingProductGates,
      independentShadowVerifier,
      initialCandidateGateDigest: FROZEN_INITIAL_CANDIDATE_GATE_DIGEST,
      cumulativeInventory: {
        baseSha: latestMainSha,
        stableDigest: stableDigest([...checkpointPaths].sort()),
        pathCount: checkpointPaths.length,
      },
    });
    write(sandbox, evidencePath, evidenceBlock('final-closure-stage-a-checkpoints', {
      schemaVersion: 'hex-final-closure-integration-checkpoint-ledger/v1',
      campaignStage: 'STAGE_A',
      checkpoints: rows,
    }));
    write(sandbox, 'specs/005-analysis-final-closure/tasks.md', fixtureTasksText);
    write(sandbox, 'specs/005-analysis-final-closure/contracts/integration-inventory.json', `${JSON.stringify({
      fixture: true,
      sequence: index + 1,
      acceptedTaskId: taskId,
    }, null, 2)}\n`);
    const evidenceCommitSha = commitAll(sandbox, `${taskId} checkpoint evidence`);
    evidenceCommitShas.push(evidenceCommitSha);
    integrationParentSha = evidenceCommitSha;
  }
  const ledger = {
    schemaVersion: 'hex-final-closure-integration-checkpoint-ledger/v1',
    campaignStage: 'STAGE_A',
    checkpoints: rows,
  };
  if (moveMainBeforeSecond) inventory.baseSha = advancedMainSha;
  const closurePath = 'specs/005-analysis-final-closure/evidence/recovery-reviews.md';
  write(sandbox, closurePath, 'terminal closure\n');
  const closureCommitSha = commitAll(sandbox, 'terminal closure descendant');
  return {
    sandbox,
    baseSha: inventory.baseSha,
    originalBaseSha: baseSha,
    advancedMainSha,
    inventory,
    tasksText: fixtureTasksText,
    ledger,
    evidencePath,
    evidenceCommitShas,
    componentHeadShas,
    componentPaths,
    closurePath,
    closureCommitSha,
    checkpointEvidenceText: evidenceBlock('final-closure-stage-a-checkpoints', ledger),
  };
}

function validateRollingCheckpointFixture(fixture, {
  tasks = fixture.tasksText,
  inventory = fixture.inventory,
  checkpointEvidenceText = fixture.checkpointEvidenceText,
} = {}) {
  return validatePreflightContracts({
    tasksText: tasks,
    ownership,
    integrationInventory: inventory,
    platformLocks,
    performanceLocks,
    workflowText,
    preFanoutText,
    checkpointEvidenceText,
    actualChangedPaths: inventory.unionChangedPaths,
    expectedBaseSha: fixture.baseSha,
  });
}

function exerciseCheckpointRegressions() {
  const secondComponent = createRollingCheckpointFixture(['T011', 'T012']);
  try {
    const valid = validateRollingCheckpointFixture(secondComponent);
    assert.equal(valid.ok, true, valid.errors.join('\n'));
    assert.equal(valid.checkpointResult.checkpoint.sequence, 2);
    assert.deepEqual(valid.checkpointResult.remainingComponentTaskIds, [
      'T013', 'T014', 'T015', 'T016', 'T017',
      'T051', 'T052', 'T053', 'T054', 'T055', 'T056', 'T057',
    ]);
    assert.deepEqual(
      secondComponent.ledger.checkpoints[1].rollingProductGates.taskIds,
      ['T011', 'T012'],
      'each later checkpoint must record the complete accepted-task rolling set',
    );
    assert.deepEqual(
      [...new Set(secondComponent.ledger.checkpoints[1].independentShadowVerifier.reports
        .map((report) => report.taskId))],
      ['T011', 'T012'],
      'each later checkpoint must record independent shadow proof for every accepted task',
    );
    assert.equal(
      secondComponent.ledger.checkpoints[1].independentShadowVerifier.aggregate.status,
      'PARTIAL_ZERO',
      'an intermediate checkpoint may truthfully retain zero-valued counters with partial denominator coverage',
    );
    const exactCheckpoint = verifyCheckpointOperationalEvidence(
      secondComponent.sandbox,
      valid,
      secondComponent.evidenceCommitShas.at(-1),
    );
    assert.equal(exactCheckpoint.sequence, 2, 'a valid second component checkpoint is accepted');
    const latestRow = secondComponent.ledger.checkpoints.at(-1);
    const runtimeCalls = [];
    const runtime = verifyCheckpointRuntimeEvidence({
      root: secondComponent.sandbox,
      result: valid,
      integrationHeadSha: secondComponent.evidenceCommitShas.at(-1),
      spawn(command, argv, options) {
        runtimeCalls.push([command, ...argv]);
        return spawnSync(command, argv, options);
      },
    });
    assert.equal(runtime.verdict, 'CHECKPOINT_RUNTIME_GREEN');
    assert.equal(runtime.sequence, 2);
    assert.equal(
      runtimeCalls.filter((argv) => argv[1] === 'scripts/build-userscript.mjs').length,
      2,
      'the canonical generator is rerun twice against the exact checkpoint product',
    );
    const realRuntime = verifyCheckpointRuntimeEvidence({
      root: secondComponent.sandbox,
      result: valid,
      integrationHeadSha: secondComponent.evidenceCommitShas.at(-1),
    });
    assert.equal(
      realRuntime.verdict,
      'CHECKPOINT_RUNTIME_GREEN',
      'a sequence>0 checkpoint must execute its real generator, rolling gate, oracle, and verifier processes',
    );
    assert.match(realRuntime.runtimeEphemeralIdentity, /^[0-9a-f]{64}$/);
    assert.throws(
      () => verifyCheckpointRuntimeEvidence({
        root: secondComponent.sandbox,
        result: valid,
        integrationHeadSha: secondComponent.evidenceCommitShas.at(-1),
        spawn(command, argv, options) {
          if (command === 'npm' && argv[0] === 'run' && argv[1] === 'decompiler:test') {
            return {
              status: 7,
              signal: null,
              error: null,
              stdout: Buffer.from('later G2 regressed T011\n'),
              stderr: Buffer.alloc(0),
            };
          }
          return spawnSync(command, argv, options);
        },
      }),
      /checkpoint-runtime-rolling-failed:2:checkpoint-rolling-gate-failed:T011:t011-decompiler-suite:7/,
      'a later checkpoint must fail when it regresses an earlier accepted task',
    );
    const nondeterministicOutputRuntime = verifyCheckpointRuntimeEvidence({
      root: secondComponent.sandbox,
      result: valid,
      integrationHeadSha: secondComponent.evidenceCommitShas.at(-1),
      spawn(command, argv, options) {
        const child = spawnSync(command, argv, options);
        if (argv[0] === 'tests/phase8/run.mjs') {
          return { ...child, stdout: Buffer.from('changed rolling output\n') };
        }
        return child;
      },
    });
    assert.equal(nondeterministicOutputRuntime.verdict, 'CHECKPOINT_RUNTIME_GREEN');
    assert.notEqual(
      nondeterministicOutputRuntime.rollingProductGates.identity,
      latestRow.rollingProductGates.identity,
      'each invocation retains its own output receipt without treating reporter timing as semantics',
    );

    git(secondComponent.sandbox, [
      'checkout', '--quiet', '--detach', latestRow.checkpointProduct.commitSha,
    ]);
    for (const [label, spawn, expected] of [
      [
        'nonzero exit',
        () => ({
          status: 7,
          signal: null,
          error: null,
          stdout: Buffer.from('PASS\n'),
          stderr: Buffer.alloc(0),
        }),
        /checkpoint-rolling-gate-failed:T012:t012-phase8-memory:7/,
      ],
      [
        'spawn error',
        () => ({
          status: null,
          signal: null,
          error: { code: 'ENOENT' },
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
        }),
        /checkpoint-rolling-gate-failed:T012:t012-phase8-memory:ENOENT/,
      ],
      [
        'output overflow',
        () => ({
          status: 0,
          signal: null,
          error: null,
          stdout: Buffer.alloc((64 * 1024) + 1),
          stderr: Buffer.alloc(0),
        }),
        /checkpoint-rolling-output-limit-exceeded/,
      ],
    ]) {
      assert.throws(
        () => executeRollingProductGates({
          root: secondComponent.sandbox,
          ownership,
          ownershipCommitSha: latestRow.checkpointProduct.commitSha,
          taskIds: [latestRow.acceptedTaskId],
          candidateIdentity: {
            headSha: latestRow.checkpointProduct.commitSha,
            treeSha: latestRow.checkpointProduct.treeSha,
          },
          spawn,
        }),
        expected,
        `rolling evidence must reject a ${label} even when child output claims PASS`,
      );
    }
    git(secondComponent.sandbox, [
      'checkout', '--quiet', '--detach', secondComponent.closureCommitSha,
    ]);
    assert.throws(
      () => verifyCheckpointRuntimeEvidence({
        root: secondComponent.sandbox,
        result: valid,
        integrationHeadSha: secondComponent.evidenceCommitShas.at(-1),
        spawn(command, argv, options) {
          if (argv[0] === 'scripts/build-userscript.mjs') {
            fs.appendFileSync(
              path.join(options.cwd, 'userscript/hex.user.template.js'),
              '// non-reproducible mutation\n',
            );
          }
          return { status: 0, stdout: '' };
        },
      }),
      /checkpoint-runtime-product-mutated:2:generation-first/,
      'a successful generator exit cannot hide a tracked generated-output diff',
    );
    assert.throws(
      () => verifyCheckpointRuntimeEvidence({
        root: secondComponent.sandbox,
        result: valid,
        integrationHeadSha: secondComponent.evidenceCommitShas.at(-1),
        spawn(command, argv, options) {
          if (argv[0] === 'scripts/build-userscript.mjs') {
            write(options.cwd, 'untracked-runtime-input.json', '{}\n');
          }
          return { status: 0, stdout: '' };
        },
      }),
      /checkpoint-runtime-untracked-path:untracked-runtime-input\.json/,
      'an exit-zero generator cannot inject an undeclared untracked or ignored input into exact-G replay',
    );
    assert.throws(
      () => verifyCheckpointRuntimeEvidence({
        root: secondComponent.sandbox,
        result: valid,
        integrationHeadSha: secondComponent.evidenceCommitShas.at(-1),
        spawn(command, argv, options) {
          if (argv[0] === 'scripts/build-userscript.mjs') {
            write(options.cwd, 'node_modules/.mutated-after-install', 'mutated\n');
          }
          return { status: 0, signal: null, error: null, stdout: '', stderr: '' };
        },
      }),
      /checkpoint-runtime-dependency-mutated:2:generation-first/,
      'historical replay must not consume dependency bytes mutated after exact-lock installation',
    );

    assertIncludes(
      validateRollingCheckpointFixture(secondComponent, { checkpointEvidenceText: null }).errors,
      'stage-evidence-block-missing',
      'a sequence>0 checkpoint must include its fixed ledger block',
    );
    assertIncludes(
      validateRollingCheckpointFixture(secondComponent, {
        checkpointEvidenceText: `${secondComponent.checkpointEvidenceText}\n${secondComponent.checkpointEvidenceText}`,
      }).errors,
      'stage-evidence-block-duplicate',
      'duplicate checkpoint ledger blocks are ambiguous and must fail',
    );
    assertIncludes(
      validateRollingCheckpointFixture(secondComponent, {
        checkpointEvidenceText: '# malformed\n```json final-closure-stage-a-checkpoints\n{\n```\n',
      }).errors,
      'stage-evidence-json-malformed',
      'malformed checkpoint ledger JSON must fail closed',
    );

    const structuralMutation = (mutator) => {
      const mutated = structuredClone(secondComponent.ledger);
      mutator(mutated);
      return validateRollingCheckpointFixture(secondComponent, {
        checkpointEvidenceText: evidenceBlock('final-closure-stage-a-checkpoints', mutated),
      }).errors;
    };
    assertIncludes(structuralMutation((ledger) => {
      ledger.checkpoints[1].generation.secondRunDiffEmpty = false;
    }), 'checkpoint-generation-invalid', 'the canonical second generation must have an empty diff');
    assertIncludes(structuralMutation((ledger) => {
      ledger.checkpoints[1].rollingProductGates.status = 'FAIL';
    }), 'checkpoint-rolling-gates-invalid', 'red rolling product gates must block the checkpoint');
    assertIncludes(structuralMutation((ledger) => {
      ledger.checkpoints[1].independentShadowVerifier.status = 'FAIL';
    }), 'checkpoint-shadow-verifier-invalid', 'a red independent verifier must block the checkpoint');
    assertIncludes(structuralMutation((ledger) => {
      ledger.checkpoints[1].initialCandidateGateDigest = '0'.repeat(32);
    }), 'checkpoint-candidate-gate-digest-invalid', 'checkpoint evidence cannot bind another gate registry');
    assertIncludes(structuralMutation((ledger) => {
      ledger.checkpoints[1].sequence = 3;
    }), 'checkpoint-ledger-sequence-invalid', 'checkpoint sequence must be contiguous and monotonic');
    assertIncludes(structuralMutation((ledger) => {
      ledger.checkpoints[1].sequence = 1;
    }), 'checkpoint-ledger-sequence-invalid', 'duplicate checkpoint sequence numbers must fail');
    assertIncludes(structuralMutation((ledger) => {
      ledger.checkpoints[1].acceptedTaskId = 'T011';
    }), 'checkpoint-ledger-task-duplicate', 'one component task cannot occupy two checkpoints');
    for (const [label, mutate] of [
      ['base', (row) => { row.cumulativeInventory.baseSha = 'f'.repeat(40); }],
      ['digest', (row) => { row.cumulativeInventory.stableDigest = 'f'.repeat(32); }],
      ['count', (row) => { row.cumulativeInventory.pathCount += 1; }],
    ]) {
      assertIncludes(structuralMutation((ledger) => mutate(ledger.checkpoints[1])),
        'checkpoint-cumulative-inventory-mismatch',
        `a checkpoint cumulative inventory ${label} mismatch must fail`);
    }

    const operationalMutation = (mutator) => {
      const mutated = structuredClone(valid);
      mutator(mutated.checkpointResult.ledger.checkpoints[1]);
      return () => verifyCheckpointOperationalEvidence(
        secondComponent.sandbox,
        mutated,
        secondComponent.evidenceCommitShas.at(-1),
      );
    };
    const historicalInventoryMismatch = structuredClone(valid);
    historicalInventoryMismatch.checkpointResult.ledger.checkpoints[0]
      .cumulativeInventory.stableDigest = 'f'.repeat(32);
    assert.throws(
      () => verifyCheckpointOperationalEvidence(
        secondComponent.sandbox,
        historicalInventoryMismatch,
        secondComponent.evidenceCommitShas.at(-1),
      ),
      /checkpoint-evidence-ledger-mismatch:1/,
      'a current ledger cannot rewrite the exact historical checkpoint packet after the fact',
    );
    assert.throws(operationalMutation((row) => {
      row.componentHeadSha = secondComponent.componentHeadShas[0];
    }), /checkpoint-task-handoff-mismatch/, 'a stale component head cannot attest the second product');
    assert.throws(operationalMutation((row) => {
      row.componentHeadSha = 'f'.repeat(40);
    }), /checkpoint-task-handoff-mismatch/, 'an invalid component head cannot attest a product');
    assert.throws(operationalMutation((row) => {
      row.candidateMergeTreeSha = git(secondComponent.sandbox, ['rev-parse', `${secondComponent.baseSha}^{tree}`]);
    }), /checkpoint-candidate-tree-mismatch/, 'a stale candidate merge tree must fail');
    assert.throws(operationalMutation((row) => {
      row.acceptedMerge.treeSha = git(secondComponent.sandbox, ['rev-parse', `${secondComponent.baseSha}^{tree}`]);
    }), /checkpoint-accepted-merge-tree-mismatch/, 'a stale accepted merge tree must fail');
    assert.throws(operationalMutation((row) => {
      row.checkpointProduct.treeSha = git(secondComponent.sandbox, ['rev-parse', `${secondComponent.baseSha}^{tree}`]);
    }), /checkpoint-product-tree-mismatch/, 'a stale checkpoint product tree must fail');
    const latestFixtureRow = secondComponent.ledger.checkpoints[1];
    const wrongParentProductCommitSha = git(secondComponent.sandbox, [
      'commit-tree', latestFixtureRow.checkpointProduct.treeSha,
      '-p', latestFixtureRow.integrationParentSha,
      '-m', 'checkpoint product with wrong parent',
    ]);
    assert.throws(operationalMutation((row) => {
      row.checkpointProduct.commitSha = wrongParentProductCommitSha;
      row.generation.candidateIdentity.headSha = wrongParentProductCommitSha;
      row.rollingProductGates.candidateIdentity.headSha = wrongParentProductCommitSha;
      row.independentShadowVerifier.candidateIdentity.headSha = wrongParentProductCommitSha;
    }), /checkpoint-product-parent-mismatch:2/, 'G_i must be the single-parent child of exact M_i');
    assert.throws(operationalMutation((row) => {
      row.integrationParentSha = secondComponent.ledger.checkpoints[0].checkpointProduct.commitSha;
    }), /checkpoint-evidence-commit-missing/, 'a substituted integration parent cannot bypass the prior evidence boundary');
    assert.throws(operationalMutation((row) => {
      row.acceptedTaskId = 'T011';
    }), /checkpoint-task-handoff-mismatch:2:T011/, 'a task label cannot attest another task handoff head');
    git(secondComponent.sandbox, [
      'checkout', '--quiet', '--detach', latestFixtureRow.integrationParentSha,
    ]);
    write(
      secondComponent.sandbox,
      secondComponent.componentPaths[0],
      '// T011 path illicitly changed by a T012-labelled component\n',
    );
    const mislabeledComponentSha = commitAll(secondComponent.sandbox, 'coordinated task-label attack');
    const mislabeledResult = structuredClone(valid);
    mislabeledResult.checkpointResult.ledger.checkpoints[1].componentHeadSha = mislabeledComponentSha;
    mislabeledResult.taskHandoffResult.handoffs.T012 = {
      ...mislabeledResult.taskHandoffResult.handoffs.T012,
      headSha: mislabeledComponentSha,
      treeSha: git(secondComponent.sandbox, ['rev-parse', `${mislabeledComponentSha}^{tree}`]),
    };
    assert.throws(
      () => verifyCheckpointOperationalEvidence(
        secondComponent.sandbox,
        mislabeledResult,
        secondComponent.evidenceCommitShas.at(-1),
      ),
      /checkpoint-component-inventory-invalid:2:inventory-path-outside-allowlist:T012:/,
      'a coordinated handoff/task-label rewrite cannot authorize another component owner\'s delta',
    );
    assert.throws(operationalMutation((row) => {
      row.generation.artifactIdentity = 'f'.repeat(64);
    }), /checkpoint-generation-evidence-mismatch:2/, 'generation hashes are recomputed from exact product blobs');
    assert.throws(operationalMutation((row) => {
      row.rollingProductGates.identity = 'f'.repeat(64);
    }), /checkpoint-rolling-evidence-mismatch:2/, 'rolling evidence cannot be an arbitrary shaped hash');
    assert.throws(operationalMutation((row) => {
      row.rollingProductGates.results[0].process.exitCode = 7;
      resignRollingEvidence(row.rollingProductGates);
    }), /checkpoint-rolling-evidence-mismatch:2/,
    'a correctly re-signed rolling envelope cannot turn a nonzero process exit into PASS');
    assert.throws(operationalMutation((row) => {
      row.rollingProductGates.results[0].registeredArgv.push('--forged');
      row.rollingProductGates.results[0].registeredArgvDigest = stableDigest(
        row.rollingProductGates.results[0].registeredArgv,
      );
      resignRollingEvidence(row.rollingProductGates);
    }), /checkpoint-rolling-evidence-mismatch:2/,
    'rolling evidence argv must remain exact-equal to the registry even after re-signing');
    assert.throws(operationalMutation((row) => {
      row.independentShadowVerifier.reports[0].authorityArtifacts[0].sha256 = 'f'.repeat(64);
    }), /checkpoint-shadow-report-mismatch:2/, 'shadow authority bytes are resolved from the exact product commit');
    assert.throws(operationalMutation((row) => {
      row.independentShadowVerifier.reports[0].evidenceIdentity = 'f'.repeat(64);
    }), /checkpoint-shadow-report-mismatch:2/, 'a shadow verifier cannot self-certify an arbitrary evidence identity');

    git(secondComponent.sandbox, [
      'checkout', '--quiet', '--detach', latestFixtureRow.acceptedMerge.commitSha,
    ]);
    write(secondComponent.sandbox, 'docs/checkpoint-product-escape.md', 'not generated output\n');
    const broadProductCommitSha = commitAll(secondComponent.sandbox, 'broad checkpoint product');
    const broadProductTreeSha = git(secondComponent.sandbox, ['rev-parse', 'HEAD^{tree}']);
    assert.throws(operationalMutation((row) => {
      row.checkpointProduct = { commitSha: broadProductCommitSha, treeSha: broadProductTreeSha };
    }), /checkpoint-product-reconciliation-mismatch:2:docs\/checkpoint-product-escape\.md/,
    'G_i may not conceal an undeclared integration reconciliation edit');

    git(secondComponent.sandbox, [
      'checkout', '--quiet', '--detach', latestFixtureRow.checkpointProduct.commitSha,
    ]);
    write(secondComponent.sandbox, secondComponent.evidencePath, secondComponent.checkpointEvidenceText);
    write(secondComponent.sandbox, 'specs/005-analysis-final-closure/tasks.md', secondComponent.tasksText);
    write(secondComponent.sandbox, 'specs/005-analysis-final-closure/contracts/integration-inventory.json',
      `${JSON.stringify({ fixture: true, extraEvidencePath: true }, null, 2)}\n`);
    write(secondComponent.sandbox, 'docs/checkpoint-evidence-escape.md', 'not evidence\n');
    const broadEvidenceCommitSha = commitAll(secondComponent.sandbox, 'broad checkpoint evidence');
    assert.throws(
      () => verifyCheckpointOperationalEvidence(secondComponent.sandbox, valid, broadEvidenceCommitSha),
      /checkpoint-evidence-path-set-invalid:2:invalid=docs\/checkpoint-evidence-escape\.md/,
      'E_i may change only the exact evidence publication allowlist',
    );

    const omittedPath = secondComponent.componentPaths[0];
    const fraudulentInventory = structuredClone(secondComponent.inventory);
    for (const key of ['expectedChangedPaths', 'actualChangedPaths', 'unionChangedPaths']) {
      fraudulentInventory[key] = fraudulentInventory[key].filter((repoPath) => repoPath !== omittedPath);
    }
    fraudulentInventory.entries = fraudulentInventory.entries
      .filter((entry) => entry.path !== omittedPath);
    const fraudulentLedger = structuredClone(secondComponent.ledger);
    fraudulentLedger.checkpoints[1].cumulativeInventory = {
      baseSha: secondComponent.baseSha,
      stableDigest: stableDigest([...fraudulentInventory.unionChangedPaths].sort()),
      pathCount: fraudulentInventory.unionChangedPaths.length,
    };
    const fraudulentEvidenceText = evidenceBlock('final-closure-stage-a-checkpoints', fraudulentLedger);
    git(secondComponent.sandbox, [
      'checkout', '--quiet', '--detach', fraudulentLedger.checkpoints[1].checkpointProduct.commitSha,
    ]);
    write(secondComponent.sandbox, secondComponent.evidencePath, fraudulentEvidenceText);
    write(secondComponent.sandbox, 'specs/005-analysis-final-closure/tasks.md', secondComponent.tasksText);
    write(secondComponent.sandbox, 'specs/005-analysis-final-closure/contracts/integration-inventory.json',
      `${JSON.stringify({ fixture: true, fraudulent: true }, null, 2)}\n`);
    const fraudulentEvidenceHead = commitAll(secondComponent.sandbox, 'fraudulent cumulative inventory evidence');
    const structurallyConsistentFraud = validateRollingCheckpointFixture(secondComponent, {
      inventory: fraudulentInventory,
      checkpointEvidenceText: fraudulentEvidenceText,
    });
    assert.equal(structurallyConsistentFraud.ok, true, structurallyConsistentFraud.errors.join('\n'));
    assert.throws(
      () => verifyCheckpointOperationalEvidence(
        secondComponent.sandbox,
        structurallyConsistentFraud,
        fraudulentEvidenceHead,
      ),
      /checkpoint-cumulative-inventory-operational-mismatch:2/,
      'a self-consistent ledger and inventory cannot omit a path present in the exact checkpoint tree',
    );

    assert.throws(
      () => verifyCheckpointOperationalEvidence(
        secondComponent.sandbox,
        valid,
        secondComponent.closureCommitSha,
      ),
      /checkpoint-tail-main-reconciliation-parents-invalid/,
      'a non-checkpoint commit cannot open an interval while stage components remain',
    );
  } finally {
    fs.rmSync(secondComponent.sandbox, { recursive: true, force: true });
  }

  const generatedByComponent = createRollingCheckpointFixture(
    ['T011'],
    { componentWritesGenerated: true },
  );
  try {
    const structural = validateRollingCheckpointFixture(generatedByComponent);
    assert.equal(structural.ok, true, structural.errors.join('\n'));
    assert.throws(
      () => verifyCheckpointOperationalEvidence(
        generatedByComponent.sandbox,
        structural,
        generatedByComponent.evidenceCommitShas[0],
      ),
      /checkpoint-component-generated-output:1:userscript\/hex\.user\.template\.js/,
      'a component handoff cannot own a generated output that only the integration owner may publish',
    );
  } finally {
    fs.rmSync(generatedByComponent.sandbox, { recursive: true, force: true });
  }

  const movingMain = createRollingCheckpointFixture(
    ['T011', 'T012'],
    { moveMainBeforeSecond: true },
  );
  try {
    const valid = validateRollingCheckpointFixture(movingMain);
    assert.equal(valid.ok, true, valid.errors.join('\n'));
    assert.equal(movingMain.ledger.checkpoints[1].mainReconciliation.mode, 'EXACT_MERGE');
    const operational = verifyCheckpointOperationalEvidence(
      movingMain.sandbox,
      valid,
      movingMain.evidenceCommitShas.at(-1),
      { componentMode: true, currentMainSha: movingMain.advancedMainSha },
    );
    assert.equal(operational.sequence, 2, 'a verified moving-main merge may precede the next component');

    const staleMain = structuredClone(valid);
    staleMain.checkpointResult.ledger.checkpoints[1].mainReconciliation.currentMainSha = movingMain.originalBaseSha;
    assert.throws(
      () => verifyCheckpointOperationalEvidence(
        movingMain.sandbox,
        staleMain,
        movingMain.evidenceCommitShas.at(-1),
        { componentMode: true, currentMainSha: movingMain.advancedMainSha },
      ),
      /checkpoint-main-reconciliation-(?:invalid|parents-invalid|base-mismatch):2/,
      'a recorded stale main identity cannot authorize a reconciled integration parent',
    );
    const omittedAdjustment = structuredClone(valid);
    omittedAdjustment.checkpointResult.ledger.checkpoints[1]
      .mainReconciliation.adjustmentPaths = ['specs/005-analysis-final-closure/contracts/integration-inventory.json'];
    omittedAdjustment.checkpointResult.ledger.checkpoints[1]
      .mainReconciliation.adjustmentStableDigest = stableDigest([
        'specs/005-analysis-final-closure/contracts/integration-inventory.json',
      ]);
    assert.throws(
      () => verifyCheckpointOperationalEvidence(
        movingMain.sandbox,
        omittedAdjustment,
        movingMain.evidenceCommitShas.at(-1),
      ),
      /checkpoint-main-reconciliation-adjustment-invalid:2/,
      'recorded moving-main adjustment paths must exactly equal the independently derived tree delta',
    );
  } finally {
    fs.rmSync(movingMain.sandbox, { recursive: true, force: true });
  }

  const sharedReconciliation = createRollingCheckpointFixture(
    ['T011'],
    { reconcileSharedContractAtLast: true },
  );
  try {
    const valid = validateRollingCheckpointFixture(sharedReconciliation);
    assert.equal(valid.ok, true, valid.errors.join('\n'));
    const row = sharedReconciliation.ledger.checkpoints[0];
    assert.deepEqual(row.integrationReconciliation.paths, [
      'specs/005-analysis-final-closure/contracts/closure-ledger.md',
    ]);
    assert.equal(
      verifyCheckpointOperationalEvidence(
        sharedReconciliation.sandbox,
        valid,
        sharedReconciliation.evidenceCommitShas[0],
      ).sequence,
      1,
      'G_i may contain an exact declared checkpoint-owner shared-contract reconciliation plus generated output',
    );
    const missingDeclaration = structuredClone(valid);
    missingDeclaration.checkpointResult.ledger.checkpoints[0].integrationReconciliation.paths = [];
    missingDeclaration.checkpointResult.ledger.checkpoints[0].integrationReconciliation.pathCount = 0;
    missingDeclaration.checkpointResult.ledger.checkpoints[0].integrationReconciliation.stableDigest = stableDigest([]);
    assert.throws(
      () => verifyCheckpointOperationalEvidence(
        sharedReconciliation.sandbox,
        missingDeclaration,
        sharedReconciliation.evidenceCommitShas[0],
      ),
      /checkpoint-product-reconciliation-mismatch:1/,
      'an integration reconciliation path must not be omitted from the exact manifest',
    );
  } finally {
    fs.rmSync(sharedReconciliation.sandbox, { recursive: true, force: true });
  }

  const completeStage = createRollingCheckpointFixture([
    'T011', 'T012', 'T013', 'T014', 'T015', 'T016', 'T017',
    'T051', 'T052', 'T053', 'T054', 'T055', 'T056', 'T057',
  ]);
  try {
    const terminalInventory = structuredClone(completeStage.inventory);
    for (const key of ['expectedChangedPaths', 'actualChangedPaths', 'unionChangedPaths']) {
      terminalInventory[key] = [...terminalInventory[key], completeStage.closurePath];
    }
    terminalInventory.entries = [
      ...terminalInventory.entries,
      { path: completeStage.closurePath, ownerTaskId: 'T019' },
    ];
    const valid = validateRollingCheckpointFixture(completeStage, { inventory: terminalInventory });
    assert.equal(valid.ok, true, valid.errors.join('\n'));
    assert.deepEqual(valid.checkpointResult.remainingComponentTaskIds, []);
    const terminalShadow = completeStage.ledger.checkpoints.at(-1).independentShadowVerifier;
    assert.equal(terminalShadow.aggregate.status, 'COMPLETE_ZERO');
    assert.deepEqual(
      terminalShadow.aggregate.counters.map((row) => row.id),
      [
        'falseExactNoAlias',
        'falseExactMustAlias',
        'falseExactIndirectTarget',
        'falseExactType',
        'semanticMismatch',
        'stalePublicationAfterCancel',
        'invalidWriterOutputAccepted',
      ],
      'the terminal aggregate must retain one deterministic record for every hard counter',
    );
    for (const counterId of terminalShadow.aggregate.counters.map((row) => row.id)) {
      const incompleteLedger = structuredClone(completeStage.ledger);
      const latestShadow = incompleteLedger.checkpoints.at(-1).independentShadowVerifier;
      latestShadow.reports = latestShadow.reports.map((report) => {
        const mutated = structuredClone(report);
        const counter = mutated.proof.counters.find((row) => row.id === counterId);
        counter.denominator = 0;
        counter.observed = 0;
        return resignShadowReportEvidence(mutated);
      });
      incompleteLedger.checkpoints.at(-1).independentShadowVerifier = checkpointShadowGateEvidence(
        latestShadow.candidateIdentity,
        latestShadow.reports,
      );
      assert.throws(
        () => assertTerminalShadowCounterEvidence(
          incompleteLedger.checkpoints.at(-1).independentShadowVerifier,
        ),
        new RegExp(`checkpoint-shadow-terminal-counter-invalid:.*${counterId}`),
        `terminal promotion must reject zero denominator coverage for ${counterId}`,
      );
    }
    const pinnedShadowAuthority = {
      ownership,
      shadowAuthorityDefinition: { registry: shadowRegistry, contracts: shadowContracts },
    };
    const inflatedDenominator = structuredClone(terminalShadow.reports[0]);
    inflatedDenominator.proof.counters[0].denominator += 1;
    assert.throws(
      () => checkpointShadowGateEvidence(
        terminalShadow.candidateIdentity,
        [resignShadowReportEvidence(inflatedDenominator), ...terminalShadow.reports.slice(1)],
        pinnedShadowAuthority,
      ),
      /checkpoint-shadow-report-proof-mismatch/,
      'a coordinated outer re-sign cannot inflate a denominator beyond its pinned contract cases',
    );
    for (const identityField of ['verifierIdentity', 'authorityIdentity', 'judgeIdentity']) {
      const mutatedIdentity = structuredClone(terminalShadow.reports[0]);
      mutatedIdentity[identityField] = '0'.repeat(64);
      assert.throws(
        () => checkpointShadowGateEvidence(
          terminalShadow.candidateIdentity,
          [resignShadowReportEvidence(mutatedIdentity), ...terminalShadow.reports.slice(1)],
          pinnedShadowAuthority,
        ),
        /checkpoint-shadow-report-invalid/,
        `a coordinated outer re-sign cannot detach ${identityField} from its inner artifact set`,
      );
    }
    const divergentReport = structuredClone(terminalShadow.reports[0]);
    divergentReport.proof.counters[0].observed = 1;
    assert.throws(
      () => checkpointShadowGateEvidence(
        terminalShadow.candidateIdentity,
        [resignShadowReportEvidence(divergentReport), ...terminalShadow.reports.slice(1)],
      ),
      /checkpoint-shadow-report-counter-nonzero/,
      'a re-signed report with a nonzero hard counter cannot enter any checkpoint aggregate',
    );
    const terminal = verifyCheckpointOperationalEvidence(
      completeStage.sandbox,
      valid,
      completeStage.closureCommitSha,
    );
    assert.equal(
      terminal.evidenceCommitSha,
      completeStage.evidenceCommitShas.at(-1),
      'terminal closure descendants are accepted only after every Stage A component is DONE',
    );
    assert.throws(
      () => verifyCheckpointOperationalEvidence(
        completeStage.sandbox,
        valid,
        completeStage.closureCommitSha,
        { componentMode: true },
      ),
      /checkpoint-tail-main-reconciliation-parents-invalid/,
      'component mode accepts only the exact checkpoint or a verified moving-main reconciliation as its base',
    );
  } finally {
    fs.rmSync(completeStage.sandbox, { recursive: true, force: true });
  }
}

exerciseCheckpointRegressions();

function createOperationalFixture() {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-preflight-regression-'));
  const origin = path.join(sandbox, 'origin.git');
  const candidate = path.join(sandbox, 'candidate');
  fs.mkdirSync(candidate);
  git(sandbox, ['init', '--bare', origin]);
  git(candidate, ['init', '-b', 'main']);
  git(candidate, ['config', 'user.name', 'Hex Preflight Test']);
  git(candidate, ['config', 'user.email', 'preflight@example.invalid']);
  fs.appendFileSync(
    path.join(candidate, '.git', 'info', 'exclude'),
    '/.runtime-build/\n/node_modules/\n',
  );
  for (const contract of Object.values(shadowContracts.contracts)) {
    for (const row of contract.cases) copySourcePath(candidate, row.projection.argv[1]);
  }
  write(candidate, 'baseline.txt', 'baseline\n');
  const baseSha = commitAll(candidate, 'baseline');
  git(candidate, ['remote', 'add', 'origin', origin]);
  git(candidate, ['push', '-u', 'origin', 'main']);
  seedImmutablePerformanceSource(origin);
  git(candidate, ['switch', '-c', integrationInventory.integrationRef]);
  seedPreTransitionHandoffFiles(candidate);
  const handoffSha = commitAll(candidate, 'foundation handoffs');
  const handoffTreeSha = git(candidate, ['rev-parse', 'HEAD^{tree}']);

  const tempInventory = structuredClone(integrationInventory);
  tempInventory.baseSha = baseSha;
  bindHandoffsToCommit(tempInventory, handoffSha, handoffTreeSha);
  tempInventory.taskHandoffs.T046 = {
    headSha: handoffSha,
    treeSha: handoffTreeSha,
    evidencePath: 'specs/005-analysis-final-closure/evidence/pre-fanout.md',
  };
  write(
    candidate,
    'specs/005-analysis-final-closure/contracts/integration-inventory.json',
    `${JSON.stringify(tempInventory, null, 2)}\n`,
  );
  commitAll(candidate, 'publish pending handoff inventory');
  for (const repoPath of tempInventory.unionChangedPaths) {
    if (repoPath === 'specs/005-analysis-final-closure/contracts/integration-inventory.json') continue;
    if (repoPath === 'specs/005-analysis-final-closure/tasks.md') {
      write(candidate, repoPath, rewriteTaskStatus(tasksText, 'T046', 'DONE'));
      continue;
    }
    const sourcePath = path.join(SOURCE_ROOT, repoPath);
    const content = fs.existsSync(sourcePath)
      ? fs.readFileSync(sourcePath)
      : Buffer.from(`fixture for ${repoPath}\n`);
    write(candidate, repoPath, content);
  }
  const headSha = commitAll(candidate, 'candidate');
  git(candidate, ['push', '-u', 'origin', integrationInventory.integrationRef]);
  git(candidate, ['push', 'origin', `HEAD:refs/pull/7/head`]);
  return {
    sandbox,
    origin,
    candidate,
    baseSha,
    headSha,
    handoffSha,
    handoffTreeSha,
    inventory: tempInventory,
  };
}

function createStageBOperationalFixture() {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-stage-b-preflight-'));
  const origin = path.join(sandbox, 'origin.git');
  const original = path.join(sandbox, 'original');
  const candidate = path.join(sandbox, 'stage-b');
  fs.mkdirSync(original);
  git(sandbox, ['init', '--bare', origin]);
  git(original, ['init', '-b', 'main']);
  git(original, ['config', 'user.name', 'Hex Preflight Test']);
  git(original, ['config', 'user.email', 'preflight@example.invalid']);
  write(original, 'transcripts/original.txt', 'preserved original transcript\n');
  write(original, 'stage-a-base.txt', 'stage A base\n');
  const stageACandidateBaseSha = commitAll(original, 'stage A base');
  git(original, ['remote', 'add', 'origin', origin]);
  git(original, ['push', '-u', 'origin', 'main']);
  seedImmutablePerformanceSource(origin);
  git(original, ['switch', '-c', integrationInventory.integrationRef]);
  seedPreTransitionHandoffFiles(original);
  const planningSha = commitAll(original, 'planning handoffs');
  const planningTreeSha = git(original, ['rev-parse', 'HEAD^{tree}']);
  git(original, ['push', 'origin', `${planningSha}:${RECOVERY_HANDOFF_REF}`]);
  git(original, [
    'fetch', '--quiet', '--no-tags', '--refmap=', 'origin',
    `+${RECOVERY_HANDOFF_REF}:refs/remotes/origin/wip/recovery-handoff-20260904`,
  ]);

  const stageAInventory = structuredClone(integrationInventory);
  stageAInventory.baseSha = stageACandidateBaseSha;
  bindHandoffsToCommit(stageAInventory, planningSha, planningTreeSha);
  stageAInventory.taskHandoffs.T046 = {
    headSha: planningSha,
    treeSha: planningTreeSha,
    evidencePath: 'specs/005-analysis-final-closure/evidence/pre-fanout.md',
  };
  write(
    original,
    'specs/005-analysis-final-closure/contracts/integration-inventory.json',
    `${JSON.stringify(stageAInventory, null, 2)}\n`,
  );
  commitAll(original, 'publish pending Stage A handoff inventory');
  for (const repoPath of stageAInventory.unionChangedPaths) {
    if (repoPath === 'specs/005-analysis-final-closure/contracts/integration-inventory.json') continue;
    if (repoPath === 'specs/005-analysis-final-closure/tasks.md') {
      write(original, repoPath, rewriteTaskStatus(tasksText, 'T046', 'DONE'));
      continue;
    }
    copySourcePath(original, repoPath);
  }
  write(original, 'specs/005-analysis-final-closure/contracts/integration-inventory.json', `${JSON.stringify(stageAInventory, null, 2)}\n`);
  const stageACandidateHeadSha = commitAll(original, 'stage A candidate');
  const stageACandidateTreeSha = git(original, ['rev-parse', 'HEAD^{tree}']);
  const stageACandidateMergeTreeSha = git(original, [
    'merge-tree', '--write-tree', stageACandidateBaseSha, stageACandidateHeadSha,
  ]).split(/\s+/)[0];
  git(original, ['switch', 'main']);
  git(original, ['merge', '--no-ff', '--no-edit', integrationInventory.integrationRef]);
  const acceptedMergeCommitSha = git(original, ['rev-parse', 'HEAD']);
  const stageAWorktreePath = path.join(sandbox, 'retired-stage-a');
  git(original, ['worktree', 'add', stageAWorktreePath, integrationInventory.integrationRef]);
  const stageAWorktreeIdentity = localStageWorktreeIdentity(stageAWorktreePath);

  const originalIdentity = localWorkspaceIdentity(original);
  const fixturePreFanoutText = replaceEvidenceBlock(
    preFanoutText,
    'final-closure-original-workspace-lock',
    {
      schemaVersion: 'hex-final-closure-original-workspace-lock/v1',
      workspace: {
        path: originalIdentity.realPath,
        gitDirPath: originalIdentity.gitDirPath,
        headSha: originalIdentity.headSha,
        branchRef: originalIdentity.branchRef,
        status: originalIdentity.status,
        dirtyStateSha256: originalIdentity.dirtyStateSha256,
        transcriptsSha256: originalIdentity.transcriptsSha256,
        identity: originalIdentity.identity,
        preserved: true,
      },
    },
  );
  const stageAEvidence = {
    schemaVersion: 'hex-final-closure-stage-a-post-merge-evidence/v1',
    candidate: {
      headSha: stageACandidateHeadSha,
      treeSha: stageACandidateTreeSha,
      baseSha: stageACandidateBaseSha,
      mergeTreeSha: stageACandidateMergeTreeSha,
    },
    acceptedMergeCommitSha,
    refetchedMainSha: acceptedMergeCommitSha,
    smoke: { status: 'PASS', headSha: acceptedMergeCommitSha },
    stageAWorktree: {
      path: stageAWorktreeIdentity.realPath,
      gitDirPath: stageAWorktreeIdentity.gitDirPath,
      headSha: stageAWorktreeIdentity.headSha,
      branchRef: stageAWorktreeIdentity.branchRef,
      status: stageAWorktreeIdentity.status,
      identity: stageAWorktreeIdentity.identity,
    },
    originalWorkspace: {
      path: originalIdentity.realPath,
      gitDirPath: originalIdentity.gitDirPath,
      headSha: originalIdentity.headSha,
      branchRef: originalIdentity.branchRef,
      status: originalIdentity.status,
      dirtyStateSha256: originalIdentity.dirtyStateSha256,
      transcriptsSha256: originalIdentity.transcriptsSha256,
      identity: originalIdentity.identity,
      preserved: true,
    },
    recoveryRef: {
      ref: 'refs/remotes/origin/wip/recovery-handoff-20260904',
      sha: planningSha,
      preserved: true,
    },
  };
  const stageAPostMergeText = evidenceBlock('final-closure-stage-a-post-merge', stageAEvidence);
  write(original, 'specs/005-analysis-final-closure/evidence/stage-a-post-merge.md', stageAPostMergeText);
  write(original, 'specs/005-analysis-final-closure/evidence/pre-fanout.md', fixturePreFanoutText);
  const stageAPostEvidenceSha = commitAll(original, 'record Stage A post-merge evidence');
  const stageAPostEvidenceTreeSha = git(original, ['rev-parse', 'HEAD^{tree}']);

  const stageBaseTasks = rewriteTaskStatus(tasksText, 'T046', 'DONE');
  const stageBaseInventory = structuredClone(stageAInventory);
  const baseSha = stageAPostEvidenceSha;
  git(original, ['push', 'origin', 'main']);

  git(original, ['worktree', 'add', '-b', 'analysis/final-closure-stage-b-test', candidate, baseSha]);

  const stageBPaths = [
    'specs/005-analysis-final-closure/contracts/integration-inventory.json',
    'specs/005-analysis-final-closure/evidence/stage-b-preflight.md',
    'specs/005-analysis-final-closure/tasks.md',
  ];
  const stageBInventory = structuredClone(stageBaseInventory);
  stageBInventory.campaignStage = 'STAGE_B';
  stageBInventory.integrationRef = 'analysis/final-closure-stage-b-test';
  stageBInventory.baseSha = baseSha;
  stageBInventory.checkpoint = {
    schemaVersion: 'hex-final-closure-integration-checkpoint-state/v1',
    sequence: 0,
    state: 'PREFANOUT',
    acceptedTaskId: null,
    evidencePath: 'specs/005-analysis-final-closure/evidence/stage-b-checkpoints.md',
  };
  stageBInventory.expectedChangedPaths = [...stageBPaths];
  stageBInventory.actualChangedPaths = [...stageBPaths];
  stageBInventory.unionChangedPaths = [...stageBPaths];
  stageBInventory.entries = stageBPaths.map((repoPath) => ({ path: repoPath, ownerTaskId: 'T047' }));

  const stageBRealPath = fs.realpathSync(candidate);
  const stageBGitDirPath = fs.realpathSync(git(candidate, ['rev-parse', '--absolute-git-dir']));
  const stageBWorktreeIdentity = stageBLocalReportSha256({
    realPath: stageBRealPath,
    gitDirPath: stageBGitDirPath,
  });
  const localReport = {
    stageBWorktreePath: stageBRealPath,
    stageBGitDirPath,
    stageBWorktreeIdentity,
    integrationBranch: stageBInventory.integrationRef,
    baseSha,
    originalWorkspacePath: originalIdentity.realPath,
    originalWorkspaceIdentity: originalIdentity.identity,
    originalWorkspaceGitDirPath: originalIdentity.gitDirPath,
    originalWorkspaceHeadSha: originalIdentity.headSha,
    originalWorkspaceBranchRef: originalIdentity.branchRef,
    originalWorkspaceStatus: originalIdentity.status,
    originalWorkspaceDirtyStateSha256: originalIdentity.dirtyStateSha256,
    originalWorkspaceTranscriptsSha256: originalIdentity.transcriptsSha256,
    recoveryRef: stageAEvidence.recoveryRef.ref,
    recoveryRefSha: planningSha,
  };
  const stageBEvidence = {
    schemaVersion: 'hex-final-closure-stage-b-preflight-evidence/v1',
    baseSha,
    integrationBranch: stageBInventory.integrationRef,
    worktree: {
      path: stageBRealPath,
      identity: stageBWorktreeIdentity,
      initialHeadSha: baseSha,
      initialStatus: 'CLEAN',
      reused: false,
    },
    originalWorkspace: stageAEvidence.originalWorkspace,
    recoveryRef: stageAEvidence.recoveryRef,
    localVerification: {
      schemaVersion: 'hex-final-closure-stage-b-local-worktree-report/v1',
      status: 'PASS',
      report: localReport,
      reportSha256: stageBLocalReportSha256(localReport),
    },
  };
  const stageBPreflightText = evidenceBlock('final-closure-stage-b-preflight', stageBEvidence);
  const stageBTasks = `${stageBaseTasks}\n<!-- Stage B fixture transition -->\n`;
  write(candidate, stageBPaths[0], `${JSON.stringify(stageBInventory, null, 2)}\n`);
  write(candidate, stageBPaths[1], stageBPreflightText);
  write(candidate, stageBPaths[2], stageBTasks);
  const headSha = commitAll(candidate, 'record Stage B local preflight');
  git(candidate, ['push', '-u', 'origin', stageBInventory.integrationRef]);
  git(candidate, ['branch', 'user-preserved-fixture', planningSha]);
  git(candidate, ['tag', 'user-preserved-fixture', planningSha]);
  git(candidate, ['update-ref', 'refs/remotes/origin/unrelated-preserved-fixture', planningSha]);
  git(original, ['reset', '--hard', acceptedMergeCommitSha]);
  return {
    sandbox,
    origin,
    original,
    candidate,
    baseSha,
    headSha,
    planningSha,
    stageAStaleBranchBaseSha: acceptedMergeCommitSha,
    stageAWorktreePath,
    inventory: stageBInventory,
    tasksText: stageBTasks,
    stageAEvidence,
    stageBEvidence,
    stageAPostMergeText,
    stageBPreflightText,
    preFanoutText: fixturePreFanoutText,
    stageBPaths,
  };
}

function publishSubstitutedT025MatrixFixture(fixture) {
  const matrixPath = 'specs/005-analysis-final-closure/evidence/roadmap-matrix.md';
  const staticFindingByTask = {
    T026: 'HEX-C0-01',
    T027: 'HEX-ME-01',
    T028: 'HEX-C4-03',
    T029: 'HEX-C4-04',
    T030: 'HEX-C4-02',
    T031: 'HEX-C4-05',
    T032: 'HEX-SYM-01',
    T033: 'HEX-SYM-02',
    T034: 'HEX-SYM-03',
    T035: 'HEX-X-03',
    T036: 'HEX-X-02',
  };
  const substitutedFindingIds = new Set(Object.values(staticFindingByTask));
  const initialMatrixText = [
    '| ID | Requirement | Status | Evidence |',
    '|---|---|---|---|',
    ...STAGE_B_ROADMAP_IDS.map((findingId) => `| ${findingId} | fixture | DONE | exact |`),
    '',
  ].join('\n');
  const substitutedMatrixText = [
    '| ID | Requirement | Status | Evidence |',
    '|---|---|---|---|',
    ...STAGE_B_ROADMAP_IDS.map((findingId) => (
      `| ${findingId} | fixture | ${substitutedFindingIds.has(findingId) ? 'PARTIAL' : 'DONE'} | exact |`
    )),
    '',
  ].join('\n');
  const initialMatrixBytes = Buffer.concat([
    Buffer.from(initialMatrixText, 'utf8'),
    Buffer.from([0xff]),
  ]);
  const substitutedMatrixBytes = Buffer.concat([
    Buffer.from(substitutedMatrixText, 'utf8'),
    Buffer.from([0xfe]),
  ]);
  git(fixture.candidate, ['checkout', '--quiet', fixture.inventory.integrationRef]);
  write(fixture.candidate, matrixPath, initialMatrixBytes);
  const t025HeadSha = commitAll(fixture.candidate, 'record T025 matrix A');
  const t025TreeSha = git(fixture.candidate, ['rev-parse', `${t025HeadSha}^{tree}`]);

  let finalTasksText = rewriteTaskStatus(fixture.tasksText, 'T047', 'DONE');
  finalTasksText = rewriteTaskStatus(finalTasksText, 'T025', 'DONE');
  const finalInventory = structuredClone(fixture.inventory);
  for (const field of ['expectedChangedPaths', 'actualChangedPaths', 'unionChangedPaths']) {
    finalInventory[field].push(matrixPath);
  }
  finalInventory.entries.push({ path: matrixPath, ownerTaskId: 'T025' });
  finalInventory.taskHandoffs.T047 = {
    headSha: fixture.headSha,
    treeSha: git(fixture.candidate, ['rev-parse', `${fixture.headSha}^{tree}`]),
    evidencePath: 'specs/005-analysis-final-closure/evidence/stage-b-preflight.md',
  };
  finalInventory.taskHandoffs.T025 = {
    headSha: t025HeadSha,
    treeSha: t025TreeSha,
    evidencePath: matrixPath,
  };
  write(fixture.candidate, 'specs/005-analysis-final-closure/tasks.md', finalTasksText);
  write(
    fixture.candidate,
    'specs/005-analysis-final-closure/contracts/integration-inventory.json',
    `${JSON.stringify(finalInventory, null, 2)}\n`,
  );
  const t025TransitionCommitSha = commitAll(fixture.candidate, 'transition T025 to DONE');

  write(fixture.candidate, matrixPath, substitutedMatrixBytes);
  const substitutedMatrixHeadSha = commitAll(fixture.candidate, 'substitute matrix B after T025');
  const substitutedMatrixTreeSha = git(
    fixture.candidate,
    ['rev-parse', `${substitutedMatrixHeadSha}^{tree}`],
  );

  const findings = STAGE_B_ROADMAP_IDS.map((findingId) => {
    const residual = substitutedFindingIds.has(findingId);
    return {
      findingId,
      status: residual ? 'PARTIAL' : 'DONE',
      durableDisposition: residual ? null : 'COMPLETE_EXISTING',
    };
  });
  const coverage = {
    schemaVersion: STAGE_B_RESIDUAL_COVERAGE_SCHEMA_VERSION,
    campaignStage: 'STAGE_B',
    baseSha: fixture.baseSha,
    source: {
      taskId: 'T025',
      headSha: t025HeadSha,
      treeSha: t025TreeSha,
      evidencePath: matrixPath,
      matrixSha256: createHash('sha256').update(substitutedMatrixBytes).digest('hex'),
    },
    findings,
    tasks: [
      ...Object.entries(staticFindingByTask).map(([taskId, findingId]) => ({
        taskId,
        findingId,
        implementationAction: 'RECONCILE_OWNER',
      })),
      { taskId: 'T045', findingId: null, implementationAction: 'IMPLEMENT' },
    ],
  };
  write(
    fixture.candidate,
    STAGE_B_RESIDUAL_COVERAGE_PATH,
    evidenceBlock(STAGE_B_RESIDUAL_COVERAGE_BLOCK, coverage),
  );
  for (const field of ['expectedChangedPaths', 'actualChangedPaths', 'unionChangedPaths']) {
    finalInventory[field].push(STAGE_B_RESIDUAL_COVERAGE_PATH);
  }
  finalInventory.entries.push({
    path: STAGE_B_RESIDUAL_COVERAGE_PATH,
    ownerTaskId: 'T048',
  });
  write(
    fixture.candidate,
    'specs/005-analysis-final-closure/contracts/integration-inventory.json',
    `${JSON.stringify(finalInventory, null, 2)}\n`,
  );
  const t048HeadSha = commitAll(fixture.candidate, 'record T048 packet over substituted matrix B');
  const t048TreeSha = git(fixture.candidate, ['rev-parse', `${t048HeadSha}^{tree}`]);

  finalTasksText = rewriteTaskStatus(finalTasksText, 'T048', 'DONE');
  for (const taskId of Object.keys(staticFindingByTask)) {
    finalTasksText = rewriteTaskStatus(finalTasksText, taskId, 'BLOCKED_BY_CONCURRENT_WORK');
  }
  finalInventory.taskHandoffs.T048 = {
    headSha: t048HeadSha,
    treeSha: t048TreeSha,
    evidencePath: STAGE_B_RESIDUAL_COVERAGE_PATH,
  };
  write(fixture.candidate, 'specs/005-analysis-final-closure/tasks.md', finalTasksText);
  write(
    fixture.candidate,
    'specs/005-analysis-final-closure/contracts/integration-inventory.json',
    `${JSON.stringify(finalInventory, null, 2)}\n`,
  );
  const finalHeadSha = commitAll(fixture.candidate, 'transition T048 to DONE with substituted matrix');
  git(fixture.candidate, ['push', 'origin', fixture.inventory.integrationRef]);
  return {
    finalHeadSha,
    finalInventory,
    coverage,
    t025TransitionCommitSha,
    substitutedMatrixHeadSha,
    substitutedMatrixTreeSha,
  };
}

function createComponentFixture() {
  const fixture = createOperationalFixture();
  const integrationTasks = rewriteTaskStatus(tasksText, 'T046', 'DONE');
  const integrationInventoryFixture = structuredClone(fixture.inventory);
  const integrationHeadSha = fixture.headSha;

  const componentRef = 'component/final-closure-t011-stack-return';
  git(fixture.candidate, ['switch', '-c', componentRef]);
  const componentPath = 'tests/final-closure/t011/component-candidate.test.mjs';
  write(fixture.candidate, componentPath, 'import assert from "node:assert/strict"; assert.ok(true);\n');
  const componentHeadSha = commitAll(fixture.candidate, 'T011 component');
  git(fixture.candidate, ['push', '-u', 'origin', componentRef]);
  git(fixture.candidate, ['push', 'origin', 'HEAD:refs/pull/11/head']);
  git(fixture.candidate, ['switch', fixture.inventory.integrationRef]);
  const eventPath = path.join(fixture.sandbox, 'component-event.json');
  return {
    ...fixture,
    integrationTasks,
    integrationInventory: integrationInventoryFixture,
    integrationHeadSha,
    componentRef,
    componentPath,
    componentHeadSha,
    eventPath,
  };
}

function componentEnvironment(fixture, {
  number = 11,
  headSha = fixture.componentHeadSha,
  headRef = fixture.componentRef,
  baseSha = fixture.integrationHeadSha,
  baseRef = fixture.integrationInventory.integrationRef,
} = {}) {
  fs.writeFileSync(fixture.eventPath, JSON.stringify({
    number,
    pull_request: {
      head: { sha: headSha, ref: headRef },
      base: { sha: baseSha, ref: baseRef },
    },
  }));
  return {
    GITHUB_ACTIONS: 'true',
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_EVENT_PATH: fixture.eventPath,
  };
}

function createAndPublishComponentBranch(fixture, {
  branchRef,
  startSha,
  relativePath,
  content,
  pullRequestNumber,
}) {
  git(fixture.candidate, ['checkout', '--quiet', '-b', branchRef, startSha]);
  write(fixture.candidate, relativePath, content);
  const headSha = commitAll(fixture.candidate, branchRef);
  git(fixture.candidate, ['push', '-u', 'origin', branchRef]);
  git(fixture.candidate, ['push', 'origin', `HEAD:refs/pull/${pullRequestNumber}/head`]);
  git(fixture.candidate, ['checkout', '--quiet', '--detach', fixture.integrationHeadSha]);
  return headSha;
}

const invalidUtf8Inventory = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-invalid-utf8-inventory-'));
try {
  git(invalidUtf8Inventory, ['init', '-b', 'main']);
  git(invalidUtf8Inventory, ['config', 'user.name', 'Hex Preflight Test']);
  git(invalidUtf8Inventory, ['config', 'user.email', 'preflight@example.invalid']);
  write(invalidUtf8Inventory, 'base.txt', 'base\n');
  const baseSha = commitAll(invalidUtf8Inventory, 'base');
  const invalidPath = Buffer.concat([
    Buffer.from(`${invalidUtf8Inventory}/invalid-`, 'utf8'),
    Buffer.from([0xff]),
  ]);
  fs.writeFileSync(invalidPath, 'invalid path bytes\n');
  const headSha = commitAll(invalidUtf8Inventory, 'invalid utf8 path');
  assert.throws(
    () => changedPaths(invalidUtf8Inventory, baseSha, headSha),
    /git-diff-path-not-utf8/,
    'a lossy UTF-8 replacement character cannot become an exact ownership inventory path',
  );
} finally {
  fs.rmSync(invalidUtf8Inventory, { recursive: true, force: true });
}

const bomPathInventory = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-bom-path-inventory-'));
try {
  git(bomPathInventory, ['init', '-b', 'main']);
  git(bomPathInventory, ['config', 'user.name', 'Hex Preflight Test']);
  git(bomPathInventory, ['config', 'user.email', 'preflight@example.invalid']);
  write(bomPathInventory, 'base.txt', 'base\n');
  const baseSha = commitAll(bomPathInventory, 'base');
  write(bomPathInventory, '\ufefftests/final-closure/t011/spoof.test.mjs', 'spoof\n');
  const headSha = commitAll(bomPathInventory, 'BOM-prefixed path');
  assert.throws(
    () => changedPaths(bomPathInventory, baseSha, headSha),
    /git-diff-path-not-canonical/,
    'a leading UTF-8 BOM cannot be stripped into an allowlisted path',
  );
} finally {
  fs.rmSync(bomPathInventory, { recursive: true, force: true });
}

assert.deepEqual(
  assertOnlyAllowedRefChanges(
    { 'refs/heads/main': 'a'.repeat(40), 'refs/tags/preserved': 'b'.repeat(40) },
    { 'refs/heads/main': 'c'.repeat(40), 'refs/tags/preserved': 'b'.repeat(40) },
    ['refs/heads/main'],
  ).changedRefs,
  ['refs/heads/main'],
  'a fetch transaction may update only its exact destination ref',
);
for (const [label, before, after] of [
  ['addition', {}, { 'refs/heads/unrelated': 'a'.repeat(40) }],
  ['deletion', { 'refs/tags/unrelated': 'a'.repeat(40) }, {}],
  ['update', { 'refs/remotes/origin/unrelated': 'a'.repeat(40) }, { 'refs/remotes/origin/unrelated': 'b'.repeat(40) }],
  ['stash addition', {}, { 'refs/stash': 'a'.repeat(40) }],
  ['notes update', { 'refs/notes/review': 'a'.repeat(40) }, { 'refs/notes/review': 'b'.repeat(40) }],
  ['custom deletion', { 'refs/hex/custom': 'a'.repeat(40) }, {}],
]) {
  assert.throws(
    () => assertOnlyAllowedRefChanges(before, after, []),
    /git-fetch-unexpected-ref-mutation/,
    `an unrelated persistent ref ${label} must fail closed`,
  );
}

const operational = createOperationalFixture();
try {
  for (const refName of ['refs/stash', 'refs/notes/review', 'refs/hex/custom']) {
    git(operational.candidate, ['update-ref', refName, operational.headSha]);
  }
  const allRefs = persistentRefSnapshot(operational.candidate);
  assert.equal(allRefs['refs/stash'], operational.headSha);
  assert.equal(allRefs['refs/notes/review'], operational.headSha);
  assert.equal(allRefs['refs/hex/custom'], operational.headSha);
  for (const refName of ['refs/stash', 'refs/notes/review', 'refs/hex/custom']) {
    git(operational.candidate, ['update-ref', '-d', refName]);
  }
  const runLocalPreflight = (overrides = {}) => runPreflight({
    root: operational.candidate,
    expectedSha: operational.headSha,
    expectedBaseSha: operational.baseSha,
    environment: {},
    ...overrides,
  });
  assert.throws(
    () => runLocalPreflight({ expectedSha: shaA }),
    /exact-head-mismatch/,
    'the operational gate must reject a non-candidate head before accepting evidence',
  );
  const report = runLocalPreflight();
  assert.equal(report.verdict, 'PREFLIGHT_GREEN');
  assert.equal(report.headSha, operational.headSha);
  assert.equal(report.baseSha, operational.baseSha);
  assert.equal(report.mergeBaseSha, operational.baseSha);
  assert.equal(report.mergeTreeSha, report.treeSha);
  assert.equal(
    report.taskHandoffIdentity.canonicalT046TransitionCommitSha,
    operational.headSha,
    'the operational fixture must preserve the immutable T046 seal after the source ledger is DONE',
  );
  assert.match(report.verifierIdentity.sha256, /^[0-9a-f]{64}$/);
  assert.equal(report.corpusIdentity.denominatorStableDigest, FROZEN_PLATFORM_IDENTITIES.denominator);
  assert.equal(report.runtimeIdentity.requiredClassIds.length, 2);
  assert.match(report.toolchainIdentity.git, /^git version /);
  assert.equal(report.actualInventoryPathCount, integrationInventory.unionChangedPaths.length);

  const eventPath = path.join(operational.sandbox, 'pull-request-event.json');
  fs.writeFileSync(eventPath, JSON.stringify({
    number: 7,
    pull_request: {
      head: { sha: operational.headSha, ref: operational.inventory.integrationRef },
      base: { sha: operational.baseSha, ref: 'main' },
    },
  }));
  const githubEnvironment = {
    GITHUB_ACTIONS: 'true',
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_EVENT_PATH: eventPath,
  };
  const eventReport = runPreflight({ root: operational.candidate, environment: githubEnvironment });
  assert.equal(eventReport.invocationIdentity.headSha, operational.headSha);
  assert.equal(eventReport.invocationIdentity.baseSha, operational.baseSha);
  assert.throws(
    () => runPreflight({ root: operational.candidate, expectedSha: shaA, environment: githubEnvironment }),
    /github-event-head-argument-mismatch/,
    'workflow arguments cannot replace the GitHub event head authority',
  );
  fs.writeFileSync(eventPath, JSON.stringify({
    inputs: {
      expect_sha: operational.headSha,
      expect_base_sha: operational.baseSha,
    },
  }));
  const dispatchEnvironment = { ...githubEnvironment, GITHUB_EVENT_NAME: 'workflow_dispatch' };
  const dispatchReport = runPreflight({ root: operational.candidate, environment: dispatchEnvironment });
  assert.equal(dispatchReport.invocationIdentity.eventName, 'workflow_dispatch');
  fs.writeFileSync(eventPath, JSON.stringify({
    inputs: {
      expect_sha: 'not-a-sha',
      expect_base_sha: operational.baseSha,
    },
  }));
  assert.throws(
    () => runPreflight({ root: operational.candidate, environment: dispatchEnvironment }),
    /github-event-head-sha-invalid/,
    'manual dispatch must reject malformed event identities',
  );

  write(operational.candidate, 'untracked-applicable.js', 'untracked\n');
  assert.throws(
    () => runLocalPreflight(),
    /preflight-worktree-not-clean/,
  );
  fs.unlinkSync(path.join(operational.candidate, 'untracked-applicable.js'));

  const verifierPath = 'tools/validation/final-closure/preflight.mjs';
  const pristineVerifier = fs.readFileSync(path.join(operational.candidate, verifierPath));
  fs.appendFileSync(path.join(operational.candidate, verifierPath), '\n// dirty\n');
  assert.throws(
    () => runLocalPreflight(),
    /preflight-worktree-not-clean/,
  );
  write(operational.candidate, verifierPath, pristineVerifier);

  fs.appendFileSync(path.join(operational.candidate, verifierPath), '\n// staged\n');
  git(operational.candidate, ['add', verifierPath]);
  assert.throws(
    () => runLocalPreflight(),
    /preflight-worktree-not-clean/,
  );
  git(operational.candidate, ['restore', '--staged', '--worktree', verifierPath]);

  const operationalContract = (inventoryOverride) => validate({
    tasksText: rewriteTaskStatus(tasksText, 'T046', 'DONE'),
    integrationInventory: inventoryOverride,
    actualChangedPaths: inventoryOverride.unionChangedPaths,
    expectedBaseSha: operational.baseSha,
  });
  const validHandoffs = operationalContract(operational.inventory);
  assert.equal(validHandoffs.ok, true, validHandoffs.errors.join('\n'));
  assert.equal(
    verifyTaskHandoffs(operational.candidate, validHandoffs, operational.headSha).taskCount,
    11,
  );

  const missingHandoffHeadInventory = structuredClone(operational.inventory);
  missingHandoffHeadInventory.taskHandoffs.T001.headSha = 'f'.repeat(40);
  const missingHandoffHead = operationalContract(missingHandoffHeadInventory);
  assert.throws(
    () => verifyTaskHandoffs(operational.candidate, missingHandoffHead, operational.headSha),
    /task-handoff-head-missing:T001/,
    'a DONE-task handoff head must resolve',
  );

  const wrongHandoffTreeInventory = structuredClone(operational.inventory);
  wrongHandoffTreeInventory.taskHandoffs.T001.treeSha = 'f'.repeat(40);
  const wrongHandoffTree = operationalContract(wrongHandoffTreeInventory);
  assert.throws(
    () => verifyTaskHandoffs(operational.candidate, wrongHandoffTree, operational.headSha),
    /task-handoff-tree-mismatch:T001/,
    'a DONE-task handoff tree must match its exact head',
  );

  git(operational.candidate, ['fetch', SOURCE_ROOT, 'd7eb37dd3c5b4842f127a74183547e64bef2be9f']);
  const staleHandoffInventory = structuredClone(operational.inventory);
  staleHandoffInventory.taskHandoffs.T001 = {
    headSha: 'd7eb37dd3c5b4842f127a74183547e64bef2be9f',
    treeSha: '3233b538f984befbecf091aaf2eeb4dbcea10707',
    evidencePath: 'specs/005-analysis-final-closure/research.md',
  };
  const staleHandoff = operationalContract(staleHandoffInventory);
  assert.throws(
    () => verifyTaskHandoffs(operational.candidate, staleHandoff, operational.headSha),
    /task-handoff-head-stale:T001/,
    'a resolved handoff from an unrelated history is not authority',
  );

  git(operational.candidate, ['push', 'origin', '--delete', 'wip/recovered-sym01-20260904']);
  assert.throws(
    () => runLocalPreflight(),
    /performance-source-fetch-failed/,
    'the immutable P-SYM01 source ref must exist in origin',
  );
  restoreImmutablePerformanceSource(operational.origin);
  git(operational.candidate, [
    'push', '--force', 'origin', `${operational.baseSha}:${IMMUTABLE_SYM01_REF}`,
  ]);
  assert.throws(
    () => runLocalPreflight(),
    /performance-source-ref-mismatch/,
    'the immutable P-SYM01 source ref cannot resolve to a different commit',
  );
  restoreImmutablePerformanceSource(operational.origin);

  const advance = path.join(operational.sandbox, 'advance');
  git(operational.sandbox, ['clone', '--branch', 'main', operational.origin, advance]);
  git(advance, ['config', 'user.name', 'Hex Preflight Test']);
  git(advance, ['config', 'user.email', 'preflight@example.invalid']);
  write(advance, 'moving-main.txt', 'advanced\n');
  git(advance, ['add', 'moving-main.txt']);
  git(advance, ['commit', '-m', 'advance main']);
  const advancedBaseSha = git(advance, ['rev-parse', 'HEAD']);
  git(advance, ['push', 'origin', 'main']);
  assert.equal(git(operational.candidate, ['rev-parse', 'HEAD']), operational.headSha, 'candidate head remains unchanged');
  assert.throws(
    () => runLocalPreflight(),
    /exact-base-mismatch/,
    'the same candidate head must be invalidated when live main advances',
  );
  assert.throws(
    () => runLocalPreflight({ expectedBaseSha: advancedBaseSha }),
    /candidate-does-not-contain-current-main/,
    'accepting the advanced base identity still cannot substitute for reconciling the candidate tree',
  );
} finally {
  fs.rmSync(operational.sandbox, { recursive: true, force: true });
}

const componentOperational = createComponentFixture();
try {
  const environment = componentEnvironment(componentOperational);
  const prepared = prepareComponentCandidate({ root: componentOperational.candidate, environment });
  assert.equal(prepared.taskId, 'T011');
  assert.equal(prepared.baseSha, componentOperational.integrationHeadSha);
  assert.equal(prepared.componentHeadSha, componentOperational.componentHeadSha);
  const report = runPreflight({ root: componentOperational.candidate, environment });
  assert.equal(report.mode, 'COMPONENT_CANDIDATE');
  assert.equal(report.componentTaskId, 'T011');
  const componentExpectedPaths = [componentOperational.componentPath];
  assert.deepEqual(report.componentActualChangedPaths, componentExpectedPaths);
  assert.deepEqual(report.componentCandidateChangedPaths, componentExpectedPaths);
  assert.equal(report.componentInventoryDigest, stableDigest(componentExpectedPaths));

  const gateCalls = [];
  const gateReport = runComponentGates({
    root: componentOperational.candidate,
    environment,
    spawn(command, argv, options) {
      gateCalls.push({ command, argv, options });
      return passingShadowProviderResult(command, argv);
    },
  });
  const expectedGateCount = ownership.candidateGates.tasks.T011.owned.length
    + ownership.candidateGates.tasks.T011.rolling.length
    + (2 * ownership.candidateGates.tasks.T011.shadow.length);
  assert.equal(gateReport.verdict, 'COMPONENT_GATES_GREEN');
  assert.equal(gateCalls.length, expectedGateCount);
  assert.ok(gateCalls.every((call) => call.options.shell === false));
  assert.ok(gateCalls.every((call) => call.options.cwd === componentOperational.candidate));
  const expectedGateKinds = ['owned', 'rolling', 'shadow']
    .flatMap((kind) => ownership.candidateGates.tasks.T011[kind].map(() => kind));
  assert.deepEqual(gateReport.results.map(({ kind }) => kind), expectedGateKinds);
  assert.deepEqual(
    gateCalls.filter((call) => String(call.argv[0]).includes('shadow/foundation/'))
      .map((call) => call.argv[0]),
    [
      'tools/validation/final-closure/shadow/foundation/oracle-observer.mjs',
      'tools/validation/final-closure/shadow/foundation/product-observer.mjs',
    ],
    'the central verifier must execute independently pinned oracle and exact-product observers',
  );
  assert.deepEqual(gateReport.results.find((row) => row.kind === 'shadow').candidateIdentity, {
    headSha: report.headSha,
    treeSha: report.treeSha,
  });

  assert.throws(
    () => runComponentGates({
      root: componentOperational.candidate,
      environment,
      spawn(command, argv) {
        if (!String(argv?.[0] || '').includes('shadow/foundation/')) return { status: 0, stdout: '' };
        return {
          status: 0,
          stdout: `${JSON.stringify({
            verdict: 'PASS',
            hashes: { oracle: 'equal', product: 'equal' },
            counters: [],
          })}\n`,
        };
      },
    }),
    /shadow-raw-observation-invalid/,
    'a fabricated PASS/equal report is not a raw observation and cannot become shadow evidence',
  );
  assert.throws(
    () => runComponentGates({
      root: componentOperational.candidate,
      environment,
      spawn(command, argv) {
        if (String(argv?.[0] || '').endsWith('product-observer.mjs')) {
          return { status: 7, stdout: '' };
        }
        return passingShadowProviderResult(command, argv);
      },
    }),
    /shadow-product-process-failed:T011:7/,
    'both provider processes are mandatory',
  );
  const safeUnknownEvidence = emitShadowGateEvidence({
    root: componentOperational.candidate,
    taskId: 'T011',
    expectedSha: report.headSha,
    expectedTree: report.treeSha,
    authoritySha: componentOperational.integrationHeadSha,
    spawn(command, argv) {
      if (!String(argv?.[0] || '').includes('shadow/foundation/')) return { status: 0, stdout: '' };
      const taskId = argv[argv.indexOf('--task') + 1];
      const gateId = argv[argv.indexOf('--gate') + 1];
      const state = String(argv[0]).endsWith('product-observer.mjs') ? 'UNKNOWN' : 'OBSERVED';
      return { status: 0, stdout: `${JSON.stringify(shadowRawObservation(taskId, gateId, state))}\n` };
    },
  });
  assert.equal(safeUnknownEvidence.proof.results[0].disposition, 'SAFE_UNKNOWN');
  assert.equal(safeUnknownEvidence.proof.verdict, 'PASS');
  assert.equal(safeUnknownEvidence.authorityCommitSha, componentOperational.integrationHeadSha);
  assert.ok(safeUnknownEvidence.authorityOwnershipArtifact.sha256);
  assert.equal(safeUnknownEvidence.judgeArtifacts.length, 1);
  assert.equal(
    safeUnknownEvidence.proof.counters.find((row) => row.id === 'semanticMismatch').denominator,
    1,
  );
  assert.equal(
    safeUnknownEvidence.proof.counters.find((row) => row.id === 'falseExactType').denominator,
    0,
    'a counter denominator includes only cases explicitly tagged for that counter',
  );
  assert.throws(
    () => emitShadowGateEvidence({
      root: componentOperational.candidate,
      taskId: 'T011',
      expectedSha: report.headSha,
      expectedTree: report.treeSha,
      authoritySha: report.headSha,
      spawn: passingShadowProviderResult,
    }),
    /shadow-authority-not-direct-parent/,
    'a candidate cannot designate itself as its independent authority',
  );
  assert.throws(
    () => emitShadowGateEvidence({
      root: componentOperational.candidate,
      taskId: 'T011',
      expectedSha: report.headSha,
      expectedTree: report.treeSha,
      authoritySha: componentOperational.integrationHeadSha,
      spawn() { return { status: 0, stdout: '{"ok":true}\n' }; },
    }),
    /shadow-raw-observation-invalid/,
    'providers cannot submit verdict, hash, counter, or arbitrary report fields',
  );
  const t011JudgePath = shadowContracts.contracts[shadowRegistry.tasks.T011.contractId]
    .cases[0].projection.argv[1];
  git(componentOperational.candidate, [
    'switch',
    '-c',
    'component-judge-drift',
    componentOperational.integrationHeadSha,
  ]);
  fs.appendFileSync(path.join(componentOperational.candidate, t011JudgePath), '// candidate drift\n');
  const judgeDriftHead = commitAll(componentOperational.candidate, 'candidate-only judge drift');
  const judgeDriftTree = git(componentOperational.candidate, ['rev-parse', 'HEAD^{tree}']);
  assert.throws(
    () => emitShadowGateEvidence({
      root: componentOperational.candidate,
      taskId: 'T011',
      expectedSha: judgeDriftHead,
      expectedTree: judgeDriftTree,
      authoritySha: componentOperational.integrationHeadSha,
      spawn: passingShadowProviderResult,
    }),
    /shadow-product-judge-drift:T011/,
    'a candidate-only mutation of the fixed product judge is rejected before observation',
  );
  git(componentOperational.candidate, ['checkout', '--quiet', '--detach', report.headSha]);
  git(componentOperational.candidate, ['branch', '-D', 'component-judge-drift']);

  let dirtiedCandidate = false;
  assert.throws(
    () => runComponentGates({
      root: componentOperational.candidate,
      environment,
      spawn(command, argv) {
        if (!dirtiedCandidate) {
          dirtiedCandidate = true;
          fs.appendFileSync(
            path.join(componentOperational.candidate, componentOperational.componentPath),
            '// gate mutation\n',
          );
        }
        return passingShadowProviderResult(command, argv);
      },
    }),
    /component-gate-worktree-dirty:T011/,
    'a green gate may not mutate the synthetic candidate worktree',
  );
  git(componentOperational.candidate, ['restore', '--worktree', componentOperational.componentPath]);

  let mutatedIgnoredRuntime = false;
  assert.throws(
    () => runComponentGates({
      root: componentOperational.candidate,
      environment,
      spawn() {
        if (!mutatedIgnoredRuntime) {
          mutatedIgnoredRuntime = true;
          write(componentOperational.candidate, '.runtime-build/hidden-input.bin', 'mutated\n');
        }
        return { status: 0, stdout: '' };
      },
    }),
    /component-gate-ephemeral-mutated:T011/,
    'a green component gate cannot mutate an ignored runtime root',
  );
  fs.rmSync(path.join(componentOperational.candidate, '.runtime-build'), {
    recursive: true,
    force: true,
  });

  let mutatedDependencyBytes = false;
  assert.throws(
    () => runComponentGates({
      root: componentOperational.candidate,
      environment,
      spawn() {
        if (!mutatedDependencyBytes) {
          mutatedDependencyBytes = true;
          write(componentOperational.candidate, 'node_modules/.fixture-package', 'mutated\n');
        }
        return { status: 0, stdout: '' };
      },
    }),
    /component-gate-ephemeral-mutated:T011/,
    'a green component gate cannot mutate ignored dependency bytes',
  );
  fs.rmSync(path.join(componentOperational.candidate, 'node_modules'), {
    recursive: true,
    force: true,
  });

  let mutatedPersistentRef = false;
  assert.throws(
    () => runComponentGates({
      root: componentOperational.candidate,
      environment,
      spawn() {
        if (!mutatedPersistentRef) {
          mutatedPersistentRef = true;
          git(componentOperational.candidate, [
            'update-ref', 'refs/heads/gate-mutation-fixture', report.headSha,
          ]);
        }
        return { status: 0, stdout: '' };
      },
    }),
    /git-fetch-unexpected-ref-mutation:refs\/heads\/gate-mutation-fixture/,
    'a gate cannot mutate an unrelated persistent ref while reporting success',
  );
  git(componentOperational.candidate, ['update-ref', '-d', 'refs/heads/gate-mutation-fixture']);

  let movedCandidate = false;
  assert.throws(
    () => runComponentGates({
      root: componentOperational.candidate,
      environment,
      spawn(command, argv) {
        if (!movedCandidate) {
          movedCandidate = true;
          git(componentOperational.candidate, [
            'checkout', '--quiet', '--detach', componentOperational.integrationHeadSha,
          ]);
        }
        return passingShadowProviderResult(command, argv);
      },
    }),
    /component-gate-head-mismatch:T011/,
    'a green gate may not replace the exact synthetic candidate HEAD',
  );
  git(componentOperational.candidate, ['checkout', '--quiet', '--detach', prepared.candidateCommitSha]);

  const wrongTaskRef = 'component/final-closure-t012-wrong-task';
  const wrongTaskHead = createAndPublishComponentBranch(componentOperational, {
    branchRef: wrongTaskRef,
    startSha: componentOperational.integrationHeadSha,
    relativePath: 'tests/final-closure/t011/wrong-task.test.mjs',
    content: 'throw new Error("not executed");\n',
    pullRequestNumber: 12,
  });
  const wrongTaskEnvironment = componentEnvironment(componentOperational, {
    number: 12,
    headSha: wrongTaskHead,
    headRef: wrongTaskRef,
  });
  prepareComponentCandidate({ root: componentOperational.candidate, environment: wrongTaskEnvironment });
  assert.throws(
    () => runPreflight({ root: componentOperational.candidate, environment: wrongTaskEnvironment }),
    /component-inventory-invalid:[\s\S]*inventory-path-outside-allowlist:T012/,
    'the TNNN parsed from the component ref is the only lane authority',
  );

  const outOfLaneRef = 'component/final-closure-t011-out-of-lane';
  const outOfLaneHead = createAndPublishComponentBranch(componentOperational, {
    branchRef: outOfLaneRef,
    startSha: componentOperational.integrationHeadSha,
    relativePath: 'docs/component-escape.md',
    content: 'outside T011\n',
    pullRequestNumber: 13,
  });
  const outOfLaneEnvironment = componentEnvironment(componentOperational, {
    number: 13,
    headSha: outOfLaneHead,
    headRef: outOfLaneRef,
  });
  prepareComponentCandidate({ root: componentOperational.candidate, environment: outOfLaneEnvironment });
  assert.throws(
    () => runPreflight({ root: componentOperational.candidate, environment: outOfLaneEnvironment }),
    /inventory-path-outside-allowlist:T011:docs\/component-escape\.md/,
    'component candidate paths outside the exact task allowlist must fail',
  );

  git(componentOperational.candidate, [
    'push', 'origin', `${componentOperational.integrationHeadSha}:refs/heads/analysis/final-closure-sibling`,
  ]);
  git(componentOperational.candidate, ['checkout', '--quiet', '--detach', componentOperational.integrationHeadSha]);
  const siblingBaseEnvironment = componentEnvironment(componentOperational, {
    baseRef: 'analysis/final-closure-sibling',
  });
  prepareComponentCandidate({ root: componentOperational.candidate, environment: siblingBaseEnvironment });
  assert.throws(
    () => runPreflight({ root: componentOperational.candidate, environment: siblingBaseEnvironment }),
    /component-integration-ref-mismatch/,
    'a sibling integration ref at the same SHA is still the wrong authority',
  );

  git(componentOperational.candidate, ['checkout', '--quiet', '--detach', componentOperational.integrationHeadSha]);
  const spoofedEnvironment = componentEnvironment(componentOperational, { headSha: 'a'.repeat(40) });
  assert.throws(
    () => prepareComponentCandidate({ root: componentOperational.candidate, environment: spoofedEnvironment }),
    /github-event-head-ref-sha-mismatch/,
    'event JSON cannot spoof the fetched pull-request head ref',
  );

  const conflictRef = 'component/final-closure-t011-conflict';
  const conflictHead = createAndPublishComponentBranch(componentOperational, {
    branchRef: conflictRef,
    startSha: componentOperational.baseSha,
    relativePath: 'specs/005-analysis-final-closure/tasks.md',
    content: 'component-side conflicting task ledger\n',
    pullRequestNumber: 14,
  });
  const conflictEnvironment = componentEnvironment(componentOperational, {
    number: 14,
    headSha: conflictHead,
    headRef: conflictRef,
  });
  assert.throws(
    () => prepareComponentCandidate({ root: componentOperational.candidate, environment: conflictEnvironment }),
    /candidate-merge-tree-conflict/,
    'a conflicted candidate tree must never be constructed or tested',
  );
} finally {
  fs.rmSync(componentOperational.sandbox, { recursive: true, force: true });
}

const staleForkComponent = createComponentFixture();
try {
  write(
    staleForkComponent.candidate,
    'specs/005-analysis-final-closure/tasks.md',
    `${staleForkComponent.integrationTasks}\n<!-- rolling integration advanced -->\n`,
  );
  const advancedIntegrationHeadSha = commitAll(
    staleForkComponent.candidate,
    'advance living integration after component fork',
  );
  git(staleForkComponent.candidate, ['push', 'origin', staleForkComponent.integrationInventory.integrationRef]);
  const staleForkEnvironment = componentEnvironment(staleForkComponent, {
    baseSha: advancedIntegrationHeadSha,
  });
  const prepared = prepareComponentCandidate({
    root: staleForkComponent.candidate,
    environment: staleForkEnvironment,
  });
  const report = runPreflight({
    root: staleForkComponent.candidate,
    environment: staleForkEnvironment,
  });
  assert.equal(prepared.componentHeadSha, staleForkComponent.componentHeadSha);
  assert.deepEqual(report.componentActualChangedPaths, [staleForkComponent.componentPath]);
  assert.deepEqual(report.componentCandidateChangedPaths, [staleForkComponent.componentPath]);

  git(staleForkComponent.candidate, ['checkout', '--quiet', '--detach', advancedIntegrationHeadSha]);
  write(
    staleForkComponent.candidate,
    'specs/005-analysis-final-closure/evidence/pre-fanout.md',
    `${preFanoutText}\n<!-- unauthorized post-handoff mutation -->\n`,
  );
  const mutatedIntegrationHeadSha = commitAll(
    staleForkComponent.candidate,
    'mutate a completed owner path',
  );
  git(staleForkComponent.candidate, [
    'push', 'origin', `HEAD:${staleForkComponent.integrationInventory.integrationRef}`,
  ]);
  const mutatedBaseEnvironment = componentEnvironment(staleForkComponent, {
    baseSha: mutatedIntegrationHeadSha,
  });
  prepareComponentCandidate({
    root: staleForkComponent.candidate,
    environment: mutatedBaseEnvironment,
  });
  assert.throws(
    () => runPreflight({
      root: staleForkComponent.candidate,
      environment: mutatedBaseEnvironment,
    }),
    /task-handoff-owned-path-changed:T046:specs\/005-analysis-final-closure\/evidence\/pre-fanout\.md/,
    'a completed owner cannot co-edit its frozen contract after its handoff',
  );

  git(staleForkComponent.candidate, ['checkout', '--quiet', '--detach', mutatedIntegrationHeadSha]);
  const rewrittenAnchorInventory = JSON.parse(fs.readFileSync(
    path.join(
      staleForkComponent.candidate,
      'specs/005-analysis-final-closure/contracts/integration-inventory.json',
    ),
    'utf8',
  ));
  rewrittenAnchorInventory.taskHandoffs.T046 = {
    headSha: mutatedIntegrationHeadSha,
    treeSha: git(staleForkComponent.candidate, ['rev-parse', `${mutatedIntegrationHeadSha}^{tree}`]),
    evidencePath: 'specs/005-analysis-final-closure/evidence/pre-fanout.md',
  };
  write(
    staleForkComponent.candidate,
    'specs/005-analysis-final-closure/contracts/integration-inventory.json',
    `${JSON.stringify(rewrittenAnchorInventory, null, 2)}\n`,
  );
  const rewrittenAnchorHeadSha = commitAll(
    staleForkComponent.candidate,
    'attempt to rewrite the frozen T046 handoff anchor',
  );
  git(staleForkComponent.candidate, [
    'push', 'origin', `HEAD:${staleForkComponent.integrationInventory.integrationRef}`,
  ]);
  const rewrittenAnchorEnvironment = componentEnvironment(staleForkComponent, {
    baseSha: rewrittenAnchorHeadSha,
  });
  prepareComponentCandidate({
    root: staleForkComponent.candidate,
    environment: rewrittenAnchorEnvironment,
  });
  assert.throws(
    () => runPreflight({
      root: staleForkComponent.candidate,
      environment: rewrittenAnchorEnvironment,
    }),
    /task-handoff-canonical-mismatch:T046/,
    'co-editing the mutable inventory cannot move T046 beyond its first DONE transition anchor',
  );
} finally {
  fs.rmSync(staleForkComponent.sandbox, { recursive: true, force: true });
}

const stageBOperational = createStageBOperationalFixture();
try {
  const validateStageBFixture = (overrides = {}) => validatePreflightContracts({
    tasksText: stageBOperational.tasksText,
    ownership,
    integrationInventory: stageBOperational.inventory,
    platformLocks,
    performanceLocks,
    workflowText,
    preFanoutText: stageBOperational.preFanoutText,
    stageAPostMergeText: stageBOperational.stageAPostMergeText,
    stageBPreflightText: stageBOperational.stageBPreflightText,
    actualChangedPaths: stageBOperational.stageBPaths,
    expectedBaseSha: stageBOperational.baseSha,
    ...overrides,
  });
  const validStageB = validateStageBFixture();
  assert.equal(validStageB.ok, true, validStageB.errors.join('\n'));
  assert.ok(
    validStageB.checkpointResult.remainingComponentTaskIds.includes('T045'),
    'the physical-iPad evidence implementation lane must receive a Stage B T050 checkpoint',
  );

  const preFanoutComponentRef = 'component/final-closure-t026-before-fanout';
  git(stageBOperational.candidate, [
    'checkout', '--quiet', '-b', preFanoutComponentRef, stageBOperational.headSha,
  ]);
  write(
    stageBOperational.candidate,
    'tests/final-closure/t026/pre-fanout.test.mjs',
    'import assert from "node:assert/strict"; assert.ok(true);\n',
  );
  const preFanoutComponentHeadSha = commitAll(
    stageBOperational.candidate,
    'attempt Stage B component before T048',
  );
  git(stageBOperational.candidate, ['push', '-u', 'origin', preFanoutComponentRef]);
  git(stageBOperational.candidate, ['push', 'origin', 'HEAD:refs/pull/26/head']);
  git(stageBOperational.candidate, [
    'checkout', '--quiet', stageBOperational.inventory.integrationRef,
  ]);
  const preFanoutEventPath = path.join(stageBOperational.sandbox, 'pre-fanout-component-event.json');
  const preFanoutEnvironment = componentEnvironment({
    ...stageBOperational,
    componentHeadSha: preFanoutComponentHeadSha,
    componentRef: preFanoutComponentRef,
    integrationHeadSha: stageBOperational.headSha,
    integrationInventory: stageBOperational.inventory,
    eventPath: preFanoutEventPath,
  }, { number: 26 });
  prepareComponentCandidate({
    root: stageBOperational.candidate,
    environment: preFanoutEnvironment,
  });
  assert.throws(
    () => runPreflight({
      root: stageBOperational.candidate,
      environment: preFanoutEnvironment,
    }),
    /component-stage-b-fanout-not-green:T026/,
    'no Stage B component may start while T048 is still pending',
  );
  git(stageBOperational.candidate, [
    'checkout', '--quiet', stageBOperational.inventory.integrationRef,
  ]);

  const expandedInitialInventory = structuredClone(stageBOperational.inventory);
  const unauthorizedInitialPath = 'specs/005-analysis-final-closure/evidence/extra-stage-b-initial.md';
  for (const field of ['expectedChangedPaths', 'actualChangedPaths', 'unionChangedPaths']) {
    expandedInitialInventory[field].push(unauthorizedInitialPath);
  }
  expandedInitialInventory.entries.push({ path: unauthorizedInitialPath, ownerTaskId: 'T047' });
  assertIncludes(
    validateStageBFixture({
      integrationInventory: expandedInitialInventory,
      actualChangedPaths: [...stageBOperational.stageBPaths, unauthorizedInitialPath],
    }).errors,
    'stage-b-initial-inventory-path-set-invalid',
    'T047 must publish exactly the fixed three-path Stage B PREFANOUT inventory',
  );

  assertIncludes(
    validateStageBFixture({ stageAPostMergeText: null }).errors,
    'stage-evidence-block-missing',
    'Stage B must fail closed when fixed Stage A evidence is missing',
  );
  assertIncludes(
    validateStageBFixture({
      stageBPreflightText: '# malformed\n```json final-closure-stage-b-preflight\n{\n```\n',
    }).errors,
    'stage-evidence-json-malformed',
    'malformed Stage B JSON evidence must fail closed',
  );
  const mismatchedStageBEvidence = structuredClone(stageBOperational.stageBEvidence);
  mismatchedStageBEvidence.baseSha = stageBOperational.planningSha;
  assertIncludes(
    validateStageBFixture({
      stageBPreflightText: evidenceBlock('final-closure-stage-b-preflight', mismatchedStageBEvidence),
    }).errors,
    'stage-b-base-binding-mismatch',
    'Stage B evidence must bind the exact current inventory base',
  );
  const reusedStageBEvidence = structuredClone(stageBOperational.stageBEvidence);
  reusedStageBEvidence.worktree.reused = true;
  reusedStageBEvidence.worktree.path = stageBOperational.stageAEvidence.stageAWorktree.path;
  assertIncludes(
    validateStageBFixture({
      stageBPreflightText: evidenceBlock('final-closure-stage-b-preflight', reusedStageBEvidence),
    }).errors,
    'stage-b-worktree-reused',
    'a reused Stage A worktree cannot become the Stage B living integration worktree',
  );

  const refsBeforeStageBVerification = persistentRefSnapshot(stageBOperational.candidate);
  const report = runPreflight({
    root: stageBOperational.candidate,
    expectedSha: stageBOperational.headSha,
    expectedBaseSha: stageBOperational.baseSha,
    environment: {},
  });
  assert.equal(report.verdict, 'PREFLIGHT_GREEN');
  assert.equal(report.baseSha, stageBOperational.baseSha);
  assert.equal(report.actualInventoryPathCount, 3);
  assert.equal(report.stageTransitionIdentity.stageBBaseSha, stageBOperational.baseSha);
  const refsAfterStageBVerification = persistentRefSnapshot(stageBOperational.candidate);
  for (const refName of [
    'refs/heads/user-preserved-fixture',
    'refs/remotes/origin/unrelated-preserved-fixture',
    'refs/remotes/origin/wip/recovery-handoff-20260904',
    'refs/tags/user-preserved-fixture',
  ]) {
    assert.equal(
      refsAfterStageBVerification[refName],
      refsBeforeStageBVerification[refName],
      `${refName} remains byte-for-byte unchanged by Stage B authority fetches`,
    );
  }
  assert.equal(
    refsAfterStageBVerification['refs/remotes/origin/__final_closure_recovery_handoff'],
    stageBOperational.planningSha,
    'recovery authority is fetched only into the dedicated scratch ref',
  );

  const recoveryMover = path.join(stageBOperational.sandbox, 'recovery-mover');
  git(stageBOperational.sandbox, ['clone', '--quiet', stageBOperational.origin, recoveryMover]);
  git(recoveryMover, ['config', 'user.name', 'Hex Preflight Test']);
  git(recoveryMover, ['config', 'user.email', 'preflight@example.invalid']);
  git(recoveryMover, [
    'checkout', '--quiet', '-b', 'moved-recovery-fixture', stageBOperational.planningSha,
  ]);
  write(recoveryMover, 'moved-recovery.txt', 'moved recovery ref\n');
  const movedRecoverySha = commitAll(recoveryMover, 'move recovery authority fixture');
  git(recoveryMover, [
    'push', '--force', 'origin', `${movedRecoverySha}:${RECOVERY_HANDOFF_REF}`,
  ]);
  assert.throws(
    () => verifyStageBOperationalEvidence(
      stageBOperational.candidate,
      validStageB.stageEvidence,
      stageBOperational.baseSha,
    ),
    /stage-b-recovery-ref-sha-mismatch/,
    'a moved remote recovery branch fails without rewriting its canonical local tracking evidence',
  );
  assert.equal(
    persistentRefSnapshot(stageBOperational.candidate)['refs/remotes/origin/wip/recovery-handoff-20260904'],
    stageBOperational.planningSha,
    'a failed recovery authority fetch leaves the canonical tracking ref untouched',
  );
  git(recoveryMover, [
    'push', '--force', 'origin', `${stageBOperational.planningSha}:${RECOVERY_HANDOFF_REF}`,
  ]);

  const wrongCandidateTreeEvidence = structuredClone(validStageB.stageEvidence);
  wrongCandidateTreeEvidence.stageA.candidate.treeSha = stageBOperational.planningSha;
  assert.throws(
    () => verifyStageBOperationalEvidence(
      stageBOperational.candidate,
      wrongCandidateTreeEvidence,
      stageBOperational.baseSha,
    ),
    /stage-a-candidate-tree-mismatch/,
    'Stage A candidate tree evidence must resolve exactly',
  );

  const substitutedAcceptedMerge = structuredClone(validStageB.stageEvidence);
  substitutedAcceptedMerge.stageA.acceptedMergeCommitSha = stageBOperational.baseSha;
  substitutedAcceptedMerge.stageA.refetchedMainSha = stageBOperational.baseSha;
  substitutedAcceptedMerge.stageA.smoke.headSha = stageBOperational.baseSha;
  assert.throws(
    () => verifyStageBOperationalEvidence(
      stageBOperational.candidate,
      substitutedAcceptedMerge,
      stageBOperational.baseSha,
    ),
    /stage-a-accepted-merge-(?:parents|tree)-mismatch/,
    'a later descendant containing unreviewed changes cannot substitute for the exact accepted merge product',
  );

  git(stageBOperational.original, [
    'switch', '-c', 'stale-refetched-main', stageBOperational.stageAStaleBranchBaseSha,
  ]);
  write(stageBOperational.original, 'stale-only.txt', 'not on Stage B base\n');
  const staleRefetchedMainSha = commitAll(stageBOperational.original, 'stale alternate refetched main');
  git(stageBOperational.original, ['switch', 'main']);
  const staleStageAEvidence = structuredClone(validStageB.stageEvidence);
  staleStageAEvidence.stageA.refetchedMainSha = staleRefetchedMainSha;
  staleStageAEvidence.stageA.smoke.headSha = staleRefetchedMainSha;
  assert.throws(
    () => verifyStageBOperationalEvidence(
      stageBOperational.candidate,
      staleStageAEvidence,
      stageBOperational.baseSha,
    ),
    /stage-a-refetched-main-stale/,
    'Stage A refetched main may be an ancestor, but not a stale side branch',
  );

  const localReport = verifyLocalStageBWorktree({
    root: stageBOperational.candidate,
    originalWorkspaceRoot: stageBOperational.original,
  });
  assert.equal(localReport.status, 'PASS');
  write(stageBOperational.stageAWorktreePath, 'stage-a-base.txt', 'mutated retired Stage A worktree\n');
  assert.throws(
    () => verifyLocalStageBWorktree({
      root: stageBOperational.candidate,
      originalWorkspaceRoot: stageBOperational.original,
    }),
    /local-stage-b-stage-a-worktree-mismatch/,
    'the Stage A worktree recorded at cutover must remain exact and read-only during Stage B',
  );
  git(stageBOperational.stageAWorktreePath, ['restore', '--worktree', 'stage-a-base.txt']);
  write(stageBOperational.original, 'stage-a-base.txt', 'mutated tracked original workspace\n');
  assert.throws(
    () => verifyLocalStageBWorktree({
      root: stageBOperational.candidate,
      originalWorkspaceRoot: stageBOperational.original,
    }),
    /local-stage-b-original-workspace-mismatch/,
    'a tracked original-workspace edit must invalidate preservation proof',
  );
  write(stageBOperational.original, 'stage-a-base.txt', 'stage A base\n');
  write(stageBOperational.original, 'unrelated-original-state.txt', 'untracked mutation\n');
  assert.throws(
    () => verifyLocalStageBWorktree({
      root: stageBOperational.candidate,
      originalWorkspaceRoot: stageBOperational.original,
    }),
    /local-stage-b-original-workspace-mismatch/,
    'an unrelated untracked original-workspace edit must invalidate preservation proof',
  );
  fs.unlinkSync(path.join(stageBOperational.original, 'unrelated-original-state.txt'));
  write(stageBOperational.candidate, 'dirty-stage-b.txt', 'dirty\n');
  assert.throws(
    () => verifyLocalStageBWorktree({
      root: stageBOperational.candidate,
      originalWorkspaceRoot: stageBOperational.original,
    }),
    /local-stage-b-worktree-dirty/,
    'the actual Stage B worktree must be clean',
  );
  fs.unlinkSync(path.join(stageBOperational.candidate, 'dirty-stage-b.txt'));

  git(stageBOperational.candidate, ['branch', '-m', 'analysis/final-closure-wrong-actual']);
  assert.throws(
    () => verifyLocalStageBWorktree({
      root: stageBOperational.candidate,
      originalWorkspaceRoot: stageBOperational.original,
    }),
    /local-stage-b-branch-mismatch/,
    'the actual Stage B branch must equal the recorded integration ref',
  );
  git(stageBOperational.candidate, ['branch', '-m', stageBOperational.inventory.integrationRef]);

  const stageBAdvance = path.join(stageBOperational.sandbox, 'stage-b-main-advance');
  git(stageBOperational.sandbox, ['clone', '--branch', 'main', stageBOperational.origin, stageBAdvance]);
  git(stageBAdvance, ['config', 'user.name', 'Hex Preflight Test']);
  git(stageBAdvance, ['config', 'user.email', 'preflight@example.invalid']);
  write(stageBAdvance, 'later-main.txt', 'later main\n');
  commitAll(stageBAdvance, 'advance Stage B main');
  git(stageBAdvance, ['push', 'origin', 'main']);
  assert.throws(
    () => verifyLocalStageBWorktree({
      root: stageBOperational.candidate,
      originalWorkspaceRoot: stageBOperational.original,
    }),
    /local-stage-b-base-mismatch/,
    'the actual Stage B base must still equal refetched main',
  );
} finally {
  fs.rmSync(stageBOperational.sandbox, { recursive: true, force: true });
}

const substitutedT025Operational = createStageBOperationalFixture();
try {
  const attack = publishSubstitutedT025MatrixFixture(substitutedT025Operational);
  assert.throws(
    () => runPreflight({
      root: substitutedT025Operational.candidate,
      expectedSha: attack.finalHeadSha,
      expectedBaseSha: substitutedT025Operational.baseSha,
      environment: {},
    }),
    /stage-b-residual-coverage-source-invalid/,
    'canonical preflight must hash the raw T025 handoff blob and reject a later matrix plus recomputed packet',
  );

  const rewrittenCoverage = structuredClone(attack.coverage);
  rewrittenCoverage.source.headSha = attack.substitutedMatrixHeadSha;
  rewrittenCoverage.source.treeSha = attack.substitutedMatrixTreeSha;
  const rewrittenInventory = structuredClone(attack.finalInventory);
  rewrittenInventory.taskHandoffs.T025 = {
    headSha: attack.substitutedMatrixHeadSha,
    treeSha: attack.substitutedMatrixTreeSha,
    evidencePath: 'specs/005-analysis-final-closure/evidence/roadmap-matrix.md',
  };
  write(
    substitutedT025Operational.candidate,
    STAGE_B_RESIDUAL_COVERAGE_PATH,
    evidenceBlock(STAGE_B_RESIDUAL_COVERAGE_BLOCK, rewrittenCoverage),
  );
  write(
    substitutedT025Operational.candidate,
    'specs/005-analysis-final-closure/contracts/integration-inventory.json',
    `${JSON.stringify(rewrittenInventory, null, 2)}\n`,
  );
  const rewrittenHandoffHeadSha = commitAll(
    substitutedT025Operational.candidate,
    'coordinate substituted matrix and rewritten T025 handoff',
  );
  git(substitutedT025Operational.candidate, [
    'push', 'origin', substitutedT025Operational.inventory.integrationRef,
  ]);
  const rewrittenHandoffResult = {
    taskHandoffResult: {
      handoffs: rewrittenInventory.taskHandoffs,
      completedTaskIds: ['T025'],
      inventoryEntries: rewrittenInventory.entries,
    },
  };
  assert.throws(
    () => verifyTaskHandoffs(
      substitutedT025Operational.candidate,
      rewrittenHandoffResult,
      rewrittenHandoffHeadSha,
    ),
    /task-handoff-canonical-mismatch:T025/,
    'the operational handoff verifier rejects a later matrix-bearing ancestor even when every current hash agrees',
  );

  const rewrittenTreeSha = git(substitutedT025Operational.candidate, [
    'rev-parse', `${rewrittenHandoffHeadSha}^{tree}`,
  ]);
  const reversedParentMergeSha = git(substitutedT025Operational.candidate, [
    'commit-tree', rewrittenTreeSha,
    '-p', substitutedT025Operational.headSha,
    '-p', rewrittenHandoffHeadSha,
    '-m', 'attempt reversed-parent T025 re-anchor',
  ]);
  const canonicalAnchor = canonicalTaskHandoffAnchor(
    substitutedT025Operational.candidate,
    reversedParentMergeSha,
    'T025',
  );
  assert.equal(
    canonicalAnchor.transitionCommitSha,
    attack.t025TransitionCommitSha,
    'the unique full-DAG transition remains canonical when a pre-T025 parent is placed first',
  );
  assert.throws(
    () => verifyTaskHandoffs(
      substitutedT025Operational.candidate,
      rewrittenHandoffResult,
      reversedParentMergeSha,
    ),
    /task-handoff-canonical-mismatch:T025/,
    'a reversed-parent merge cannot hide the original T025 DONE transition',
  );
} finally {
  fs.rmSync(substitutedT025Operational.sandbox, { recursive: true, force: true });
}

console.log('final closure preflight regression: PASS');
