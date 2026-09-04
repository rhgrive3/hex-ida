import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';

import { stableDigest } from '../../../js/core/identity/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PREFLIGHT_SCHEMA_VERSION = 'hex-final-closure-preflight-evidence/v1';
const INTEGRATION_INVENTORY_SCHEMA_VERSION = 'hex-final-closure-integration-inventory/v1';
const PERFORMANCE_LOCK_SCHEMA_VERSION = 'hex-final-closure-performance-locks/v1';
const STAGE_A_EVIDENCE_SCHEMA_VERSION = 'hex-final-closure-stage-a-post-merge-evidence/v1';
const STAGE_B_EVIDENCE_SCHEMA_VERSION = 'hex-final-closure-stage-b-preflight-evidence/v1';
const ORIGINAL_WORKSPACE_LOCK_SCHEMA_VERSION = 'hex-final-closure-original-workspace-lock/v1';
const STAGE_A_EVIDENCE_BLOCK = 'final-closure-stage-a-post-merge';
const STAGE_B_EVIDENCE_BLOCK = 'final-closure-stage-b-preflight';
export const STAGE_B_RESIDUAL_COVERAGE_PATH = 'specs/005-analysis-final-closure/evidence/stage-b-residual-coverage.md';
export const STAGE_B_RESIDUAL_COVERAGE_BLOCK = 'final-closure-stage-b-residual-coverage';
export const STAGE_B_RESIDUAL_COVERAGE_SCHEMA_VERSION = 'hex-final-closure-stage-b-residual-coverage/v1';
const ORIGINAL_WORKSPACE_LOCK_BLOCK = 'final-closure-original-workspace-lock';
const CHECKPOINT_LEDGER_SCHEMA_VERSION = 'hex-final-closure-integration-checkpoint-ledger/v1';
const CHECKPOINT_STATE_SCHEMA_VERSION = 'hex-final-closure-integration-checkpoint-state/v1';
const MAIN_RECONCILIATION_SCHEMA_VERSION = 'hex-final-closure-main-reconciliation/v1';
const PRODUCT_RECONCILIATION_SCHEMA_VERSION = 'hex-final-closure-product-reconciliation/v1';
const SHADOW_GATE_EVIDENCE_SCHEMA_VERSION = 'hex-final-closure-shadow-gate-evidence/v1';
const SHADOW_POLICY_SCHEMA_VERSION = 'hex-final-closure-shadow-policy/v2';
const SHADOW_PROOF_SCHEMA_VERSION = 'hex-final-closure-shadow-proof/v2';
const SHADOW_RAW_OBSERVATION_SCHEMA_VERSION = 'hex-final-closure-shadow-raw-observation/v1';
const SHADOW_AUTHORITY_REGISTRY_SCHEMA_VERSION = 'hex-final-closure-shadow-authority-registry/v1';
const SHADOW_CONTRACTS_SCHEMA_VERSION = 'hex-final-closure-shadow-contracts/v1';
const SHADOW_CONTRACT_SCHEMA_VERSION = 'hex-final-closure-shadow-contract/v1';
const SHADOW_COMPARISON_ALGORITHM = 'canonical-observation-equality-safe-unknown/v1';
const SHADOW_AUTHORITY_ARTIFACTS = Object.freeze([
  Object.freeze({ role: 'registry', path: 'tools/validation/final-closure/shadow/foundation/registry.json' }),
  Object.freeze({ role: 'contracts', path: 'tools/validation/final-closure/shadow/foundation/contracts.json' }),
  Object.freeze({ role: 'oracleProvider', path: 'tools/validation/final-closure/shadow/foundation/oracle-observer.mjs' }),
  Object.freeze({ role: 'productProvider', path: 'tools/validation/final-closure/shadow/foundation/product-observer.mjs' }),
]);
const CHECKPOINT_BLOCKS = Object.freeze({
  STAGE_A: 'final-closure-stage-a-checkpoints',
  STAGE_B: 'final-closure-stage-b-checkpoints',
});
const CHECKPOINT_PATHS = Object.freeze({
  STAGE_A: 'specs/005-analysis-final-closure/evidence/stage-a-checkpoints.md',
  STAGE_B: 'specs/005-analysis-final-closure/evidence/stage-b-checkpoints.md',
});
const CHECKPOINT_OWNER_TASK_IDS = Object.freeze({ STAGE_A: 'T049', STAGE_B: 'T050' });
const CHECKPOINT_GENERATED_PATHS = Object.freeze([
  'js/userscript/deployment-identity.generated.js',
  'userscript/hex.user.template.js',
  'userscript/release-version.json',
]);
const MAIN_RECONCILIATION_ALLOWED_PATHS = Object.freeze([
  'specs/005-analysis-final-closure/contracts/integration-inventory.json',
]);
const CHECKPOINT_PRODUCT_PUBLICATION_PATHS = Object.freeze([
  'specs/005-analysis-final-closure/contracts/integration-inventory.json',
  'specs/005-analysis-final-closure/evidence/stage-a-checkpoints.md',
  'specs/005-analysis-final-closure/evidence/stage-b-checkpoints.md',
  'specs/005-analysis-final-closure/tasks.md',
]);
const CHECKPOINT_RUNTIME_EPHEMERAL_ROOTS = Object.freeze([
  '.runtime-build',
  'dist',
  'node_modules',
]);
const ROLLING_GATE_OUTPUT_LIMIT_BYTES = 64 * 1024;
const CHECKPOINT_EVIDENCE_ALLOWED_PATHS = Object.freeze({
  STAGE_A: Object.freeze([
    'specs/005-analysis-final-closure/contracts/integration-inventory.json',
    'specs/005-analysis-final-closure/evidence/stage-a-checkpoints.md',
    'specs/005-analysis-final-closure/tasks.md',
  ]),
  STAGE_B: Object.freeze([
    'specs/005-analysis-final-closure/contracts/integration-inventory.json',
    'specs/005-analysis-final-closure/evidence/stage-b-checkpoints.md',
    'specs/005-analysis-final-closure/tasks.md',
  ]),
});
const STAGE_B_INITIAL_INVENTORY_PATHS = Object.freeze([
  'specs/005-analysis-final-closure/contracts/integration-inventory.json',
  'specs/005-analysis-final-closure/evidence/stage-b-preflight.md',
  'specs/005-analysis-final-closure/tasks.md',
]);
const RECOVERY_HANDOFF_CANONICAL_REMOTE_REF = 'refs/remotes/origin/wip/recovery-handoff-20260904';
const RECOVERY_HANDOFF_SCRATCH_REMOTE_REF = 'refs/remotes/origin/__final_closure_recovery_handoff';
const RECOVERY_HANDOFF_FETCH_REF = 'refs/heads/wip/recovery-handoff-20260904';
const FOUNDATION_TASK_COUNT = 50;
const EXPECTED_WORKFLOW_SHA256 = 'c97e38e552f5b10bb2c7967697950cf7f4e2a93d0029ac47e790e43435c506d4';
const INITIAL_COMPONENT_TASK_IDS = Object.freeze([
  'T011', 'T012', 'T013', 'T014', 'T015', 'T016', 'T017',
  'T026', 'T027', 'T028', 'T029', 'T030', 'T031', 'T032', 'T033', 'T034', 'T035', 'T036',
  'T045',
]);
const STAGE_B_FOUNDATION_COMPONENT_TASK_IDS = Object.freeze([
  'T026', 'T027', 'T028', 'T029', 'T030', 'T031',
  'T032', 'T033', 'T034', 'T035', 'T036', 'T045',
]);
export const STAGE_B_ROADMAP_IDS = Object.freeze([
  'HEX-C0-01', 'HEX-C1-01', 'HEX-C1-02', 'HEX-C1-03',
  'HEX-C2-01', 'HEX-C2-02', 'HEX-C3-01', 'HEX-C3-02', 'HEX-C3-03',
  'HEX-C4-01', 'HEX-C4-02', 'HEX-C4-03', 'HEX-C4-04', 'HEX-C4-05',
  'HEX-ME-01', 'HEX-S2-01', 'HEX-S2-02',
  'HEX-SYM-01', 'HEX-SYM-02', 'HEX-SYM-03',
  'HEX-X-01', 'HEX-X-02', 'HEX-X-03',
]);
const STAGE_B_STATIC_FINDING_BY_TASK = Object.freeze({
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
});
const STAGE_B_ROADMAP_STATUSES = Object.freeze([
  'DONE', 'PARTIAL', 'REMAINING', 'REPLACED', 'OBSOLETE', 'BLOCKED',
]);
const STAGE_B_IMPLEMENTATION_ACTIONS = Object.freeze([
  'IMPLEMENT', 'NO_EDIT', 'NO_EDIT_EXTERNAL_BLOCK', 'RECONCILE_OWNER',
]);
export const FROZEN_INITIAL_CANDIDATE_GATE_DIGEST = 'b59ca991fe4ea6c3ee31b5d9bdd3c9da';

export const EXPECTED_TASK_IDS = Object.freeze(
  Array.from({ length: FOUNDATION_TASK_COUNT }, (_, index) => `T${String(index + 1).padStart(3, '0')}`),
);

export const EVIDENCE_IDENTITY_FIELDS = Object.freeze([
  'headSha',
  'treeSha',
  'baseSha',
  'mergeTreeSha',
  'verifierIdentity',
  'corpusIdentity',
  'toolchainIdentity',
  'runtimeIdentity',
  'deploymentIdentity',
  'generatedArtifactIdentity',
  'invocationIdentity',
]);

export const EXPECTED_WORKLOAD_IDS = Object.freeze([
  'H9-INITIAL-OPEN-METADATA',
  'H9-PAGED-BYTE-ACCESS',
  'H9-FIRST-DECODE-WINDOW',
  'H9-DISTANT-NAVIGATION',
  'H9-ACTIVE-FUNCTION-SEMANTIC-PIPELINE',
  'H9-FUNCTION-DISCOVERY-FIRST-USEFUL',
  'H9-DECOMPILER-FIRST-USEFUL',
  'H9-END-TO-END-TTFUA',
  'H9-PROJECT-SAVE-WARM-REOPEN',
  'H9-WORKER-CANCELLATION-SETTLEMENT',
  'H9-LARGE-LOGICAL-SOURCE-NO-WHOLE-READ',
  'H9-PATTERN-RULE-EVALUATION',
  'H9-REBUILD-VALIDATE-PUBLISH',
  'H9-VIRTUALIZED-RENDERING',
]);

export const EXPECTED_EP_IDS = Object.freeze(
  Array.from({ length: 30 }, (_, index) => `EP-${String(index + 1).padStart(3, '0')}`),
);

const HARD_CORRECTNESS_COUNTER_IDS = Object.freeze([
  'falseExactNoAlias',
  'falseExactMustAlias',
  'falseExactIndirectTarget',
  'falseExactType',
  'semanticMismatch',
  'stalePublicationAfterCancel',
  'invalidWriterOutputAccepted',
]);

export const FROZEN_PLATFORM_IDENTITIES = Object.freeze({
  full: '061e04604a125a02517d63f52eb0fe5f',
  denominator: '5eb21622743caca345805e4c9f10bf64',
  fixtureDescriptor: 'e067fd51b10aca57ae5bffa6c8ef75da',
  runtimeClasses: '780ab5840ddd8befac1f461fe8b602ac',
  identityRequirements: '6322b05fe8658745c240a34ee4005b54',
  rowPolicy: '0f2fc60890868d32aebae1afd72d2c99',
  measurementProtocol: '17dabc6ea5fe33f46328bda82a12503b',
  workloadIds: 'b0a628becc84e266dc225ce71376619d',
  workloads: 'a2243079f2e70c1f1165448db5c35d2e',
});

export const FROZEN_PERFORMANCE_IDENTITIES = Object.freeze({
  full: '5f6437ff6cf554cc42eecfc269849049',
  profiles: Object.freeze({
    'P-SYM01': 'eddf6f3251d888acf8c68d0e8202a3f9',
    'P-EGRAPH': '0facdf501dbf704f05c3be7c347bf08e',
    'P-SYMMEM': '04d96b6051125f46e828f02d380e745b',
    'P-TAINT': '9ee4dcb32c17ed4742229e168845ffea',
  }),
  thresholds: '909f9e80460068c37cf4bdb796faf00c',
  sources: '750b59ecc3d34d6d54e691d8f2396dde',
});

export const FROZEN_FOUNDATION_OWNERSHIP_DIGEST = 'c9d9b506bed51ced06476323bbc0bd1e';

const REQUIRED_TASK_FIELDS = Object.freeze([
  'Objective:',
  'Current evidence:',
  'Owner/model:',
  'Risk:',
  'Dependencies:',
  'Owned paths:',
  'Delta:',
  'Negative counterexample:',
  'Tests:',
  'Integration test:',
  'Completion evidence:',
  'Status:',
]);

const SPECIAL_OWNERSHIP_RULES = Object.freeze({
  T011: ['tests/phase8/performance/**', 'T017 MachineEffects'],
  T012: ['tests/phase8/performance/**', 'T011 decompiler'],
  T013: ['T011 stack-return', 'T012 hostile semantic-identity', 'performance threshold'],
  T017: ['operand-forwarding.js', 'second MachineEffects', '#3425'],
  T020: ['SOL Ultra acting as integration owner'],
  T041: ['SOL Ultra acting as integration owner'],
  T045: ['duplicate ByteSource', 'T040 exact-final evidence'],
  T046: ['.github/workflows/final-closure-preflight.yml', 'PREFLIGHT_GREEN', 'walking-skeleton.test.mjs'],
  T047: ['one new clean Stage B branch/worktree', 'pre-merge main base'],
  T048: ['tasks.md', 'stage-b-residual-coverage.md', 'STAGE_B_FANOUT_GREEN'],
});

const REQUIRED_RUNTIME_CLASSES = Object.freeze([
  'production-faithful-webkit-v1',
  'physical-ipad-supported-floor-v1',
]);

function exactSet(values, expected) {
  if (!Array.isArray(values) || !Array.isArray(expected)
    || values.some((value) => typeof value !== 'string')
    || expected.some((value) => typeof value !== 'string')) return false;
  const actual = [...new Set(values)].sort();
  const wanted = [...expected].sort();
  return actual.length === values.length
    && actual.length === wanted.length
    && actual.every((value, index) => value === wanted[index]);
}

function taskBlocks(tasksText) {
  return String(tasksText || '')
    .split(/(?=^- \[[ x]\] T\d{3}\b)/m)
    .filter((block) => /^- \[[ x]\] T\d{3}\b/m.test(block));
}

function occurrenceCount(text, token) {
  let count = 0;
  let offset = 0;
  while ((offset = text.indexOf(token, offset)) !== -1) {
    count += 1;
    offset += token.length;
  }
  return count;
}

function taskContractErrors(block, taskId) {
  const errors = [];
  const contractLines = block.split('\n').filter((line) => line.startsWith('  - **Contract** — '));
  if (contractLines.length !== 1) {
    errors.push(`task-contract-line-count:${taskId}:${contractLines.length}`);
    return errors;
  }
  const contractLine = contractLines[0];
  if (!contractLine.startsWith('  - **Contract** — Objective:')) {
    errors.push(`task-contract-prefix-invalid:${taskId}`);
  }
  const positions = [];
  for (const field of REQUIRED_TASK_FIELDS) {
    const count = occurrenceCount(contractLine, field);
    if (count !== 1) errors.push(`task-field-count:${taskId}:${field}:${count}`);
    positions.push(contractLine.indexOf(field));
  }
  if (positions.some((position) => position < 0)) return errors;
  for (let index = 1; index < positions.length; index += 1) {
    if (positions[index] <= positions[index - 1]) {
      errors.push(`task-field-order:${taskId}:${REQUIRED_TASK_FIELDS[index]}`);
    } else if (contractLine.slice(positions[index] - 2, positions[index]) !== '. ') {
      errors.push(`task-field-boundary:${taskId}:${REQUIRED_TASK_FIELDS[index]}`);
    }
  }
  if (errors.some((error) => error.startsWith(`task-field-count:${taskId}:`)
    || error.startsWith(`task-field-order:${taskId}:`))) return errors;

  const values = new Map();
  for (let index = 0; index < REQUIRED_TASK_FIELDS.length; index += 1) {
    const field = REQUIRED_TASK_FIELDS[index];
    const start = positions[index] + field.length;
    const end = positions[index + 1] ?? contractLine.length;
    const value = contractLine.slice(start, end).trim().replace(/\.$/, '').trim();
    values.set(field, value);
    if (!value) errors.push(`task-field-value-empty:${taskId}:${field}`);
  }

  const checked = new RegExp(`^- \\[x\\] ${taskId}\\b`, 'm').test(block);
  const status = values.get('Status:');
  if (!['DONE', 'PENDING', 'BLOCKED_BY_CONCURRENT_WORK'].includes(status)) {
    errors.push(`task-status-invalid:${taskId}:${String(status)}`);
  }
  if ((checked && status !== 'DONE') || (!checked && status === 'DONE')) {
    errors.push(`task-checkbox-status-mismatch:${taskId}:${checked ? 'checked' : 'open'}:${String(status)}`);
  }
  return errors;
}

function overlapContains(ownership, taskId, fragment) {
  return ownership?.tasks?.[taskId]?.forbiddenOverlap
    ?.some((entry) => String(entry).includes(fragment)) === true;
}

function validRepoPath(value) {
  if (typeof value !== 'string' || value.trim() !== value || value === '') return false;
  if (/[\u0000-\u001f\u007f\ufeff]/.test(value)) return false;
  if (value.includes('\\') || value.startsWith('/') || value.endsWith('/')) return false;
  const segments = value.split('/');
  return !segments.some((segment) => segment === '' || segment === '.' || segment === '..');
}

function validAllowPattern(value) {
  if (!validRepoPath(value)) return false;
  if (!value.includes('*')) return true;
  if (!value.endsWith('/**')) return false;
  const prefix = value.slice(0, -3);
  return prefix.includes('/') && !prefix.includes('*') && validRepoPath(prefix);
}

function patternRegExp(pattern) {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '*' && pattern[index + 1] === '*') {
      source += '.*';
      index += 1;
    } else if (character === '*') {
      source += '[^/]*';
    } else {
      source += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

function pathAllowed(repoPath, patterns) {
  return patterns.some((pattern) => patternRegExp(pattern).test(repoPath));
}

function patternsOverlap(left, right) {
  if (!validAllowPattern(left) || !validAllowPattern(right)) return true;
  const leftPrefix = left.endsWith('/**') ? left.slice(0, -3) : null;
  const rightPrefix = right.endsWith('/**') ? right.slice(0, -3) : null;
  if (leftPrefix != null && rightPrefix != null) {
    return leftPrefix === rightPrefix
      || leftPrefix.startsWith(`${rightPrefix}/`)
      || rightPrefix.startsWith(`${leftPrefix}/`);
  }
  if (leftPrefix != null) return right.startsWith(`${leftPrefix}/`);
  if (rightPrefix != null) return left.startsWith(`${rightPrefix}/`);
  return left === right;
}

function dependencyMap(blocks) {
  const availableTaskIds = blocks
    .map((block) => block.match(/^- \[[ x]\] (T\d{3})\b/m)?.[1])
    .filter(Boolean);
  return new Map(blocks.map((block) => {
    const taskId = block.match(/^- \[[ x]\] (T\d{3})\b/m)?.[1];
    const dependencyText = block.match(/Dependencies:\s*([\s\S]*?)\.\s+Owned paths:/)?.[1] || '';
    const dependencies = new Set([...dependencyText.matchAll(/T\d{3}(?!\+)/g)].map((match) => match[0]));
    for (const match of dependencyText.matchAll(/T(\d{3})-T?(\d{3})/g)) {
      const first = Number(match[1]);
      const last = Number(match[2]);
      for (let number = first; number <= last; number += 1) {
        dependencies.add(`T${String(number).padStart(3, '0')}`);
      }
    }
    for (const match of dependencyText.matchAll(/T(\d{3})\+/g)) {
      const first = Number(match[1]);
      for (const candidateId of availableTaskIds) {
        if (Number(candidateId.slice(1)) >= first) dependencies.add(candidateId);
      }
    }
    return [taskId, [...dependencies]];
  }));
}

function taskStatusMap(blocks) {
  return new Map(blocks.map((block) => {
    const taskId = block.match(/^- \[[ x]\] (T\d{3})\b/m)?.[1];
    const contractLines = block.split('\n')
      .filter((line) => line.startsWith('  - **Contract** — '));
    const status = contractLines.length === 1
      ? contractLines[0].match(/\. Status:\s*([A-Z_]+)\.\s*$/)?.[1] || null
      : null;
    return [taskId, status];
  }));
}

function transitivelyDepends(taskId, dependencyId, dependencies, seen = new Set()) {
  if (seen.has(taskId)) return false;
  seen.add(taskId);
  for (const direct of dependencies.get(taskId) || []) {
    if (direct === dependencyId || transitivelyDepends(direct, dependencyId, dependencies, seen)) return true;
  }
  return false;
}

function dependencyErrors(blocks, taskIds) {
  const errors = [];
  const dependencies = dependencyMap(blocks);
  const statuses = taskStatusMap(blocks);
  for (const [taskId, directDependencies] of dependencies) {
    for (const dependencyId of directDependencies) {
      if (!taskIds.includes(dependencyId)) errors.push(`tasks-dependency-unknown:${taskId}:${dependencyId}`);
      if (dependencyId === taskId) errors.push(`tasks-dependency-self:${taskId}`);
      if (statuses.get(taskId) === 'DONE'
        && taskIds.includes(dependencyId)
        && statuses.get(dependencyId) !== 'DONE') {
        errors.push(`tasks-done-dependency-not-done:${taskId}:${dependencyId}:${statuses.get(dependencyId) || 'UNKNOWN'}`);
      }
    }
  }

  const state = new Map();
  const stack = [];
  const visit = (taskId) => {
    const current = state.get(taskId);
    if (current === 'done') return;
    if (current === 'visiting') {
      const cycleStart = stack.indexOf(taskId);
      const cycle = [...stack.slice(cycleStart), taskId];
      errors.push(`tasks-dependency-cycle:${cycle.join('>')}`);
      return;
    }
    state.set(taskId, 'visiting');
    stack.push(taskId);
    for (const dependencyId of dependencies.get(taskId) || []) {
      if (taskIds.includes(dependencyId)) visit(dependencyId);
    }
    stack.pop();
    state.set(taskId, 'done');
  };
  for (const taskId of taskIds) visit(taskId);
  for (const taskId of taskIds.filter((candidate) => Number(candidate.slice(1)) >= 51)) {
    if (!transitivelyDepends(taskId, 'T048', dependencies)) {
      errors.push(`tasks-dynamic-t048-dependency-missing:${taskId}`);
    }
  }
  return errors;
}

function concurrentOwnershipErrors(blocks, ownership) {
  const errors = [];
  const dependencies = dependencyMap(blocks);
  const taskIds = Object.keys(ownership?.tasks || {}).sort();
  for (let leftIndex = 0; leftIndex < taskIds.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < taskIds.length; rightIndex += 1) {
      const leftId = taskIds[leftIndex];
      const rightId = taskIds[rightIndex];
      if (transitivelyDepends(leftId, rightId, dependencies)
        || transitivelyDepends(rightId, leftId, dependencies)) continue;
      for (const leftPattern of ownership.tasks[leftId].allowedPaths || []) {
        for (const rightPattern of ownership.tasks[rightId].allowedPaths || []) {
          if (patternsOverlap(leftPattern, rightPattern)) {
            errors.push(`ownership-concurrent-path-overlap:${leftId}:${rightId}:${leftPattern}:${rightPattern}`);
          }
        }
      }
    }
  }
  return errors;
}

function sha256Text(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function stageBLocalReportSha256(report) {
  return sha256Text(canonicalJson(report));
}

function validSha1(value) {
  return /^[0-9a-f]{40}$/.test(String(value || ''));
}

function validSha256(value) {
  return /^[0-9a-f]{64}$/.test(String(value || ''));
}

function nonemptyBoundedString(value, maximumLength) {
  return typeof value === 'string'
    && value.trim().length > 0
    && value.length <= maximumLength;
}

export function foundationOwnershipSnapshot(ownership) {
  return Object.freeze({
    schemaVersion: ownership?.schemaVersion,
    globalForbidden: ownership?.globalForbidden,
    tasks: Object.fromEntries(
      Array.from({ length: FOUNDATION_TASK_COUNT }, (_, index) => {
        const taskId = `T${String(index + 1).padStart(3, '0')}`;
        return [taskId, ownership?.tasks?.[taskId]];
      }),
    ),
  });
}

export function computeFoundationOwnershipDigest(ownership) {
  return stableDigest(foundationOwnershipSnapshot(ownership));
}

export function initialCandidateGateSnapshot(ownership) {
  const shadowEvidence = ownership?.candidateGates?.shadowEvidence;
  return Object.freeze({
    schemaVersion: ownership?.candidateGates?.schemaVersion,
    shadowEvidence,
    tasks: Object.fromEntries(INITIAL_COMPONENT_TASK_IDS.map((taskId) => [
      taskId,
      ownership?.candidateGates?.tasks?.[taskId],
    ])),
  });
}

export function computeInitialCandidateGateDigest(ownership) {
  return stableDigest(initialCandidateGateSnapshot(ownership));
}

export function performanceThresholdSnapshot(performanceLocks) {
  return Object.fromEntries(Object.entries(performanceLocks?.profiles || {}).map(([profileId, profile]) => [
    profileId,
    {
      schemaVersion: profile?.schemaVersion,
      blockingThresholds: profile?.blockingThresholds,
      informationalMetrics: profile?.informationalMetrics,
      budgetOutcome: profile?.budgetOutcome,
    },
  ]));
}

export function performanceSourceSnapshot(performanceLocks) {
  const sym01 = performanceLocks?.profiles?.['P-SYM01'];
  const differential = sym01?.differentialGenerator?.descriptor;
  return Object.freeze({
    identityAlgorithm: performanceLocks?.identityAlgorithm,
    sym01SourceScope: sym01?.sourceScope,
    differentialGeneratorSource: differential && {
      sourcePath: differential.sourcePath,
      sourceGitBlobSha1: differential.sourceGitBlobSha1,
      sourceSha256: differential.sourceSha256,
    },
    recoveryEvidenceSources: sym01?.recoveryEvidenceSources,
  });
}

export function assertExactHead(expectedSha, observedSha) {
  if (!/^[0-9a-f]{40}$/.test(String(expectedSha || ''))) {
    throw new TypeError('expected-head-sha-invalid');
  }
  if (!/^[0-9a-f]{40}$/.test(String(observedSha || ''))) {
    throw new TypeError('observed-head-sha-invalid');
  }
  if (expectedSha !== observedSha) {
    throw new Error(`exact-head-mismatch: expected ${expectedSha}, observed ${observedSha}`);
  }
  return observedSha;
}

export function staleEvidenceFields(previous, current) {
  return EVIDENCE_IDENTITY_FIELDS.filter(
    (field) => JSON.stringify(previous?.[field] ?? null) !== JSON.stringify(current?.[field] ?? null),
  );
}

export function validateTaskInventory({ taskId, actualPaths, ownership, requireNonEmpty = true }) {
  const errors = [];
  const row = ownership?.tasks?.[taskId];
  const paths = Array.isArray(actualPaths) ? actualPaths : [];
  if (!row) errors.push(`inventory-owner-unknown:${taskId}`);
  if (!Array.isArray(actualPaths)) errors.push(`inventory-paths-invalid:${taskId}`);
  if (requireNonEmpty && paths.length === 0) errors.push(`inventory-paths-empty:${taskId}`);
  if (new Set(paths).size !== paths.length) errors.push(`inventory-path-duplicate:${taskId}`);
  const allowedPaths = row?.allowedPaths;
  if (!Array.isArray(allowedPaths) || allowedPaths.length === 0) {
    errors.push(`ownership-allowed-paths-empty:${taskId}`);
  } else if (allowedPaths.some((pattern) => !validAllowPattern(pattern))) {
    errors.push(`ownership-allowed-paths-invalid:${taskId}`);
  }
  const validPatterns = Array.isArray(allowedPaths)
    ? allowedPaths.filter((pattern) => validAllowPattern(pattern))
    : [];
  for (const repoPath of paths) {
    if (!validRepoPath(repoPath)) {
      errors.push(`inventory-path-invalid:${taskId}:${String(repoPath)}`);
    } else if (!pathAllowed(repoPath, validPatterns)) {
      errors.push(`inventory-path-outside-allowlist:${taskId}:${repoPath}`);
    }
  }
  return Object.freeze({ ok: errors.length === 0, errors: Object.freeze(errors) });
}

export function validateIntegrationInventory({
  integrationInventory,
  ownership,
  taskIds,
  actualChangedPaths = null,
  expectedBaseSha = null,
}) {
  const errors = [];
  if (integrationInventory?.schemaVersion !== INTEGRATION_INVENTORY_SCHEMA_VERSION) {
    errors.push('integration-inventory-schema-invalid');
  }
  if (!['STAGE_A', 'STAGE_B'].includes(integrationInventory?.campaignStage)) {
    errors.push('integration-inventory-campaign-stage-invalid');
  }
  if (!validIntegrationBranch(integrationInventory?.integrationRef)) {
    errors.push('integration-inventory-ref-invalid');
  }
  if (integrationInventory?.baseRef !== 'origin/main') {
    errors.push('integration-inventory-base-ref-invalid');
  }
  if (integrationInventory?.candidateRef !== 'HEAD') {
    errors.push('integration-inventory-candidate-ref-invalid');
  }

  const baseSha = integrationInventory?.baseSha;
  if (!/^[0-9a-f]{40}$/.test(String(baseSha || ''))) {
    errors.push('integration-inventory-base-sha-invalid');
  } else if (expectedBaseSha != null && baseSha !== expectedBaseSha) {
    errors.push(`integration-inventory-base-sha-mismatch:${baseSha}:${expectedBaseSha}`);
  }

  const expected = integrationInventory?.expectedChangedPaths;
  const actual = integrationInventory?.actualChangedPaths;
  const union = integrationInventory?.unionChangedPaths;
  for (const [name, values] of [['expected', expected], ['actual', actual], ['union', union]]) {
    if (!Array.isArray(values) || values.length === 0 || !exactSet(values, values)) {
      errors.push(`integration-inventory-${name}-paths-invalid`);
    }
    for (const repoPath of Array.isArray(values) ? values : []) {
      if (!validRepoPath(repoPath)) errors.push(`integration-inventory-path-invalid:${name}:${String(repoPath)}`);
    }
  }

  if (Array.isArray(expected) && Array.isArray(actual) && !exactSet(actual, expected)) {
    errors.push('integration-inventory-expected-actual-mismatch');
  }
  if (Array.isArray(expected) && Array.isArray(actual) && Array.isArray(union)) {
    const computedUnion = [...new Set([...expected, ...actual])];
    if (!exactSet(union, computedUnion)) errors.push('integration-inventory-union-mismatch');
  }

  const entries = integrationInventory?.entries;
  if (!Array.isArray(entries) || entries.length === 0) {
    errors.push('integration-inventory-entries-invalid');
  } else {
    const entryPaths = [];
    for (const entry of entries) {
      const repoPath = entry?.path;
      const ownerTaskId = entry?.ownerTaskId;
      if (!validRepoPath(repoPath)) {
        errors.push(`integration-inventory-entry-path-invalid:${String(repoPath)}`);
        continue;
      }
      entryPaths.push(repoPath);
      if (!taskIds.includes(ownerTaskId)) {
        errors.push(`integration-inventory-entry-owner-invalid:${repoPath}:${String(ownerTaskId)}`);
        continue;
      }
      const laneResult = validateTaskInventory({
        taskId: ownerTaskId,
        actualPaths: [repoPath],
        ownership,
      });
      errors.push(...laneResult.errors);
    }
    if (!exactSet(entryPaths, union || [])) errors.push('integration-inventory-entry-union-mismatch');
  }

  if (actualChangedPaths != null && !exactSet(actualChangedPaths, union || [])) {
    const missing = (union || []).filter((repoPath) => !actualChangedPaths.includes(repoPath));
    const unexpected = actualChangedPaths.filter((repoPath) => !(union || []).includes(repoPath));
    errors.push(`integration-inventory-git-diff-mismatch:missing=${missing.join(',')}:unexpected=${unexpected.join(',')}`);
  }

  return Object.freeze({
    ok: errors.length === 0,
    errors: Object.freeze(errors),
    pathCount: Array.isArray(union) ? union.length : 0,
    stableDigest: Array.isArray(union) ? stableDigest([...union].sort()) : null,
  });
}

function validateStageBInitialInventory(integrationInventory, blocks, errors) {
  if (integrationInventory?.campaignStage !== 'STAGE_B') return;
  const statuses = taskStatusMap(blocks || []);
  if (statuses.get('T025') === 'DONE' || statuses.get('T048') === 'DONE') return;
  for (const field of ['expectedChangedPaths', 'actualChangedPaths', 'unionChangedPaths']) {
    if (!exactSet(integrationInventory?.[field], STAGE_B_INITIAL_INVENTORY_PATHS)) {
      errors.push(`stage-b-initial-inventory-path-set-invalid:${field}`);
    }
  }
  const entries = Array.isArray(integrationInventory?.entries)
    ? integrationInventory.entries
    : [];
  if (!Array.isArray(integrationInventory?.entries)
    || entries.length !== STAGE_B_INITIAL_INVENTORY_PATHS.length
    || entries.some((entry) => entry?.ownerTaskId !== 'T047')
    || !exactSet(entries.map((entry) => entry?.path), STAGE_B_INITIAL_INVENTORY_PATHS)) {
    errors.push('stage-b-initial-inventory-owner-set-invalid');
  }
  if (integrationInventory?.checkpoint?.sequence !== 0
    || integrationInventory?.checkpoint?.state !== 'PREFANOUT'
    || integrationInventory?.checkpoint?.acceptedTaskId !== null) {
    errors.push('stage-b-initial-inventory-checkpoint-invalid');
  }
}

function validateFrozenPlatform(platformLocks, errors) {
  if (platformLocks?.schemaVersion !== 'hex-final-platform-performance-lock/v1') {
    errors.push('platform-lock-schema-invalid');
  }
  const digestRows = [
    ['platform-lock-digest-mismatch', platformLocks, FROZEN_PLATFORM_IDENTITIES.full],
    ['platform-denominator-digest-mismatch', platformLocks?.denominator, FROZEN_PLATFORM_IDENTITIES.denominator],
    ['platform-fixture-digest-mismatch', platformLocks?.denominator?.fixtureSet?.descriptor, FROZEN_PLATFORM_IDENTITIES.fixtureDescriptor],
    ['platform-runtime-classes-digest-mismatch', platformLocks?.runtimeClasses, FROZEN_PLATFORM_IDENTITIES.runtimeClasses],
    ['platform-identity-requirements-digest-mismatch', platformLocks?.identityRequirements, FROZEN_PLATFORM_IDENTITIES.identityRequirements],
    ['platform-row-policy-digest-mismatch', platformLocks?.requiredRowPolicy, FROZEN_PLATFORM_IDENTITIES.rowPolicy],
    ['platform-measurement-protocol-digest-mismatch', platformLocks?.measurementProtocol, FROZEN_PLATFORM_IDENTITIES.measurementProtocol],
    ['platform-workload-ids-digest-mismatch', platformLocks?.denominator?.workloads?.map((row) => row?.id), FROZEN_PLATFORM_IDENTITIES.workloadIds],
    ['platform-workloads-digest-mismatch', platformLocks?.denominator?.workloads, FROZEN_PLATFORM_IDENTITIES.workloads],
  ];
  for (const [code, value, expectedDigest] of digestRows) {
    if (stableDigest(value) !== expectedDigest) errors.push(code);
  }
  if (platformLocks?.denominatorStableDigest !== FROZEN_PLATFORM_IDENTITIES.denominator
    || platformLocks?.denominatorStableDigest !== stableDigest(platformLocks?.denominator)) {
    errors.push('platform-embedded-denominator-digest-invalid');
  }
  if (platformLocks?.denominator?.fixtureSet?.stableDigest !== FROZEN_PLATFORM_IDENTITIES.fixtureDescriptor
    || platformLocks?.denominator?.fixtureSet?.stableDigest
      !== stableDigest(platformLocks?.denominator?.fixtureSet?.descriptor)) {
    errors.push('platform-embedded-fixture-digest-invalid');
  }

  const runtimeClasses = (platformLocks?.runtimeClasses || [])
    .filter((item) => item?.required === true)
    .map((item) => item.id);
  if (!exactSet(runtimeClasses, REQUIRED_RUNTIME_CLASSES)) errors.push('platform-runtime-class-set-invalid');
  const physicalRuntime = platformLocks?.runtimeClasses
    ?.find((item) => item?.id === 'physical-ipad-supported-floor-v1');
  if (!physicalRuntime?.requirements?.includes('device has no more than 4 GiB physical memory')) {
    errors.push('platform-physical-ipad-memory-floor-missing');
  }

  const workloads = platformLocks?.denominator?.workloads;
  const workloadIds = Array.isArray(workloads) ? workloads.map((row) => row?.id) : [];
  if (!exactSet(workloadIds, EXPECTED_WORKLOAD_IDS)
    || workloads?.some((row) => row?.required !== true)) {
    errors.push('platform-required-workload-set-invalid');
  }
  for (const row of Array.isArray(workloads) ? workloads : []) {
    if (!Array.isArray(row.runtimeClassIds) || !exactSet(row.runtimeClassIds, REQUIRED_RUNTIME_CLASSES)) {
      errors.push(`platform-workload-runtime-invalid:${row.id || 'UNKNOWN'}`);
    }
    if (!Array.isArray(row.targets) || row.targets.length === 0
      || row.targets.some((target) => typeof target?.metric !== 'string'
        || typeof target?.unit !== 'string'
        || !['<=', '>=', '=='].includes(target?.operator)
        || !Number.isFinite(target?.threshold))) {
      errors.push(`platform-workload-targets-invalid:${row.id || 'UNKNOWN'}`);
    }
  }
  return { runtimeClasses, workloads };
}

function validateThresholdRows(profileId, name, rows, errors) {
  if (!Array.isArray(rows) || rows.length === 0) {
    errors.push(`performance-${name}-thresholds-invalid:${profileId}`);
    return;
  }
  const metrics = [];
  for (const row of rows) {
    if (typeof row?.metric !== 'string' || row.metric === ''
      || typeof row?.unit !== 'string' || row.unit === ''
      || !['<=', '>=', '=='].includes(row?.operator)
      || !Number.isFinite(row?.threshold)) {
      errors.push(`performance-${name}-threshold-invalid:${profileId}:${String(row?.metric || 'UNKNOWN')}`);
    }
    metrics.push(row?.metric);
  }
  if (new Set(metrics).size !== metrics.length) {
    errors.push(`performance-${name}-threshold-duplicate:${profileId}`);
  }
}

function validateFrozenPerformance(performanceLocks, errors) {
  if (performanceLocks?.schemaVersion !== PERFORMANCE_LOCK_SCHEMA_VERSION) {
    errors.push('performance-lock-schema-invalid');
  }
  if (stableDigest(performanceLocks) !== FROZEN_PERFORMANCE_IDENTITIES.full) {
    errors.push('performance-lock-full-digest-mismatch');
  }

  const expectedProfiles = Object.keys(FROZEN_PERFORMANCE_IDENTITIES.profiles);
  const profiles = performanceLocks?.profiles;
  const profileIds = Object.keys(profiles || {});
  if (!exactSet(profileIds, expectedProfiles)) errors.push('performance-profile-set-invalid');
  for (const profileId of expectedProfiles) {
    const profile = profiles?.[profileId];
    if (stableDigest(profile) !== FROZEN_PERFORMANCE_IDENTITIES.profiles[profileId]) {
      errors.push(`performance-profile-digest-mismatch:${profileId}`);
    }
    validateThresholdRows(profileId, 'blocking', profile?.blockingThresholds, errors);
    if (profile?.informationalMetrics != null) {
      validateThresholdRows(profileId, 'informational', profile.informationalMetrics, errors);
    }
  }
  if (stableDigest(performanceThresholdSnapshot(performanceLocks))
    !== FROZEN_PERFORMANCE_IDENTITIES.thresholds) {
    errors.push('performance-threshold-digest-mismatch');
  }
  if (stableDigest(performanceSourceSnapshot(performanceLocks)) !== FROZEN_PERFORMANCE_IDENTITIES.sources) {
    errors.push('performance-source-digest-mismatch');
  }

  const sym01 = profiles?.['P-SYM01'];
  const sourceScope = sym01?.sourceScope;
  if (sourceScope?.schemaVersion !== 'hex-sym01-immutable-source-scope/v1') {
    errors.push('performance-source-scope-schema-invalid');
  }
  if (!validSha1(sourceScope?.commitSha) || !validSha1(sourceScope?.treeSha)) {
    errors.push('performance-source-scope-commit-invalid');
  }
  if (sourceScope?.fetchRef !== 'refs/heads/wip/recovered-sym01-20260904') {
    errors.push('performance-source-scope-ref-invalid');
  }
  const expectedSourceRows = [
    performanceLocks?.identityAlgorithm && {
      path: performanceLocks.identityAlgorithm.sourcePath,
      gitBlobSha1: performanceLocks.identityAlgorithm.sourceGitBlobSha1,
      sha256: performanceLocks.identityAlgorithm.sourceSha256,
    },
    sym01?.differentialGenerator?.descriptor && {
      path: sym01.differentialGenerator.descriptor.sourcePath,
      gitBlobSha1: sym01.differentialGenerator.descriptor.sourceGitBlobSha1,
      sha256: sym01.differentialGenerator.descriptor.sourceSha256,
    },
    ...(sym01?.recoveryEvidenceSources || []).map((row) => ({
      path: row?.path,
      gitBlobSha1: row?.gitBlobSha1,
      sha256: row?.sha256,
    })),
  ].filter(Boolean);
  const sourceRows = sourceScope?.paths;
  if (!Array.isArray(sourceRows) || sourceRows.length === 0) {
    errors.push('performance-source-paths-invalid');
  } else {
    const paths = sourceRows.map((row) => row?.path);
    if (!exactSet(paths, expectedSourceRows.map((row) => row.path))) {
      errors.push('performance-source-path-set-invalid');
    }
    for (const row of sourceRows) {
      if (!validRepoPath(row?.path) || !validSha1(row?.gitBlobSha1) || !validSha256(row?.sha256)) {
        errors.push(`performance-source-row-invalid:${String(row?.path || 'UNKNOWN')}`);
      }
      const expected = expectedSourceRows.find((candidate) => candidate.path === row?.path);
      if (!expected || expected.gitBlobSha1 !== row?.gitBlobSha1 || expected.sha256 !== row?.sha256) {
        errors.push(`performance-source-row-mismatch:${String(row?.path || 'UNKNOWN')}`);
      }
    }
  }
  return { profileIds, sourceScope };
}

function parseEvidenceJsonBlock(text, blockName, errors) {
  if (typeof text !== 'string') {
    errors.push(`stage-evidence-block-missing:${blockName}`);
    return null;
  }
  const escaped = blockName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const expression = new RegExp(
    '(^|\\n)```json[ \\t]+' + escaped + '[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n```(?=\\r?\\n|$)',
    'g',
  );
  const matches = [...text.matchAll(expression)];
  if (matches.length !== 1) {
    errors.push(`stage-evidence-block-${matches.length === 0 ? 'missing' : 'duplicate'}:${blockName}`);
    return null;
  }
  try {
    const parsed = JSON.parse(matches[0][2]);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      errors.push(`stage-evidence-json-object-invalid:${blockName}`);
      return null;
    }
    return parsed;
  } catch {
    errors.push(`stage-evidence-json-malformed:${blockName}`);
    return null;
  }
}

function parseRoadmapMatrixStatuses(text, errors) {
  if (typeof text !== 'string' || text.length === 0) {
    errors.push('stage-b-roadmap-matrix-missing');
    return new Map();
  }
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\|\s*(HEX-[A-Z0-9-]+)\s*\|[^|\n]*\|\s*([A-Z]+)\s*\|/);
    if (!match) continue;
    rows.push({ findingId: match[1], status: match[2] });
  }
  const findingIds = rows.map((row) => row.findingId);
  if (!exactSet(findingIds, STAGE_B_ROADMAP_IDS)) {
    errors.push('stage-b-roadmap-matrix-finding-set-invalid');
  }
  for (const row of rows) {
    if (!STAGE_B_ROADMAP_STATUSES.includes(row.status)) {
      errors.push(`stage-b-roadmap-matrix-status-invalid:${row.findingId}:${row.status}`);
    }
  }
  return new Map(rows.map((row) => [row.findingId, row.status]));
}

function emptyStageBApplicability(required, coverage = null) {
  return Object.freeze({
    required,
    valid: false,
    coverage,
    actionsByTask: Object.freeze({}),
    checkpointTaskIds: Object.freeze([]),
    implementationTaskIds: Object.freeze([]),
    noEditTaskIds: Object.freeze([]),
    nonImplementationTaskIds: Object.freeze([]),
  });
}

export function validateStageBApplicability({
  campaignStage,
  blocks,
  taskIds,
  integrationInventory,
  stageBResidualCoverageText,
  roadmapMatrixText,
  roadmapMatrixSha256 = null,
  roadmapMatrixHandoffSha256 = null,
  errors = [],
}) {
  const statuses = taskStatusMap(blocks || []);
  const required = campaignStage === 'STAGE_B' && statuses.get('T048') === 'DONE';
  if (!required) {
    return Object.freeze({
      required: false,
      valid: true,
      coverage: null,
      actionsByTask: Object.freeze({}),
      checkpointTaskIds: Object.freeze([]),
      implementationTaskIds: Object.freeze([]),
      noEditTaskIds: Object.freeze([]),
      nonImplementationTaskIds: Object.freeze([]),
    });
  }

  const errorCountBefore = errors.length;
  const roadmapStatuses = parseRoadmapMatrixStatuses(roadmapMatrixText, errors);
  const coverage = parseEvidenceJsonBlock(
    stageBResidualCoverageText,
    STAGE_B_RESIDUAL_COVERAGE_BLOCK,
    errors,
  );
  if (!coverage) {
    errors.push('stage-b-residual-coverage-invalid');
    return emptyStageBApplicability(true);
  }
  if (!exactSet(Object.keys(coverage), [
    'schemaVersion', 'campaignStage', 'baseSha', 'source', 'findings', 'tasks',
  ])
    || coverage.schemaVersion !== STAGE_B_RESIDUAL_COVERAGE_SCHEMA_VERSION
    || coverage.campaignStage !== 'STAGE_B'
    || coverage.baseSha !== integrationInventory?.baseSha) {
    errors.push('stage-b-residual-coverage-header-invalid');
  }

  const source = coverage.source;
  const t025Handoff = integrationInventory?.taskHandoffs?.T025;
  if (!source
    || !exactSet(Object.keys(source), [
      'taskId', 'headSha', 'treeSha', 'evidencePath', 'matrixSha256',
    ])
    || source.taskId !== 'T025'
    || !validSha1(source.headSha)
    || !validSha1(source.treeSha)
    || source.evidencePath !== 'specs/005-analysis-final-closure/evidence/roadmap-matrix.md'
    || !validSha256(source.matrixSha256)
    || source.matrixSha256 !== roadmapMatrixSha256
    || source.matrixSha256 !== roadmapMatrixHandoffSha256
    || !t025Handoff
    || source.headSha !== t025Handoff.headSha
    || source.treeSha !== t025Handoff.treeSha
    || source.evidencePath !== t025Handoff.evidencePath) {
    errors.push('stage-b-residual-coverage-source-invalid');
  }
  const t048Handoff = integrationInventory?.taskHandoffs?.T048;
  const inventoryEntries = Array.isArray(integrationInventory?.entries)
    ? integrationInventory.entries
    : [];
  const coverageEntry = inventoryEntries
    .find((entry) => entry?.path === STAGE_B_RESIDUAL_COVERAGE_PATH);
  if (t048Handoff?.evidencePath !== STAGE_B_RESIDUAL_COVERAGE_PATH
    || coverageEntry?.ownerTaskId !== 'T048'
    || !(integrationInventory?.unionChangedPaths || []).includes(STAGE_B_RESIDUAL_COVERAGE_PATH)) {
    errors.push('stage-b-residual-coverage-publication-invalid');
  }

  const findings = Array.isArray(coverage.findings) ? coverage.findings : [];
  const findingIds = findings.map((row) => row?.findingId);
  if (!exactSet(findingIds, STAGE_B_ROADMAP_IDS)) {
    errors.push('stage-b-residual-coverage-finding-set-invalid');
  }
  const findingsById = new Map();
  for (const row of findings) {
    if (!row
      || !exactSet(Object.keys(row), ['findingId', 'status', 'durableDisposition'])
      || !STAGE_B_ROADMAP_IDS.includes(row.findingId)
      || !STAGE_B_ROADMAP_STATUSES.includes(row.status)) {
      errors.push(`stage-b-residual-coverage-finding-invalid:${String(row?.findingId || 'UNKNOWN')}`);
      continue;
    }
    const terminalExisting = ['DONE', 'REPLACED', 'OBSOLETE'].includes(row.status);
    if ((terminalExisting && row.durableDisposition !== 'COMPLETE_EXISTING')
      || (row.status === 'BLOCKED' && row.durableDisposition !== 'BLOCKED_BY_DEPENDENCY')
      || (['PARTIAL', 'REMAINING'].includes(row.status) && row.durableDisposition !== null)) {
      errors.push(`stage-b-residual-coverage-disposition-invalid:${row.findingId}`);
    }
    if (roadmapStatuses.get(row.findingId) !== row.status) {
      errors.push(`stage-b-residual-coverage-matrix-status-mismatch:${row.findingId}`);
    }
    findingsById.set(row.findingId, row);
  }

  const componentTaskIds = taskIds.filter((taskId) => {
    const number = Number(taskId.slice(1));
    return STAGE_B_FOUNDATION_COMPONENT_TASK_IDS.includes(taskId) || number >= 51;
  });
  const tasks = Array.isArray(coverage.tasks) ? coverage.tasks : [];
  const coverageTaskIds = tasks.map((row) => row?.taskId);
  if (!exactSet(coverageTaskIds, componentTaskIds)) {
    errors.push('stage-b-residual-coverage-task-set-invalid');
  }
  const actionsByTask = new Map();
  const assignedFindingIds = [];
  for (const row of tasks) {
    const externalBlockAction = row?.implementationAction === 'NO_EDIT_EXTERNAL_BLOCK';
    const baseTaskKeys = ['taskId', 'findingId', 'implementationAction'];
    const taskKeysValid = externalBlockAction
      ? (exactSet(Object.keys(row), baseTaskKeys)
        || exactSet(Object.keys(row), [...baseTaskKeys, 'externalBlocker']))
      : exactSet(Object.keys(row || {}), baseTaskKeys);
    if (!row
      || !taskKeysValid
      || !componentTaskIds.includes(row.taskId)
      || !STAGE_B_IMPLEMENTATION_ACTIONS.includes(row.implementationAction)) {
      errors.push(`stage-b-residual-coverage-task-invalid:${String(row?.taskId || 'UNKNOWN')}`);
      continue;
    }
    if (row.taskId === 'T045') {
      if (row.findingId !== null || row.implementationAction !== 'IMPLEMENT') {
        errors.push('stage-b-residual-coverage-t045-invalid');
      }
      if (!['PENDING', 'DONE'].includes(statuses.get(row.taskId))) {
        errors.push(`stage-b-residual-coverage-task-status-invalid:${row.taskId}`);
      }
      actionsByTask.set(row.taskId, row.implementationAction);
      continue;
    }
    if (Number(row.taskId.slice(1)) >= 51 && row.implementationAction === 'NO_EDIT') {
      errors.push(`stage-b-residual-coverage-superfluous-dynamic-no-edit:${row.taskId}`);
    }
    if (!STAGE_B_ROADMAP_IDS.includes(row.findingId)) {
      errors.push(`stage-b-residual-coverage-task-finding-invalid:${row.taskId}`);
      continue;
    }
    const staticFindingId = STAGE_B_STATIC_FINDING_BY_TASK[row.taskId];
    if (staticFindingId != null && row.findingId !== staticFindingId) {
      errors.push(`stage-b-residual-coverage-static-mapping-invalid:${row.taskId}:${row.findingId}`);
    }
    assignedFindingIds.push(row.findingId);
    const finding = findingsById.get(row.findingId);
    const status = statuses.get(row.taskId);
    if (row.implementationAction === 'IMPLEMENT') {
      if (!finding || !['PARTIAL', 'REMAINING'].includes(finding.status)
        || !['PENDING', 'DONE'].includes(status)) {
        errors.push(`stage-b-residual-coverage-implement-invalid:${row.taskId}`);
      }
    } else if (row.implementationAction === 'NO_EDIT') {
      if (!finding || !['DONE', 'REPLACED', 'OBSOLETE'].includes(finding.status)
        || finding.durableDisposition !== 'COMPLETE_EXISTING'
        || status !== 'DONE') {
        errors.push(`stage-b-residual-coverage-no-edit-invalid:${row.taskId}`);
      }
    } else if (row.implementationAction === 'NO_EDIT_EXTERNAL_BLOCK') {
      if (!finding || finding.status !== 'BLOCKED'
        || finding.durableDisposition !== 'BLOCKED_BY_DEPENDENCY'
        || status !== 'PENDING') {
        errors.push(`stage-b-residual-coverage-external-block-invalid:${row.taskId}`);
      }
      const blocker = row.externalBlocker;
      if (!blocker
        || !exactSet(Object.keys(blocker), [
          'requirementId',
          'repositoryLimitation',
          'externalOwner',
          'attemptedAlternatives',
          'evidence',
          'minimumUnblockAction',
        ])
        || blocker.requirementId !== row.findingId
        || !nonemptyBoundedString(blocker.repositoryLimitation, 4096)
        || !nonemptyBoundedString(blocker.externalOwner, 1024)
        || !Array.isArray(blocker.attemptedAlternatives)
        || blocker.attemptedAlternatives.length === 0
        || blocker.attemptedAlternatives.length > 64
        || blocker.attemptedAlternatives.some(
          (alternative) => !nonemptyBoundedString(alternative, 4096),
        )
        || !Array.isArray(blocker.evidence)
        || blocker.evidence.length === 0
        || blocker.evidence.length > 64
        || blocker.evidence.some((item) => !nonemptyBoundedString(item, 4096))
        || !nonemptyBoundedString(blocker.minimumUnblockAction, 4096)) {
        errors.push(`stage-b-residual-coverage-external-block-evidence-invalid:${row.taskId}`);
      }
    } else if (!finding || !['PARTIAL', 'REMAINING'].includes(finding.status)
      || !['BLOCKED_BY_CONCURRENT_WORK', 'DONE'].includes(status)) {
      errors.push(`stage-b-residual-coverage-reconcile-owner-invalid:${row.taskId}`);
    }
    actionsByTask.set(row.taskId, row.implementationAction);
  }
  if (new Set(assignedFindingIds).size !== assignedFindingIds.length) {
    errors.push('stage-b-residual-coverage-finding-owner-duplicate');
  }
  for (const row of findings) {
    if (['PARTIAL', 'REMAINING', 'BLOCKED'].includes(row?.status)
      && !assignedFindingIds.includes(row.findingId)) {
      errors.push(`stage-b-residual-coverage-residual-unowned:${row.findingId}`);
    }
  }
  for (const entry of inventoryEntries) {
    const action = actionsByTask.get(entry?.ownerTaskId);
    if (action === 'RECONCILE_OWNER' && statuses.get(entry.ownerTaskId) !== 'DONE') {
      errors.push(`stage-b-residual-coverage-reconcile-owner-inventory-before-adoption:${entry.ownerTaskId}:${entry.path}`);
    } else if (action != null && !['IMPLEMENT', 'RECONCILE_OWNER'].includes(action)) {
      errors.push(`stage-b-residual-coverage-nonimplementation-inventory-owner:${entry.ownerTaskId}:${entry.path}`);
    }
  }

  if (errors.length !== errorCountBefore) return emptyStageBApplicability(true, coverage);
  const checkpointTaskIds = componentTaskIds.filter(
    (taskId) => ['IMPLEMENT', 'RECONCILE_OWNER'].includes(actionsByTask.get(taskId)),
  );
  const implementationTaskIds = componentTaskIds.filter(
    (taskId) => actionsByTask.get(taskId) === 'IMPLEMENT',
  );
  const noEditTaskIds = componentTaskIds.filter(
    (taskId) => actionsByTask.get(taskId) === 'NO_EDIT',
  );
  const nonImplementationTaskIds = componentTaskIds.filter(
    (taskId) => actionsByTask.get(taskId) !== 'IMPLEMENT',
  );
  return Object.freeze({
    required: true,
    valid: true,
    coverage: Object.freeze(coverage),
    actionsByTask: Object.freeze(Object.fromEntries(actionsByTask)),
    checkpointTaskIds: Object.freeze(checkpointTaskIds),
    implementationTaskIds: Object.freeze(implementationTaskIds),
    noEditTaskIds: Object.freeze(noEditTaskIds),
    nonImplementationTaskIds: Object.freeze(nonImplementationTaskIds),
  });
}

function workspacePreservationPayload(value) {
  return {
    realPath: value?.realPath ?? value?.path,
    gitDirPath: value?.gitDirPath,
    headSha: value?.headSha,
    branchRef: value?.branchRef,
    status: value?.status,
    dirtyStateSha256: value?.dirtyStateSha256,
    transcriptsSha256: value?.transcriptsSha256,
  };
}

function validEvidenceWorkspace(value) {
  return value && typeof value === 'object'
    && typeof value.path === 'string' && value.path.startsWith('/')
    && typeof value.gitDirPath === 'string' && value.gitDirPath.startsWith('/')
    && validSha1(value.headSha)
    && typeof value.branchRef === 'string' && value.branchRef.length > 0
    && typeof value.status === 'string'
    && validSha256(value.dirtyStateSha256)
    && validSha256(value.transcriptsSha256)
    && validSha256(value.identity)
    && value.identity === stageBLocalReportSha256(workspacePreservationPayload(value))
    && value.preserved === true;
}

function stageWorktreePayload(value) {
  return {
    realPath: value?.realPath ?? value?.path,
    gitDirPath: value?.gitDirPath,
    headSha: value?.headSha,
    branchRef: value?.branchRef,
    status: value?.status,
  };
}

function validStageAWorktree(value) {
  return value && typeof value === 'object'
    && typeof value.path === 'string' && value.path.startsWith('/')
    && typeof value.gitDirPath === 'string' && value.gitDirPath.startsWith('/')
    && validSha1(value.headSha)
    && validIntegrationBranch(value.branchRef)
    && value.status === ''
    && validSha256(value.identity)
    && value.identity === stageBLocalReportSha256(stageWorktreePayload(value));
}

function validStageBWorktree(value) {
  return value && typeof value === 'object'
    && typeof value.path === 'string' && value.path.startsWith('/')
    && validSha256(value.identity);
}

function validateOriginalWorkspaceLock(preFanoutText, errors) {
  const lock = parseEvidenceJsonBlock(preFanoutText, ORIGINAL_WORKSPACE_LOCK_BLOCK, errors);
  if (!lock) return Object.freeze({ lock: null, workspace: null });
  if (lock.schemaVersion !== ORIGINAL_WORKSPACE_LOCK_SCHEMA_VERSION) {
    errors.push('original-workspace-lock-schema-invalid');
  }
  if (!validEvidenceWorkspace(lock.workspace)) {
    errors.push('original-workspace-lock-invalid');
  }
  return Object.freeze({ lock, workspace: lock.workspace ?? null });
}

function validateStageBEvidence({
  integrationInventory,
  stageAPostMergeText,
  stageBPreflightText,
  originalWorkspaceLock,
  errors,
}) {
  if (integrationInventory?.campaignStage !== 'STAGE_B') return Object.freeze({ stageA: null, stageB: null });
  const stageA = parseEvidenceJsonBlock(stageAPostMergeText, STAGE_A_EVIDENCE_BLOCK, errors);
  const stageB = parseEvidenceJsonBlock(stageBPreflightText, STAGE_B_EVIDENCE_BLOCK, errors);
  if (!stageA || !stageB) return Object.freeze({ stageA, stageB });

  if (stageA.schemaVersion !== STAGE_A_EVIDENCE_SCHEMA_VERSION) {
    errors.push('stage-a-evidence-schema-invalid');
  }
  const candidate = stageA.candidate;
  for (const field of ['headSha', 'treeSha', 'baseSha', 'mergeTreeSha']) {
    if (!validSha1(candidate?.[field])) errors.push(`stage-a-candidate-${field}-invalid`);
  }
  if (!validSha1(stageA.acceptedMergeCommitSha) || !validSha1(stageA.refetchedMainSha)) {
    errors.push('stage-a-post-merge-sha-invalid');
  }
  if (stageA?.smoke?.status !== 'PASS' || stageA?.smoke?.headSha !== stageA.refetchedMainSha) {
    errors.push('stage-a-smoke-record-invalid');
  }
  if (!validStageAWorktree(stageA.stageAWorktree)) errors.push('stage-a-worktree-identity-invalid');
  if (!validEvidenceWorkspace(stageA.originalWorkspace)) errors.push('stage-a-original-workspace-invalid');
  if (canonicalJson(stageA.originalWorkspace) !== canonicalJson(originalWorkspaceLock)) {
    errors.push('stage-a-original-workspace-lock-mismatch');
  }
  if (stageA?.recoveryRef?.ref !== RECOVERY_HANDOFF_CANONICAL_REMOTE_REF
    || !validSha1(stageA?.recoveryRef?.sha)
    || stageA?.recoveryRef?.preserved !== true) {
    errors.push('stage-a-recovery-ref-invalid');
  }

  if (stageB.schemaVersion !== STAGE_B_EVIDENCE_SCHEMA_VERSION) {
    errors.push('stage-b-evidence-schema-invalid');
  }
  if (stageB.baseSha !== integrationInventory?.baseSha || !validSha1(stageB.baseSha)) {
    errors.push('stage-b-base-binding-mismatch');
  }
  if (typeof stageB.integrationBranch !== 'string'
    || !/^analysis\/final-closure-[a-z0-9][a-z0-9._/-]*$/.test(stageB.integrationBranch)
    || stageB.integrationBranch !== integrationInventory?.integrationRef) {
    errors.push('stage-b-integration-branch-invalid');
  }
  const worktree = stageB.worktree;
  if (!validStageBWorktree(worktree)
    || worktree?.initialHeadSha !== stageB.baseSha
    || worktree?.initialStatus !== 'CLEAN') {
    errors.push('stage-b-worktree-state-invalid');
  }
  if (worktree?.reused !== false) errors.push('stage-b-worktree-reused');
  if (!validEvidenceWorkspace(stageB.originalWorkspace)
    || JSON.stringify(stageB.originalWorkspace) !== JSON.stringify(stageA.originalWorkspace)) {
    errors.push('stage-b-original-workspace-mismatch');
  }
  if (!stageB?.recoveryRef
    || JSON.stringify(stageB.recoveryRef) !== JSON.stringify(stageA.recoveryRef)
    || stageB.recoveryRef.preserved !== true) {
    errors.push('stage-b-recovery-ref-mismatch');
  }
  if (worktree?.path === stageA?.stageAWorktree?.path
    || worktree?.path === stageA?.originalWorkspace?.path
    || worktree?.identity === stageA?.stageAWorktree?.identity
    || worktree?.identity === stageA?.originalWorkspace?.identity) {
    errors.push('stage-b-worktree-not-distinct');
  }
  const localVerification = stageB.localVerification;
  const localReport = localVerification?.report;
  if (localVerification?.schemaVersion !== 'hex-final-closure-stage-b-local-worktree-report/v1'
    || localVerification?.status !== 'PASS'
    || !localReport || typeof localReport !== 'object'
    || localVerification?.reportSha256 !== stageBLocalReportSha256(localReport)) {
    errors.push('stage-b-local-verification-invalid');
  } else if (localReport.stageBWorktreePath !== worktree.path
    || localReport.stageBWorktreeIdentity !== worktree.identity
    || localReport.integrationBranch !== stageB.integrationBranch
    || localReport.baseSha !== stageB.baseSha
    || localReport.originalWorkspacePath !== stageB.originalWorkspace.path
    || localReport.originalWorkspaceIdentity !== stageB.originalWorkspace.identity
    || localReport.originalWorkspaceGitDirPath !== stageB.originalWorkspace.gitDirPath
    || localReport.originalWorkspaceHeadSha !== stageB.originalWorkspace.headSha
    || localReport.originalWorkspaceBranchRef !== stageB.originalWorkspace.branchRef
    || localReport.originalWorkspaceStatus !== stageB.originalWorkspace.status
    || localReport.originalWorkspaceDirtyStateSha256 !== stageB.originalWorkspace.dirtyStateSha256
    || localReport.originalWorkspaceTranscriptsSha256 !== stageB.originalWorkspace.transcriptsSha256
    || localReport.recoveryRef !== stageB.recoveryRef.ref
    || localReport.recoveryRefSha !== stageB.recoveryRef.sha
    || typeof localReport.stageBGitDirPath !== 'string'
    || !localReport.stageBGitDirPath.startsWith('/')) {
    errors.push('stage-b-local-report-binding-mismatch');
  }
  return Object.freeze({ stageA, stageB });
}

function stageComponentTaskIds(campaignStage, taskIds, stageBApplicability = null) {
  if (campaignStage === 'STAGE_A') {
    return taskIds.filter((taskId) => {
      const number = Number(taskId.slice(1));
      return number >= 11 && number <= 17;
    });
  }
  if (campaignStage === 'STAGE_B') {
    if (stageBApplicability?.required === true) {
      return stageBApplicability.valid === true
        ? [...stageBApplicability.checkpointTaskIds]
        : [];
    }
    return taskIds.filter((taskId) => {
      const number = Number(taskId.slice(1));
      return (number >= 26 && number <= 36) || number === 45 || number >= 51;
    });
  }
  return [];
}

function validCheckpointRow(row, expectedSequence, errors) {
  if (row?.sequence !== expectedSequence || !Number.isSafeInteger(row.sequence) || row.sequence <= 0) {
    errors.push(`checkpoint-ledger-sequence-invalid:${expectedSequence}:${String(row?.sequence)}`);
  }
  if (!/^T\d{3}$/.test(String(row?.acceptedTaskId || ''))) {
    errors.push(`checkpoint-accepted-task-invalid:${expectedSequence}`);
  }
  for (const field of ['integrationParentSha', 'componentHeadSha', 'candidateMergeTreeSha']) {
    if (!validSha1(row?.[field])) errors.push(`checkpoint-${field}-invalid:${expectedSequence}`);
  }
  const mainReconciliation = row?.mainReconciliation;
  if (mainReconciliation?.schemaVersion !== MAIN_RECONCILIATION_SCHEMA_VERSION
    || !['NOOP', 'EXACT_MERGE'].includes(mainReconciliation?.mode)
    || !validSha1(mainReconciliation?.previousEvidenceSha)
    || !validSha1(mainReconciliation?.currentMainSha)
    || mainReconciliation?.integrationHeadSha !== row?.integrationParentSha
    || !validSha1(mainReconciliation?.integrationHeadTreeSha)
    || !Array.isArray(mainReconciliation?.adjustmentPaths)
    || !exactSet(mainReconciliation.adjustmentPaths, mainReconciliation.adjustmentPaths)
    || mainReconciliation.adjustmentPaths.some((repoPath) => !validRepoPath(repoPath))
    || !/^[0-9a-f]{32}$/.test(String(mainReconciliation?.adjustmentStableDigest || ''))
    || (mainReconciliation?.mode === 'NOOP'
      && (mainReconciliation.autoMergeTreeSha !== null
        || mainReconciliation.adjustmentPaths.length !== 0))
    || (mainReconciliation?.mode === 'EXACT_MERGE'
      && !validSha1(mainReconciliation.autoMergeTreeSha))) {
    errors.push(`checkpoint-main-reconciliation-invalid:${expectedSequence}`);
  }
  if (!validSha1(row?.acceptedMerge?.commitSha)
    || !validSha1(row?.acceptedMerge?.treeSha)) {
    errors.push(`checkpoint-accepted-merge-invalid:${expectedSequence}`);
  }
  if (!validSha1(row?.checkpointProduct?.commitSha)
    || !validSha1(row?.checkpointProduct?.treeSha)) {
    errors.push(`checkpoint-product-invalid:${expectedSequence}`);
  }
  const integrationReconciliation = row?.integrationReconciliation;
  if (integrationReconciliation?.schemaVersion !== PRODUCT_RECONCILIATION_SCHEMA_VERSION
    || !['T049', 'T050'].includes(integrationReconciliation?.ownerTaskId)
    || integrationReconciliation?.mergeCommitSha !== row?.acceptedMerge?.commitSha
    || integrationReconciliation?.productCommitSha !== row?.checkpointProduct?.commitSha
    || !Array.isArray(integrationReconciliation?.paths)
    || !exactSet(integrationReconciliation.paths, integrationReconciliation.paths)
    || integrationReconciliation.paths.some((repoPath) => !validRepoPath(repoPath))
    || !Number.isSafeInteger(integrationReconciliation?.pathCount)
    || integrationReconciliation.pathCount !== integrationReconciliation.paths.length
    || !/^[0-9a-f]{32}$/.test(String(integrationReconciliation?.stableDigest || ''))) {
    errors.push(`checkpoint-product-reconciliation-invalid:${expectedSequence}`);
  }
  const productIdentity = row?.checkpointProduct;
  if (row?.generation?.schemaVersion !== 'hex-final-closure-checkpoint-generation-evidence/v1'
    || row?.generation?.command !== 'node scripts/build-userscript.mjs'
    || row?.generation?.firstRunDiffEmpty !== true
    || row?.generation?.secondRunDiffEmpty !== true
    || row?.generation?.candidateIdentity?.headSha !== productIdentity?.commitSha
    || row?.generation?.candidateIdentity?.treeSha !== productIdentity?.treeSha
    || !validSha1(row?.generation?.generator?.gitBlobSha1)
    || !validSha256(row?.generation?.generator?.sha256)
    || !Array.isArray(row?.generation?.generatedBlobs)
    || row.generation.generatedBlobs.length !== CHECKPOINT_GENERATED_PATHS.length
    || row.generation.generatedBlobs.some((blob) => !validRepoPath(blob?.path)
      || !validSha1(blob?.gitBlobSha1) || !validSha256(blob?.sha256))
    || !validSha256(row?.generation?.sourceIdentity)
    || !validSha256(row?.generation?.buildIdentity)
    || !validSha256(row?.generation?.artifactIdentity)
    || !validSha256(row?.generation?.releaseIdentity)
    || !/^[0-9a-f]{24}$/.test(String(row?.generation?.buildId || ''))
    || !Number.isSafeInteger(row?.generation?.releaseSerial)
    || row.generation.releaseSerial < 1) {
    errors.push(`checkpoint-generation-invalid:${expectedSequence}`);
  }
  if (row?.rollingProductGates?.schemaVersion !== 'hex-final-closure-checkpoint-rolling-evidence/v2'
    || !Array.isArray(row?.rollingProductGates?.taskIds)
    || row.rollingProductGates.taskIds.length === 0
    || row.rollingProductGates.taskIds.at(-1) !== row?.acceptedTaskId
    || new Set(row.rollingProductGates.taskIds).size !== row.rollingProductGates.taskIds.length
    || row?.rollingProductGates?.status !== 'PASS'
    || row?.rollingProductGates?.candidateIdentity?.headSha !== productIdentity?.commitSha
    || row?.rollingProductGates?.candidateIdentity?.treeSha !== productIdentity?.treeSha
    || !Array.isArray(row?.rollingProductGates?.results)
    || row.rollingProductGates.results.length === 0
    || !validSha256(row?.rollingProductGates?.identity)) {
    errors.push(`checkpoint-rolling-gates-invalid:${expectedSequence}`);
  }
  if (row?.independentShadowVerifier?.schemaVersion !== 'hex-final-closure-checkpoint-shadow-evidence/v1'
    || row?.independentShadowVerifier?.status !== 'PASS'
    || row?.independentShadowVerifier?.candidateIdentity?.headSha !== productIdentity?.commitSha
    || row?.independentShadowVerifier?.candidateIdentity?.treeSha !== productIdentity?.treeSha
    || !Array.isArray(row?.independentShadowVerifier?.reports)
    || row.independentShadowVerifier.reports.length === 0
    || !validSha256(row?.independentShadowVerifier?.identity)) {
    errors.push(`checkpoint-shadow-verifier-invalid:${expectedSequence}`);
  }
  if (row?.initialCandidateGateDigest !== FROZEN_INITIAL_CANDIDATE_GATE_DIGEST) {
    errors.push(`checkpoint-candidate-gate-digest-invalid:${expectedSequence}`);
  }
  if (!validSha1(row?.cumulativeInventory?.baseSha)
    || !/^[0-9a-f]{32}$/.test(String(row?.cumulativeInventory?.stableDigest || ''))
    || !Number.isSafeInteger(row?.cumulativeInventory?.pathCount)
    || row.cumulativeInventory.pathCount <= 0) {
    errors.push(`checkpoint-cumulative-inventory-invalid:${expectedSequence}`);
  }
}

function validateCheckpointContract({
  integrationInventory,
  inventoryResult,
  blocks,
  taskIds,
  stageBApplicability,
  checkpointEvidenceText,
  errors,
}) {
  const campaignStage = integrationInventory?.campaignStage;
  const checkpoint = integrationInventory?.checkpoint;
  const expectedPath = CHECKPOINT_PATHS[campaignStage];
  const checkpointOwnerTaskId = CHECKPOINT_OWNER_TASK_IDS[campaignStage];
  const componentTaskIds = stageComponentTaskIds(campaignStage, taskIds, stageBApplicability);
  const statuses = taskStatusMap(blocks);
  if (checkpoint?.schemaVersion !== CHECKPOINT_STATE_SCHEMA_VERSION) {
    errors.push('checkpoint-state-schema-invalid');
  }
  if (!Number.isSafeInteger(checkpoint?.sequence) || checkpoint.sequence < 0) {
    errors.push('checkpoint-state-sequence-invalid');
  }
  if (checkpoint?.evidencePath !== expectedPath) errors.push('checkpoint-evidence-path-invalid');

  const completedComponents = componentTaskIds.filter((taskId) => statuses.get(taskId) === 'DONE');
  const componentInventoryOwners = [...new Set((integrationInventory?.entries || [])
    .map((entry) => entry?.ownerTaskId)
    .filter((taskId) => componentTaskIds.includes(taskId)))];
  if (checkpoint?.sequence === 0) {
    if (checkpoint.state !== 'PREFANOUT' || checkpoint.acceptedTaskId !== null) {
      errors.push('checkpoint-prefanout-state-invalid');
    }
    if (completedComponents.length > 0) {
      errors.push(`checkpoint-prefanout-completed-component:${completedComponents.join(',')}`);
    }
    if (componentInventoryOwners.length > 0) {
      errors.push(`checkpoint-prefanout-component-path-present:${componentInventoryOwners.join(',')}`);
    }
    return Object.freeze({
      checkpoint,
      ledger: null,
      componentTaskIds,
      completedComponentTaskIds: completedComponents,
      remainingComponentTaskIds: componentTaskIds.filter((taskId) => !completedComponents.includes(taskId)),
    });
  }

  if (checkpoint?.state !== 'CHECKPOINT_GREEN'
    || !componentTaskIds.includes(checkpoint?.acceptedTaskId)) {
    errors.push('checkpoint-green-state-invalid');
  }
  const ledger = parseEvidenceJsonBlock(checkpointEvidenceText, CHECKPOINT_BLOCKS[campaignStage], errors);
  if (!ledger) return Object.freeze({
    checkpoint,
    ledger: null,
    componentTaskIds,
    completedComponentTaskIds: completedComponents,
    remainingComponentTaskIds: componentTaskIds.filter((taskId) => !completedComponents.includes(taskId)),
  });
  if (ledger.schemaVersion !== CHECKPOINT_LEDGER_SCHEMA_VERSION
    || ledger.campaignStage !== campaignStage
    || !Array.isArray(ledger.checkpoints)
    || ledger.checkpoints.length !== checkpoint.sequence) {
    errors.push('checkpoint-ledger-header-invalid');
    return Object.freeze({
      checkpoint,
      ledger,
      componentTaskIds,
      completedComponentTaskIds: completedComponents,
      remainingComponentTaskIds: componentTaskIds.filter((taskId) => !completedComponents.includes(taskId)),
    });
  }
  const acceptedTaskIds = [];
  for (let index = 0; index < ledger.checkpoints.length; index += 1) {
    const row = ledger.checkpoints[index];
    validCheckpointRow(row, index + 1, errors);
    if (row?.integrationReconciliation?.ownerTaskId !== checkpointOwnerTaskId) {
      errors.push(`checkpoint-product-reconciliation-owner-invalid:${index + 1}:${String(row?.integrationReconciliation?.ownerTaskId)}`);
    }
    acceptedTaskIds.push(row?.acceptedTaskId);
    if (!componentTaskIds.includes(row?.acceptedTaskId)) {
      errors.push(`checkpoint-ledger-task-outside-stage:${String(row?.acceptedTaskId)}`);
    }
  }
  if (new Set(acceptedTaskIds).size !== acceptedTaskIds.length) {
    errors.push('checkpoint-ledger-task-duplicate');
  }
  const latest = ledger.checkpoints.at(-1);
  if (latest?.acceptedTaskId !== checkpoint.acceptedTaskId) {
    errors.push('checkpoint-state-latest-task-mismatch');
  }
  for (const taskId of acceptedTaskIds) {
    if (statuses.get(taskId) !== 'DONE') errors.push(`checkpoint-accepted-task-not-done:${taskId}`);
  }
  if (!exactSet(completedComponents, acceptedTaskIds)) {
    errors.push('checkpoint-completed-task-set-mismatch');
  }
  if (componentInventoryOwners.some((taskId) => !acceptedTaskIds.includes(taskId))) {
    errors.push('checkpoint-inventory-owner-not-accepted');
  }
  const checkpointEntry = (integrationInventory?.entries || [])
    .find((entry) => entry?.path === expectedPath);
  if (checkpointEntry?.ownerTaskId !== checkpointOwnerTaskId) {
    errors.push(`checkpoint-evidence-owner-invalid:${String(checkpointEntry?.ownerTaskId || 'MISSING')}:${checkpointOwnerTaskId}`);
  }
  const remainingComponentTaskIds = componentTaskIds
    .filter((taskId) => !completedComponents.includes(taskId));
  if (latest?.cumulativeInventory?.baseSha !== integrationInventory?.baseSha
    || (remainingComponentTaskIds.length > 0
      && (latest?.cumulativeInventory?.stableDigest !== inventoryResult.stableDigest
        || latest?.cumulativeInventory?.pathCount !== inventoryResult.pathCount))) {
    errors.push('checkpoint-cumulative-inventory-mismatch');
  }
  return Object.freeze({
    checkpoint,
    ledger,
    componentTaskIds,
    completedComponentTaskIds: completedComponents,
    remainingComponentTaskIds,
  });
}

function validateTaskHandoffContracts({
  blocks,
  integrationInventory,
  ownership,
  taskIds,
  stageBApplicability,
  errors,
}) {
  const statuses = taskStatusMap(blocks);
  const completedTaskIds = taskIds.filter((taskId) => statuses.get(taskId) === 'DONE');
  const noEditTaskIds = new Set(stageBApplicability?.noEditTaskIds || []);
  const handoffRequiredTaskIds = completedTaskIds.filter((taskId) => !noEditTaskIds.has(taskId));
  const handoffs = integrationInventory?.taskHandoffs;
  if (!handoffs || typeof handoffs !== 'object' || Array.isArray(handoffs)) {
    errors.push('task-handoffs-invalid');
    return Object.freeze({ completedTaskIds, handoffs: {}, inventoryEntries: [] });
  }
  const handoffTaskIds = Object.keys(handoffs);
  if (!exactSet(handoffTaskIds, handoffRequiredTaskIds)) {
    errors.push('task-handoff-completed-set-mismatch');
  }
  for (const [taskId, handoff] of Object.entries(handoffs)) {
    if (noEditTaskIds.has(taskId)) errors.push(`task-handoff-no-edit-forbidden:${taskId}`);
    if (!taskIds.includes(taskId)) errors.push(`task-handoff-task-unknown:${taskId}`);
    if (!validSha1(handoff?.headSha) || !validSha1(handoff?.treeSha)
      || !validRepoPath(handoff?.evidencePath)) {
      errors.push(`task-handoff-row-invalid:${taskId}`);
      continue;
    }
    const evidenceLane = validateTaskInventory({
      taskId,
      actualPaths: [handoff.evidencePath],
      ownership,
    });
    if (!evidenceLane.ok) errors.push(`task-handoff-evidence-outside-owner:${taskId}:${handoff.evidencePath}`);
  }
  return Object.freeze({
    completedTaskIds,
    handoffRequiredTaskIds,
    handoffs,
    inventoryEntries: integrationInventory?.entries || [],
  });
}

function validCandidateGateArg(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 240
    && /^[A-Za-z0-9_./:@=+-]+$/.test(value)
    && !value.includes('..');
}

function validateCandidateGateCommand(taskId, kind, gate, packageJson, errors) {
  if (typeof gate?.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(gate.id)) {
    errors.push(`candidate-gate-id-invalid:${taskId}:${kind}`);
  }
  const argv = gate?.argv;
  if (!Array.isArray(argv) || argv.length < 2 || argv.some((entry) => !validCandidateGateArg(entry))) {
    errors.push(`candidate-gate-argv-invalid:${taskId}:${kind}:${String(gate?.id || 'UNKNOWN')}`);
    return;
  }
  if (argv[0] === 'npm') {
    if (argv.length !== 3 || argv[1] !== 'run' || typeof packageJson?.scripts?.[argv[2]] !== 'string') {
      errors.push(`candidate-gate-npm-script-invalid:${taskId}:${kind}:${String(gate?.id || 'UNKNOWN')}`);
    }
    return;
  }
  if (argv[0] !== 'node') {
    errors.push(`candidate-gate-command-invalid:${taskId}:${kind}:${String(gate?.id || 'UNKNOWN')}`);
    return;
  }
  if (kind === 'shadow') {
    const expected = [
      'node',
      'tools/validation/final-closure/preflight.mjs',
      '--emit-shadow-evidence',
      '--task',
      taskId,
    ];
    if (!exactSet(argv, expected) || argv.some((entry, index) => entry !== expected[index])) {
      errors.push(`candidate-shadow-verifier-path-invalid:${taskId}:${String(gate?.id || 'UNKNOWN')}`);
    }
    return;
  }
  let entryIndex = 1;
  if (argv[entryIndex] === '--test') entryIndex += 1;
  const entryPath = argv[entryIndex];
  const trailingArguments = argv.slice(entryIndex + 1);
  const standardNodeShape = trailingArguments.length <= 1
    && (trailingArguments.length === 0
      || trailingArguments[0] === '--shadow'
      || trailingArguments[0] === '--full');
  const runnerGroupShape = entryIndex === 1
    && typeof entryPath === 'string'
    && /^tests\/[a-z0-9/-]+\/run\.mjs$/.test(entryPath)
    && trailingArguments.length === 2
    && trailingArguments[0] === '--group'
    && /^[a-z0-9][a-z0-9/-]*$/.test(trailingArguments[1])
    && (entryPath !== 'tests/final-closure/run.mjs'
      || (kind === 'owned' && trailingArguments[1] === taskId.toLowerCase()));
  const nodeShapeValid = typeof entryPath === 'string'
    && !entryPath.startsWith('-')
    && (standardNodeShape || runnerGroupShape);
  if (!nodeShapeValid
    || !validRepoPath(entryPath)
    || (!entryPath.startsWith('tests/') && !entryPath.startsWith('tools/validation/'))
    || !entryPath.endsWith('.mjs')) {
    errors.push(`candidate-gate-node-path-invalid:${taskId}:${kind}:${String(gate?.id || 'UNKNOWN')}`);
  }
}

function parseShadowAuthorityJson(shadowAuthority, repoPath, errors) {
  const source = shadowAuthority?.[repoPath];
  if (typeof source !== 'string') {
    errors.push(`candidate-shadow-authority-content-missing:${repoPath}`);
    return null;
  }
  try {
    return JSON.parse(source);
  } catch {
    errors.push(`candidate-shadow-authority-json-invalid:${repoPath}`);
    return null;
  }
}

function shadowContractDefinitionValid(contract, policy, taskId, gateId, ownership) {
  if (!contract
    || !exactSet(Object.keys(contract), [
      'schemaVersion', 'taskId', 'gateId', 'activationRequired', 'cases',
    ])
    || contract.schemaVersion !== SHADOW_CONTRACT_SCHEMA_VERSION
    || contract.taskId !== taskId
    || contract.gateId !== gateId
    || typeof contract.activationRequired !== 'boolean'
    || !Array.isArray(contract.cases)
    || contract.cases.length > 64
    || (!contract.activationRequired && contract.cases.length < policy.minimumCaseCount)) {
    return false;
  }
  const caseIds = [];
  for (const row of contract.cases) {
    const projection = row?.projection;
    if (!row
      || !exactSet(Object.keys(row), [
        'id', 'projection', 'oracleObservation', 'failureCounterIds',
      ])
      || typeof row.id !== 'string'
      || !/^[a-z0-9][a-z0-9._-]*$/.test(row.id)
      || !projection
      || !exactSet(Object.keys(projection), ['kind', 'argv', 'timeoutMs'])
      || projection.kind !== 'process-exit-v1'
      || !Array.isArray(projection.argv)
      || projection.argv.length < 2
      || projection.argv.length > 16
      || projection.argv.some((entry) => !validCandidateGateArg(entry))
      || projection.argv[0] !== 'node'
      || !validRepoPath(projection.argv[1])
      || !projection.argv[1].startsWith('tests/')
      || !projection.argv[1].endsWith('.mjs')
      || pathAllowed(projection.argv[1], ownership?.tasks?.[taskId]?.allowedPaths || [])
      || !Number.isSafeInteger(projection.timeoutMs)
      || projection.timeoutMs < 1
      || projection.timeoutMs > 120000
      || !Array.isArray(row.failureCounterIds)
      || row.failureCounterIds.length === 0
      || !row.failureCounterIds.includes('semanticMismatch')
      || row.failureCounterIds.some((id) => !policy.requiredCounterIds.includes(id))
      || new Set(row.failureCounterIds).size !== row.failureCounterIds.length) {
      return false;
    }
    const expected = row.oracleObservation;
    if (!expected
      || !exactSet(Object.keys(expected), ['exitCode', 'signal', 'errorCode'])
      || expected.exitCode !== 0
      || expected.signal !== null
      || expected.errorCode !== null) {
      return false;
    }
    caseIds.push(row.id);
  }
  return new Set(caseIds).size === caseIds.length;
}

function validateShadowAuthorityDefinition({
  ownership,
  componentTaskIds,
  shadowPolicy,
  shadowAuthority,
  errors,
}) {
  const expectedPolicyKeys = [
    'schemaVersion',
    'verifierPath',
    'proofSchemaVersion',
    'rawObservationSchemaVersion',
    'comparisonAlgorithm',
    'requiredCounterIds',
    'minimumCaseCount',
    'authorityArtifacts',
  ];
  if (!shadowPolicy
    || !exactSet(Object.keys(shadowPolicy), expectedPolicyKeys)
    || shadowPolicy.schemaVersion !== SHADOW_POLICY_SCHEMA_VERSION
    || shadowPolicy.verifierPath !== 'tools/validation/final-closure/preflight.mjs'
    || shadowPolicy.proofSchemaVersion !== SHADOW_PROOF_SCHEMA_VERSION
    || shadowPolicy.rawObservationSchemaVersion !== SHADOW_RAW_OBSERVATION_SCHEMA_VERSION
    || shadowPolicy.comparisonAlgorithm !== SHADOW_COMPARISON_ALGORITHM
    || !exactSet(shadowPolicy.requiredCounterIds, HARD_CORRECTNESS_COUNTER_IDS)
    || shadowPolicy.minimumCaseCount !== 1
    || !Array.isArray(shadowPolicy.authorityArtifacts)
    || shadowPolicy.authorityArtifacts.length !== SHADOW_AUTHORITY_ARTIFACTS.length) {
    errors.push('candidate-shadow-policy-invalid');
    return Object.freeze({ registry: null, contracts: null });
  }

  for (let index = 0; index < SHADOW_AUTHORITY_ARTIFACTS.length; index += 1) {
    const expected = SHADOW_AUTHORITY_ARTIFACTS[index];
    const artifact = shadowPolicy.authorityArtifacts[index];
    if (!artifact
      || !exactSet(Object.keys(artifact), ['role', 'path', 'sha256'])
      || artifact.role !== expected.role
      || artifact.path !== expected.path
      || !validSha256(artifact.sha256)) {
      errors.push(`candidate-shadow-authority-pin-invalid:${expected.role}`);
      continue;
    }
    const source = shadowAuthority?.[artifact.path];
    if (typeof source !== 'string' || sha256Text(source) !== artifact.sha256) {
      errors.push(`candidate-shadow-authority-content-mismatch:${expected.role}`);
    }
    if (!pathAllowed(artifact.path, ownership?.tasks?.T046?.allowedPaths || [])) {
      errors.push(`candidate-shadow-authority-owner-invalid:${expected.role}:T046`);
    }
    for (const taskId of componentTaskIds) {
      if (pathAllowed(artifact.path, ownership?.tasks?.[taskId]?.allowedPaths || [])) {
        errors.push(`candidate-shadow-authority-component-owned:${taskId}:${expected.role}`);
      }
    }
  }

  const registryPath = SHADOW_AUTHORITY_ARTIFACTS[0].path;
  const contractsPath = SHADOW_AUTHORITY_ARTIFACTS[1].path;
  const registry = parseShadowAuthorityJson(shadowAuthority, registryPath, errors);
  const contracts = parseShadowAuthorityJson(shadowAuthority, contractsPath, errors);
  if (!registry
    || !exactSet(Object.keys(registry), [
      'schemaVersion', 'rawObservationSchemaVersion', 'comparisonAlgorithm',
      'contractPath', 'providers', 'tasks',
    ])
    || registry.schemaVersion !== SHADOW_AUTHORITY_REGISTRY_SCHEMA_VERSION
    || registry.rawObservationSchemaVersion !== SHADOW_RAW_OBSERVATION_SCHEMA_VERSION
    || registry.comparisonAlgorithm !== SHADOW_COMPARISON_ALGORITHM
    || registry.contractPath !== contractsPath
    || !registry.providers
    || !exactSet(Object.keys(registry.providers), ['oracle', 'product'])
    || !registry.tasks
    || typeof registry.tasks !== 'object'
    || Array.isArray(registry.tasks)
    || !exactSet(Object.keys(registry.tasks || {}), INITIAL_COMPONENT_TASK_IDS)) {
    errors.push('candidate-shadow-authority-registry-invalid');
  } else {
    for (const [role, authorityRole] of [['oracle', 'oracleProvider'], ['product', 'productProvider']]) {
      const provider = registry.providers[role];
      const expectedPath = SHADOW_AUTHORITY_ARTIFACTS.find(
        (artifact) => artifact.role === authorityRole,
      )?.path;
      if (!provider
        || !exactSet(Object.keys(provider), ['path', 'argv'])
        || provider.path !== expectedPath
        || !Array.isArray(provider.argv)
        || provider.argv.length !== 2
        || provider.argv[0] !== 'node'
        || provider.argv[1] !== provider.path) {
        errors.push(`candidate-shadow-provider-registry-invalid:${role}`);
      }
    }
  }

  if (!contracts
    || !exactSet(Object.keys(contracts), ['schemaVersion', 'contracts'])
    || contracts.schemaVersion !== SHADOW_CONTRACTS_SCHEMA_VERSION
    || !contracts.contracts
    || typeof contracts.contracts !== 'object'
    || Array.isArray(contracts.contracts)) {
    errors.push('candidate-shadow-contracts-invalid');
  } else {
    const contractIds = [];
    const mappedCounterIds = new Set();
    for (const taskId of INITIAL_COMPONENT_TASK_IDS) {
      const binding = registry?.tasks?.[taskId];
      const shadowGates = ownership?.candidateGates?.tasks?.[taskId]?.shadow;
      if (!binding
        || !exactSet(Object.keys(binding), ['gateId', 'contractId'])
        || typeof binding.contractId !== 'string'
        || !Array.isArray(shadowGates)
        || shadowGates.length !== 1
        || binding.gateId !== shadowGates[0]?.id) {
        errors.push(`candidate-shadow-task-binding-invalid:${taskId}`);
        continue;
      }
      contractIds.push(binding.contractId);
      const contract = contracts.contracts[binding.contractId];
      if (!shadowContractDefinitionValid(
        contract, shadowPolicy, taskId, binding.gateId, ownership,
      )) {
        errors.push(`candidate-shadow-contract-invalid:${taskId}`);
      } else if (contract.activationRequired) {
        errors.push(`candidate-shadow-contract-activation-required:${taskId}`);
      } else {
        for (const row of contract.cases) {
          for (const counterId of row.failureCounterIds) mappedCounterIds.add(counterId);
        }
      }
    }
    if (!exactSet(Object.keys(contracts.contracts), contractIds)
      || new Set(contractIds).size !== contractIds.length) {
      errors.push('candidate-shadow-contract-set-invalid');
    }
    for (const counterId of shadowPolicy.requiredCounterIds) {
      if (!mappedCounterIds.has(counterId)) {
        errors.push(`candidate-shadow-counter-unmapped:${counterId}`);
      }
    }
  }
  return Object.freeze({ registry, contracts });
}

function validateDynamicShadowGate(ownership, taskId, gate, shadowPolicy, errors) {
  if (!gate
    || !exactSet(Object.keys(gate), ['id', 'argv', 'contract', 'contractSha256'])
    || !validSha256(gate.contractSha256)
    || gate.contractSha256 !== sha256Text(canonicalJson(gate.contract))) {
    errors.push(`candidate-shadow-dynamic-pin-invalid:${taskId}`);
    return;
  }
  if (!shadowContractDefinitionValid(gate.contract, shadowPolicy, taskId, gate.id, ownership)) {
    errors.push(`candidate-shadow-contract-invalid:${taskId}`);
  } else if (gate.contract.activationRequired) {
    errors.push(`candidate-shadow-contract-activation-required:${taskId}`);
  }
}

function validateCandidateGateRegistry({ ownership, taskIds, packageJson, shadowAuthority, errors }) {
  const registry = ownership?.candidateGates;
  if (registry?.schemaVersion !== 'hex-final-closure-candidate-gates/v1'
    || !registry?.tasks || typeof registry.tasks !== 'object' || Array.isArray(registry.tasks)) {
    errors.push('candidate-gate-registry-schema-invalid');
    return Object.freeze({ registry, initialDigest: null, componentTaskIds: [] });
  }
  const dynamicTaskIds = taskIds.filter((taskId) => Number(taskId.slice(1)) >= 51);
  const componentTaskIds = [...INITIAL_COMPONENT_TASK_IDS, ...dynamicTaskIds];
  const shadowPolicy = registry?.shadowEvidence;
  validateShadowAuthorityDefinition({
    ownership,
    componentTaskIds,
    shadowPolicy,
    shadowAuthority,
    errors,
  });
  if (!exactSet(Object.keys(registry.tasks), componentTaskIds)) {
    errors.push('candidate-gate-task-set-invalid');
  }
  const gateIds = [];
  for (const taskId of componentTaskIds) {
    const taskGates = registry.tasks[taskId];
    if (!taskGates || typeof taskGates !== 'object'
      || !exactSet(Object.keys(taskGates), ['owned', 'rolling', 'shadow'])) {
      errors.push(`candidate-gate-kinds-invalid:${taskId}`);
      continue;
    }
    for (const kind of ['owned', 'rolling', 'shadow']) {
      const gates = taskGates[kind];
      if (!Array.isArray(gates) || gates.length === 0) {
        errors.push(`candidate-gate-kind-empty:${taskId}:${kind}`);
        continue;
      }
      for (const gate of gates) {
        const expectedKeys = kind === 'shadow' && dynamicTaskIds.includes(taskId)
          ? ['id', 'argv', 'contract', 'contractSha256']
          : ['id', 'argv'];
        if (!gate || !exactSet(Object.keys(gate), expectedKeys)) {
          errors.push(`candidate-gate-row-invalid:${taskId}:${kind}`);
        }
        validateCandidateGateCommand(taskId, kind, gate, packageJson, errors);
        if (kind === 'shadow' && dynamicTaskIds.includes(taskId)) {
          validateDynamicShadowGate(ownership, taskId, gate, shadowPolicy, errors);
        }
        gateIds.push(gate?.id);
      }
    }
  }
  if (gateIds.some((id) => typeof id !== 'string') || new Set(gateIds).size !== gateIds.length) {
    errors.push('candidate-gate-id-duplicate');
  }
  const initialDigest = computeInitialCandidateGateDigest(ownership);
  if (initialDigest !== FROZEN_INITIAL_CANDIDATE_GATE_DIGEST) {
    errors.push('candidate-gate-initial-digest-mismatch');
  }
  return Object.freeze({ registry, initialDigest, componentTaskIds });
}

export function validatePreflightContracts({
  tasksText,
  ownership,
  integrationInventory,
  platformLocks,
  performanceLocks,
  workflowText,
  preFanoutText,
  stageAPostMergeText = null,
  stageBPreflightText = null,
  stageBResidualCoverageText = null,
  roadmapMatrixText = null,
  roadmapMatrixSha256 = null,
  roadmapMatrixHandoffSha256 = null,
  checkpointEvidenceText = null,
  packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')),
  shadowAuthority = Object.fromEntries(SHADOW_AUTHORITY_ARTIFACTS.map(({ path: repoPath }) => [
    repoPath,
    fs.readFileSync(path.join(ROOT, repoPath), 'utf8'),
  ])),
  actualChangedPaths = null,
  expectedBaseSha = null,
}) {
  const errors = [];
  const blocks = taskBlocks(tasksText);
  const parsedTaskIds = blocks.map((block) => block.match(/^- \[[ x]\] (T\d{3})\b/m)?.[1]).filter(Boolean);
  const taskIds = [...parsedTaskIds].sort();
  const highestTaskNumber = Math.max(0, ...parsedTaskIds.map((taskId) => Number(taskId.slice(1))));
  const contiguousTaskIds = Array.from(
    { length: highestTaskNumber },
    (_, index) => `T${String(index + 1).padStart(3, '0')}`,
  );

  if (highestTaskNumber < EXPECTED_TASK_IDS.length || !exactSet(parsedTaskIds, contiguousTaskIds)) {
    errors.push('tasks-id-set-mismatch');
  }
  for (const block of blocks) {
    const taskId = block.match(/^- \[[ x]\] (T\d{3})\b/m)?.[1] || 'UNKNOWN';
    errors.push(...taskContractErrors(block, taskId));
  }

  if (ownership?.schemaVersion !== 'hex-final-closure-task-ownership/v1') {
    errors.push('ownership-schema-invalid');
  }
  if (!Array.isArray(ownership?.globalForbidden) || ownership.globalForbidden.length === 0) {
    errors.push('ownership-global-forbidden-empty');
  } else if (ownership.globalForbidden.some((entry) => typeof entry !== 'string' || entry.trim() === '')) {
    errors.push('ownership-global-forbidden-invalid');
  } else if (new Set(ownership.globalForbidden).size !== ownership.globalForbidden.length) {
    errors.push('ownership-global-forbidden-duplicate');
  }
  const ownershipIds = Object.keys(ownership?.tasks || {});
  if (!exactSet(ownershipIds, parsedTaskIds)) errors.push('ownership-task-set-mismatch');
  const foundationOwnershipDigest = computeFoundationOwnershipDigest(ownership);
  if (foundationOwnershipDigest !== FROZEN_FOUNDATION_OWNERSHIP_DIGEST) {
    errors.push('ownership-foundation-digest-mismatch');
  }
  for (const taskId of taskIds) {
    const row = ownership?.tasks?.[taskId];
    const entries = row?.forbiddenOverlap;
    if (!Array.isArray(entries) || entries.length === 0) {
      errors.push(`ownership-forbidden-overlap-empty:${taskId}`);
    } else if (entries.some((entry) => typeof entry !== 'string' || entry.trim() === '')) {
      errors.push(`ownership-forbidden-overlap-invalid:${taskId}`);
    }
    if (!Array.isArray(row?.allowedPaths) || row.allowedPaths.length === 0) {
      errors.push(`ownership-allowed-paths-empty:${taskId}`);
    } else if (row.allowedPaths.some((entry) => !validAllowPattern(entry))) {
      errors.push(`ownership-allowed-paths-invalid:${taskId}`);
    } else if (new Set(row.allowedPaths).size !== row.allowedPaths.length) {
      errors.push(`ownership-allowed-paths-duplicate:${taskId}`);
    }
  }
  for (const [taskId, fragments] of Object.entries(SPECIAL_OWNERSHIP_RULES)) {
    for (const fragment of fragments) {
      if (!overlapContains(ownership, taskId, fragment)) {
        errors.push(`ownership-special-rule-missing:${taskId}:${fragment}`);
      }
    }
  }
  errors.push(...dependencyErrors(blocks, taskIds));
  errors.push(...concurrentOwnershipErrors(blocks, ownership));

  const stageBApplicability = validateStageBApplicability({
    campaignStage: integrationInventory?.campaignStage,
    blocks,
    taskIds,
    integrationInventory,
    stageBResidualCoverageText,
    roadmapMatrixText,
    roadmapMatrixSha256,
    roadmapMatrixHandoffSha256,
    errors,
  });
  const inventoryResult = validateIntegrationInventory({
    integrationInventory,
    ownership,
    taskIds,
    actualChangedPaths,
    expectedBaseSha,
  });
  errors.push(...inventoryResult.errors);
  validateStageBInitialInventory(integrationInventory, blocks, errors);
  const checkpointResult = validateCheckpointContract({
    integrationInventory,
    inventoryResult,
    blocks,
    taskIds,
    stageBApplicability,
    checkpointEvidenceText,
    errors,
  });
  const taskHandoffResult = validateTaskHandoffContracts({
    blocks,
    integrationInventory,
    ownership,
    taskIds,
    stageBApplicability,
    errors,
  });
  const candidateGateResult = validateCandidateGateRegistry({
    ownership,
    taskIds,
    packageJson,
    shadowAuthority,
    errors,
  });
  const originalWorkspaceLock = validateOriginalWorkspaceLock(preFanoutText, errors);
  const stageEvidence = validateStageBEvidence({
    integrationInventory,
    stageAPostMergeText,
    stageBPreflightText,
    originalWorkspaceLock: originalWorkspaceLock.workspace,
    errors,
  });

  for (const taskId of ['T011', 'T012', 'T013', 'T014', 'T015', 'T016', 'T017']) {
    const block = blocks.find((candidate) => new RegExp(`^- \\[[ x]\\] ${taskId}\\b`).test(candidate)) || '';
    if (!/Dependencies:[^.]*T046/.test(block)) errors.push(`prefanout-dependency-missing:${taskId}:T046`);
  }
  if (!String(tasksText || '').includes('After T046 is PREFLIGHT_GREEN:')) {
    errors.push('prefanout-execution-gate-missing');
  }

  const workflow = String(workflowText || '');
  const workflowSha256 = sha256Text(workflow);
  if (workflowSha256 !== EXPECTED_WORKFLOW_SHA256) {
    errors.push(`workflow-content-digest-mismatch:${workflowSha256}:${EXPECTED_WORKFLOW_SHA256}`);
  }
  if (!workflow.includes('github.event.pull_request.head.sha')) errors.push('workflow-pr-head-not-exact');
  if (!workflow.includes('github.event.pull_request.base.sha')) errors.push('workflow-pr-base-not-exact');
  if (!workflow.includes('--expect-sha "$EXPECT_SHA" --expect-base-sha "$EXPECT_BASE_SHA"')) {
    errors.push('workflow-exact-sha-invocation-missing');
  }
  if (!workflow.includes('node tests/final-closure/run.mjs')) errors.push('workflow-canonical-runner-missing');
  if (!workflow.includes('node tests/phase4/walking-skeleton.test.mjs')) errors.push('workflow-production-skeleton-missing');
  if (!workflow.includes("startsWith(github.head_ref, 'recovery/final-closure-')")
    || !workflow.includes("startsWith(github.head_ref, 'analysis/final-closure-')")
    || !workflow.includes("github.base_ref == 'main'")) {
    errors.push('workflow-campaign-scope-gate-missing');
  }
  if (!workflow.includes("startsWith(github.head_ref, 'component/final-closure-t')")
    || !workflow.includes("startsWith(github.base_ref, 'recovery/final-closure-')")
    || !workflow.includes("startsWith(github.base_ref, 'analysis/final-closure-')")
    || !workflow.includes('node tools/validation/final-closure/preflight.mjs --prepare-component-candidate')
    || !workflow.includes('node tools/validation/final-closure/preflight.mjs --run-component-gates')
    || !workflow.includes('run: npm ci --no-audit --no-fund')
    || !workflow.includes('timeout-minutes: 45')) {
    errors.push('workflow-component-candidate-path-missing');
  }
  if (!workflow.includes('workflow_dispatch:')
    || !workflow.includes('expect_sha:')
    || !workflow.includes('expect_base_sha:')) {
    errors.push('workflow-manual-exact-sha-path-missing');
  }
  if (!workflow.includes('pull-request-authority:')
    || !workflow.includes('Reject unauthorized final-closure PR relationship')
    || (workflow.match(/needs: pull-request-authority/g) || []).length !== 2) {
    errors.push('workflow-pull-request-authority-gate-missing');
  }
  if ((workflow.match(/--run-checkpoint-verification/g) || []).length !== 3
    || (workflow.match(/npm ci --no-audit --no-fund/g) || []).length !== 3) {
    errors.push('workflow-checkpoint-runtime-gate-missing');
  }
  if ((workflow.match(/actions\/checkout@11d5960a326750d5838078e36cf38b85af677262/g) || []).length !== 3
    || (workflow.match(/actions\/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020/g) || []).length !== 3) {
    errors.push('workflow-action-pin-invalid');
  }
  if ((workflow.match(/persist-credentials: false/g) || []).length !== 3) {
    errors.push('workflow-checkout-credentials-persist');
  }

  const preMortemRows = [...String(preFanoutText || '').matchAll(
    /^\| (EP-\d{3}) \| (APPLICABLE|N\/A) \| ([^|\n]+) \|$/gm,
  )];
  const preMortemIds = preMortemRows.map((match) => match[1]);
  if (!exactSet(preMortemIds, EXPECTED_EP_IDS)) errors.push('premortem-ep-set-invalid');
  if (preMortemRows.some((match) => match[3].trim().length < 20)) errors.push('premortem-gate-rationale-empty');

  const { runtimeClasses, workloads } = validateFrozenPlatform(platformLocks, errors);
  const performance = validateFrozenPerformance(performanceLocks, errors);

  return Object.freeze({
    ok: errors.length === 0,
    errors: Object.freeze(errors),
    taskIds: Object.freeze(taskIds),
    requiredRuntimeClassCount: runtimeClasses.length,
    requiredWorkloadCount: Array.isArray(workloads) ? workloads.filter((row) => row?.required === true).length : 0,
    integrationPathCount: inventoryResult.pathCount,
    integrationInventoryDigest: inventoryResult.stableDigest,
    integrationBaseSha: integrationInventory?.baseSha ?? null,
    foundationOwnershipDigest,
    performanceProfileCount: performance.profileIds.length,
    stageEvidence,
    checkpointResult,
    taskHandoffResult,
    stageBApplicability,
    candidateGateResult,
    originalWorkspaceLock,
  });
}

function runGit(root, args, { encoding = 'utf8', env = process.env } = {}) {
  return spawnSync('git', args, {
    cwd: root,
    encoding,
    env,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function git(root, args, options) {
  const result = runGit(root, args, options);
  if (result.status !== 0) {
    const diagnostic = result.stderr == null ? '' : String(result.stderr).trim();
    throw new Error(diagnostic || `git ${args.join(' ')} failed`);
  }
  return String(result.stdout).trim();
}

function readJson(root, relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
}

function readTextAt(root, commitSha, relativePath) {
  const result = runGit(root, ['show', `${commitSha}:${relativePath}`]);
  if (result.status !== 0) {
    const diagnostic = result.stderr == null ? '' : String(result.stderr).trim();
    throw new Error(diagnostic || `git show ${commitSha}:${relativePath} failed`);
  }
  return String(result.stdout);
}

function readOptionalText(root, relativePath, commitSha = null) {
  if (commitSha == null) {
    const target = path.join(root, relativePath);
    return fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
  }
  const result = runGit(root, ['show', `${commitSha}:${relativePath}`]);
  return result.status === 0 ? result.stdout : null;
}

function readJsonAt(root, commitSha, relativePath) {
  return JSON.parse(readTextAt(root, commitSha, relativePath));
}

function blobEvidenceAt(root, commitSha, relativePath) {
  const gitBlobSha1 = git(root, ['rev-parse', `${commitSha}:${relativePath}`]);
  const content = runGit(root, ['cat-file', 'blob', gitBlobSha1], { encoding: null });
  if (content.status !== 0 || !Buffer.isBuffer(content.stdout)) {
    throw new Error(`checkpoint-blob-missing:${relativePath}`);
  }
  return Object.freeze({
    path: relativePath,
    gitBlobSha1,
    sha256: createHash('sha256').update(content.stdout).digest('hex'),
  });
}

function optionalBlobEvidenceAt(root, commitSha, relativePath) {
  try {
    return blobEvidenceAt(root, commitSha, relativePath);
  } catch {
    return null;
  }
}

function worktreeBlobEvidence(root, relativePath) {
  const content = fs.readFileSync(path.join(root, relativePath));
  const gitBlobSha1 = createHash('sha1')
    .update(`blob ${content.length}\0`)
    .update(content)
    .digest('hex');
  const trackedBlob = runGit(root, ['rev-parse', `HEAD:${relativePath}`]);
  if (trackedBlob.status !== 0 || String(trackedBlob.stdout).trim() !== gitBlobSha1) {
    throw new Error(`shadow-worktree-blob-not-exact-head:${relativePath}`);
  }
  return Object.freeze({
    path: relativePath,
    gitBlobSha1,
    sha256: createHash('sha256').update(content).digest('hex'),
  });
}

export function checkpointGenerationEvidence(root, {
  acceptedMerge,
  checkpointProduct,
  integrationReconciliation,
}) {
  if (!validSha1(acceptedMerge?.commitSha) || !validSha1(acceptedMerge?.treeSha)
    || !validSha1(checkpointProduct?.commitSha) || !validSha1(checkpointProduct?.treeSha)) {
    throw new Error('checkpoint-generation-candidate-invalid');
  }
  const generator = blobEvidenceAt(root, checkpointProduct.commitSha, 'scripts/build-userscript.mjs');
  const releaseBlob = blobEvidenceAt(root, checkpointProduct.commitSha, 'userscript/release-version.json');
  const release = readJsonAt(root, checkpointProduct.commitSha, 'userscript/release-version.json');
  if (!Number.isSafeInteger(release?.serial) || release.serial < 1
    || !validSha256(release?.releaseIdentity)
    || !/^[0-9a-f]{24}$/.test(String(release?.buildId || ''))) {
    throw new Error('checkpoint-generation-release-invalid');
  }
  const generatedBlobs = CHECKPOINT_GENERATED_PATHS
    .map((relativePath) => blobEvidenceAt(root, checkpointProduct.commitSha, relativePath));
  if (integrationReconciliation?.schemaVersion !== PRODUCT_RECONCILIATION_SCHEMA_VERSION
    || integrationReconciliation.mergeCommitSha !== acceptedMerge.commitSha
    || integrationReconciliation.productCommitSha !== checkpointProduct.commitSha
    || !Array.isArray(integrationReconciliation.paths)
    || integrationReconciliation.pathCount !== integrationReconciliation.paths.length
    || integrationReconciliation.stableDigest !== stableDigest([...integrationReconciliation.paths].sort())) {
    throw new Error('checkpoint-generation-reconciliation-invalid');
  }
  const sourceIdentity = sha256Text(canonicalJson({
    acceptedMerge,
    checkpointProduct,
    reconciliationStableDigest: integrationReconciliation.stableDigest,
    generator,
  }));
  const buildIdentity = sha256Text(canonicalJson({
    releaseBlob,
    serial: release.serial,
    releaseIdentity: release.releaseIdentity,
    buildId: release.buildId,
  }));
  const artifactIdentity = sha256Text(canonicalJson(generatedBlobs));
  return Object.freeze({
    schemaVersion: 'hex-final-closure-checkpoint-generation-evidence/v1',
    command: 'node scripts/build-userscript.mjs',
    firstRunDiffEmpty: true,
    secondRunDiffEmpty: true,
    candidateIdentity: Object.freeze({
      headSha: checkpointProduct.commitSha,
      treeSha: checkpointProduct.treeSha,
    }),
    generator,
    generatedBlobs: Object.freeze(generatedBlobs),
    sourceIdentity,
    buildIdentity,
    artifactIdentity,
    releaseIdentity: release.releaseIdentity,
    buildId: release.buildId,
    releaseSerial: release.serial,
  });
}

function rollingRegistryEvidence(root, ownership, taskIds, candidateIdentity) {
  const registryArtifact = blobEvidenceAt(
    root,
    candidateIdentity.headSha,
    'specs/005-analysis-final-closure/contracts/task-ownership.json',
  );
  return Object.freeze({
    path: registryArtifact.path,
    sourceCommitSha: candidateIdentity.headSha,
    sourceTreeSha: candidateIdentity.treeSha,
    gitBlobSha1: registryArtifact.gitBlobSha1,
    sha256: registryArtifact.sha256,
    initialCandidateGateDigest: computeInitialCandidateGateDigest(ownership),
    rollingSetDigest: stableDigest(taskIds.map((taskId) => ({
      taskId,
      rolling: ownership?.candidateGates?.tasks?.[taskId]?.rolling,
    }))),
  });
}

function rollingStreamEvidence(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value == null ? '' : String(value));
  if (bytes.length > ROLLING_GATE_OUTPUT_LIMIT_BYTES) {
    throw new Error('checkpoint-rolling-output-limit-exceeded');
  }
  return Object.freeze({
    byteLength: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
}

function freezeRollingResult(value) {
  return Object.freeze({
    ...value,
    registeredArgv: Object.freeze([...value.registeredArgv]),
    executedArgv: Object.freeze([...value.executedArgv]),
    candidateIdentity: Object.freeze({ ...value.candidateIdentity }),
    process: Object.freeze({ ...value.process }),
    stdout: Object.freeze({ ...value.stdout }),
    stderr: Object.freeze({ ...value.stderr }),
  });
}

export function executeRollingProductGates({
  root = ROOT,
  ownership,
  ownershipCommitSha,
  taskIds,
  candidateIdentity,
  spawn = spawnSync,
  environment = process.env,
  assertCandidateState = null,
} = {}) {
  const rollingTasks = Array.isArray(taskIds) ? taskIds : [];
  const gateRows = rollingTasks.flatMap((taskId) => {
    const gates = ownership?.candidateGates?.tasks?.[taskId]?.rolling;
    return Array.isArray(gates) ? gates.map((gate) => ({ taskId, gate })) : [];
  });
  if (rollingTasks.length === 0
    || new Set(rollingTasks).size !== rollingTasks.length
    || gateRows.length === 0
    || rollingTasks.some((taskId) => {
      const gates = ownership?.candidateGates?.tasks?.[taskId]?.rolling;
      return !Array.isArray(gates) || gates.length === 0;
    })
    || ownershipCommitSha !== candidateIdentity?.headSha
    || !validSha1(candidateIdentity?.headSha)
    || !validSha1(candidateIdentity?.treeSha)
    || git(root, ['rev-parse', 'HEAD']) !== candidateIdentity.headSha
    || git(root, ['rev-parse', 'HEAD^{tree}']) !== candidateIdentity.treeSha) {
    throw new Error('checkpoint-rolling-evidence-input-invalid');
  }
  const assertState = typeof assertCandidateState === 'function'
    ? assertCandidateState
    : () => {
      const headSha = git(root, ['rev-parse', 'HEAD']);
      const treeSha = git(root, ['rev-parse', 'HEAD^{tree}']);
      const status = git(root, ['status', '--porcelain', '--untracked-files=all']);
      if (headSha !== candidateIdentity.headSha
        || treeSha !== candidateIdentity.treeSha
        || status !== '') {
        throw new Error(`checkpoint-rolling-candidate-state-invalid:${rollingTasks.join(',')}`);
      }
    };
  const results = [];
  for (const { taskId, gate } of gateRows) {
    assertState(`rolling-${gate.id}-before`);
    const refsBefore = persistentRefSnapshot(root);
    const executedArgv = [...gate.argv];
    const child = spawn(executedArgv[0], executedArgv.slice(1), {
      cwd: root,
      env: { ...process.env, ...environment },
      shell: false,
      encoding: null,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: ROLLING_GATE_OUTPUT_LIMIT_BYTES,
    });
    const refsAfter = persistentRefSnapshot(root);
    assertOnlyAllowedRefChanges(refsBefore, refsAfter, []);
    assertState(`rolling-${gate.id}-after`);
    const processEvidence = {
      exitCode: Number.isInteger(child?.status) ? child.status : null,
      signal: child?.signal ?? null,
      spawnErrorCode: child?.error?.code ?? null,
      outputLimitExceeded: child?.error?.code === 'ENOBUFS',
    };
    if (processEvidence.exitCode !== 0
      || processEvidence.signal !== null
      || processEvidence.spawnErrorCode !== null
      || processEvidence.outputLimitExceeded) {
      throw new Error(`checkpoint-rolling-gate-failed:${taskId}:${gate.id}:${String(processEvidence.exitCode ?? processEvidence.spawnErrorCode ?? processEvidence.signal)}`);
    }
    const resultWithoutIdentity = {
      taskId,
      gateId: gate.id,
      registeredArgv: [...gate.argv],
      registeredArgvDigest: stableDigest(gate.argv),
      executedArgv,
      executedArgvDigest: stableDigest(executedArgv),
      candidateIdentity: { ...candidateIdentity },
      process: processEvidence,
      stdout: rollingStreamEvidence(child.stdout),
      stderr: rollingStreamEvidence(child.stderr),
      status: 'PASS',
    };
    results.push(freezeRollingResult({
      ...resultWithoutIdentity,
      identity: sha256Text(canonicalJson(resultWithoutIdentity)),
    }));
  }
  const envelope = {
    schemaVersion: 'hex-final-closure-checkpoint-rolling-evidence/v2',
    taskIds: [...rollingTasks],
    status: 'PASS',
    candidateIdentity: { ...candidateIdentity },
    registry: rollingRegistryEvidence(root, ownership, rollingTasks, candidateIdentity),
    results,
  };
  return Object.freeze({
    ...envelope,
    taskIds: Object.freeze([...envelope.taskIds]),
    candidateIdentity: Object.freeze({ ...envelope.candidateIdentity }),
    registry: Object.freeze({ ...envelope.registry }),
    results: Object.freeze(results),
    identity: sha256Text(canonicalJson(envelope)),
  });
}

function verifyRecordedRollingProductEvidence(root, ownership, taskIds, candidateIdentity, evidence) {
  const rollingTasks = Array.isArray(taskIds) ? taskIds : [];
  const gateRows = rollingTasks.flatMap((taskId) => {
    const gates = ownership?.candidateGates?.tasks?.[taskId]?.rolling;
    return Array.isArray(gates) ? gates.map((gate) => ({ taskId, gate })) : [];
  });
  const expectedRegistry = rollingRegistryEvidence(root, ownership, rollingTasks, candidateIdentity);
  if (rollingTasks.length === 0
    || new Set(rollingTasks).size !== rollingTasks.length
    || gateRows.length === 0
    || rollingTasks.some((taskId) => {
      const gates = ownership?.candidateGates?.tasks?.[taskId]?.rolling;
      return !Array.isArray(gates) || gates.length === 0;
    })
    || !evidence
    || !exactSet(Object.keys(evidence), [
      'schemaVersion', 'taskIds', 'status', 'candidateIdentity', 'registry', 'results', 'identity',
    ])
    || evidence.schemaVersion !== 'hex-final-closure-checkpoint-rolling-evidence/v2'
    || canonicalJson(evidence.taskIds) !== canonicalJson(rollingTasks)
    || evidence.status !== 'PASS'
    || canonicalJson(evidence.candidateIdentity) !== canonicalJson(candidateIdentity)
    || canonicalJson(evidence.registry) !== canonicalJson(expectedRegistry)
    || !Array.isArray(evidence.results)
    || evidence.results.length !== gateRows.length) {
    throw new Error('checkpoint-rolling-evidence-invalid');
  }
  for (let index = 0; index < gateRows.length; index += 1) {
    const { taskId, gate } = gateRows[index];
    const row = evidence.results[index];
    if (!row
      || !exactSet(Object.keys(row), [
        'taskId', 'gateId', 'registeredArgv', 'registeredArgvDigest', 'executedArgv', 'executedArgvDigest',
        'candidateIdentity', 'process', 'stdout', 'stderr', 'status', 'identity',
      ])
      || row.taskId !== taskId
      || row.gateId !== gate.id
      || canonicalJson(row.registeredArgv) !== canonicalJson(gate.argv)
      || canonicalJson(row.executedArgv) !== canonicalJson(gate.argv)
      || row.registeredArgvDigest !== stableDigest(gate.argv)
      || row.executedArgvDigest !== stableDigest(gate.argv)
      || canonicalJson(row.candidateIdentity) !== canonicalJson(candidateIdentity)
      || !exactSet(Object.keys(row.process || {}), [
        'exitCode', 'signal', 'spawnErrorCode', 'outputLimitExceeded',
      ])
      || row.process.exitCode !== 0
      || row.process.signal !== null
      || row.process.spawnErrorCode !== null
      || row.process.outputLimitExceeded !== false
      || !exactSet(Object.keys(row.stdout || {}), ['byteLength', 'sha256'])
      || !exactSet(Object.keys(row.stderr || {}), ['byteLength', 'sha256'])
      || !Number.isSafeInteger(row.stdout.byteLength)
      || row.stdout.byteLength < 0
      || row.stdout.byteLength > ROLLING_GATE_OUTPUT_LIMIT_BYTES
      || !validSha256(row.stdout.sha256)
      || !Number.isSafeInteger(row.stderr.byteLength)
      || row.stderr.byteLength < 0
      || row.stderr.byteLength > ROLLING_GATE_OUTPUT_LIMIT_BYTES
      || !validSha256(row.stderr.sha256)
      || row.status !== 'PASS') {
      throw new Error(`checkpoint-rolling-result-invalid:${taskId}:${String(gate?.id)}`);
    }
    const { identity, ...resultWithoutIdentity } = row;
    if (identity !== sha256Text(canonicalJson(resultWithoutIdentity))) {
      throw new Error(`checkpoint-rolling-result-identity-invalid:${taskId}:${gate.id}`);
    }
  }
  const { identity, ...envelopeWithoutIdentity } = evidence;
  if (identity !== sha256Text(canonicalJson(envelopeWithoutIdentity))) {
    throw new Error('checkpoint-rolling-evidence-identity-invalid');
  }
  return evidence;
}

function rollingReplayContract(evidence) {
  return Object.freeze({
    schemaVersion: evidence.schemaVersion,
    taskIds: Object.freeze([...evidence.taskIds]),
    status: evidence.status,
    candidateIdentity: Object.freeze({ ...evidence.candidateIdentity }),
    registry: Object.freeze({ ...evidence.registry }),
    results: Object.freeze(evidence.results.map((row) => Object.freeze({
      taskId: row.taskId,
      gateId: row.gateId,
      registeredArgv: Object.freeze([...row.registeredArgv]),
      registeredArgvDigest: row.registeredArgvDigest,
      executedArgv: Object.freeze([...row.executedArgv]),
      executedArgvDigest: row.executedArgvDigest,
      candidateIdentity: Object.freeze({ ...row.candidateIdentity }),
      process: Object.freeze({ ...row.process }),
      status: row.status,
    }))),
  });
}

export function checkpointShadowGateEvidence(candidateIdentity, reports) {
  if (!validSha1(candidateIdentity?.headSha) || !validSha1(candidateIdentity?.treeSha)
    || !Array.isArray(reports) || reports.length === 0) {
    throw new Error('checkpoint-shadow-evidence-input-invalid');
  }
  const envelope = {
    schemaVersion: 'hex-final-closure-checkpoint-shadow-evidence/v1',
    status: 'PASS',
    candidateIdentity: { ...candidateIdentity },
    reports,
  };
  return Object.freeze({
    ...envelope,
    candidateIdentity: Object.freeze({ ...envelope.candidateIdentity }),
    reports: Object.freeze(reports),
    identity: sha256Text(canonicalJson(envelope)),
  });
}

function validateRuntimeShadowContract(contract, policy, taskId, gateId, ownership) {
  if (!shadowContractDefinitionValid(contract, policy, taskId, gateId, ownership)
    || contract.activationRequired !== false) {
    throw new Error(contract?.activationRequired === true
      ? `checkpoint-shadow-contract-activation-required:${taskId}`
      : 'checkpoint-shadow-contract-invalid');
  }
  return Object.freeze({
    ...contract,
    cases: Object.freeze(contract.cases.map((row) => Object.freeze({
      ...row,
      projection: Object.freeze({ ...row.projection, argv: Object.freeze([...row.projection.argv]) }),
      failureCounterIds: Object.freeze([...row.failureCounterIds]),
    }))),
  });
}

function shadowEvidenceContract(ownership, taskId, gate, { blobEvidence, readJson }) {
  const policy = ownership?.candidateGates?.shadowEvidence;
  const expectedArgv = [
    'node',
    policy?.verifierPath,
    '--emit-shadow-evidence',
    '--task',
    taskId,
  ];
  if (!policy
    || !exactSet(Object.keys(policy), [
      'schemaVersion', 'verifierPath', 'proofSchemaVersion',
      'rawObservationSchemaVersion', 'comparisonAlgorithm', 'requiredCounterIds',
      'minimumCaseCount', 'authorityArtifacts',
    ])
    || policy.schemaVersion !== SHADOW_POLICY_SCHEMA_VERSION
    || policy.proofSchemaVersion !== SHADOW_PROOF_SCHEMA_VERSION
    || policy.rawObservationSchemaVersion !== SHADOW_RAW_OBSERVATION_SCHEMA_VERSION
    || policy.comparisonAlgorithm !== SHADOW_COMPARISON_ALGORITHM
    || !exactSet(policy.requiredCounterIds, HARD_CORRECTNESS_COUNTER_IDS)
    || policy.minimumCaseCount !== 1
    || !Array.isArray(policy.authorityArtifacts)
    || policy.authorityArtifacts.length !== SHADOW_AUTHORITY_ARTIFACTS.length
    || !Array.isArray(gate?.argv)
    || gate.argv.length !== expectedArgv.length
    || gate.argv.some((entry, index) => entry !== expectedArgv[index])) {
    throw new Error('checkpoint-shadow-contract-invalid');
  }
  const authorityArtifacts = SHADOW_AUTHORITY_ARTIFACTS.map((expected, index) => {
    const pin = policy.authorityArtifacts[index];
    if (!pin
      || !exactSet(Object.keys(pin), ['role', 'path', 'sha256'])
      || pin.role !== expected.role
      || pin.path !== expected.path
      || !validSha256(pin.sha256)) {
      throw new Error(`checkpoint-shadow-authority-pin-invalid:${expected.role}`);
    }
    const observed = blobEvidence(pin.path);
    if (observed.sha256 !== pin.sha256) {
      throw new Error(`checkpoint-shadow-authority-content-mismatch:${expected.role}`);
    }
    return Object.freeze({ role: pin.role, ...observed });
  });
  const registryArtifact = authorityArtifacts.find((row) => row.role === 'registry');
  const contractsArtifact = authorityArtifacts.find((row) => row.role === 'contracts');
  const registry = readJson(registryArtifact.path);
  const contractsDocument = readJson(contractsArtifact.path);
  if (!registry
    || !exactSet(Object.keys(registry), [
      'schemaVersion', 'rawObservationSchemaVersion', 'comparisonAlgorithm',
      'contractPath', 'providers', 'tasks',
    ])
    || registry.schemaVersion !== SHADOW_AUTHORITY_REGISTRY_SCHEMA_VERSION
    || registry.rawObservationSchemaVersion !== policy.rawObservationSchemaVersion
    || registry.comparisonAlgorithm !== policy.comparisonAlgorithm
    || registry.contractPath !== contractsArtifact.path
    || !registry.providers
    || !exactSet(Object.keys(registry.providers), ['oracle', 'product'])
    || !registry.tasks
    || typeof registry.tasks !== 'object'
    || Array.isArray(registry.tasks)
    || !exactSet(Object.keys(registry.tasks), INITIAL_COMPONENT_TASK_IDS)) {
    throw new Error('checkpoint-shadow-authority-registry-invalid');
  }
  for (const [side, role] of [['oracle', 'oracleProvider'], ['product', 'productProvider']]) {
    const provider = registry.providers[side];
    const artifact = authorityArtifacts.find((row) => row.role === role);
    if (!provider
      || !exactSet(Object.keys(provider), ['path', 'argv'])
      || provider.path !== artifact.path
      || !Array.isArray(provider.argv)
      || provider.argv.length !== 2
      || provider.argv[0] !== 'node'
      || provider.argv[1] !== provider.path) {
      throw new Error(`checkpoint-shadow-provider-registry-invalid:${side}`);
    }
  }
  if (!contractsDocument
    || !exactSet(Object.keys(contractsDocument), ['schemaVersion', 'contracts'])
    || contractsDocument.schemaVersion !== SHADOW_CONTRACTS_SCHEMA_VERSION
    || !contractsDocument.contracts
    || typeof contractsDocument.contracts !== 'object'
    || Array.isArray(contractsDocument.contracts)) {
    throw new Error('checkpoint-shadow-contracts-invalid');
  }
  const dynamic = Number(taskId.slice(1)) >= 51;
  let contract;
  let contractId;
  if (dynamic) {
    if (!exactSet(Object.keys(gate), ['id', 'argv', 'contract', 'contractSha256'])
      || !validSha256(gate.contractSha256)
      || gate.contractSha256 !== sha256Text(canonicalJson(gate.contract))) {
      throw new Error(`checkpoint-shadow-dynamic-pin-invalid:${taskId}`);
    }
    contract = gate.contract;
    contractId = `embedded:${taskId}:${gate.id}`;
  } else {
    const binding = registry.tasks[taskId];
    if (!binding
      || !exactSet(Object.keys(binding), ['gateId', 'contractId'])
      || binding.gateId !== gate.id
      || typeof binding.contractId !== 'string') {
      throw new Error(`checkpoint-shadow-task-binding-invalid:${taskId}`);
    }
    contract = contractsDocument.contracts[binding.contractId];
    contractId = binding.contractId;
  }
  const validatedContract = validateRuntimeShadowContract(
    contract, policy, taskId, gate.id, ownership,
  );
  const contractJson = canonicalJson(validatedContract);
  if (Buffer.byteLength(contractJson, 'utf8') > 64 * 1024) {
    throw new Error('checkpoint-shadow-contract-too-large');
  }
  return Object.freeze({
    policy,
    verifierPath: policy.verifierPath,
    registry,
    contract: validatedContract,
    contractId,
    contractIdentity: sha256Text(contractJson),
    contractJson,
    authorityArtifacts: Object.freeze(authorityArtifacts),
    authorityIdentity: sha256Text(canonicalJson(authorityArtifacts)),
    requiredCounterIds: Object.freeze([...policy.requiredCounterIds]),
    registryEntryDigest: stableDigest({ policy, registry, taskId, gate }),
  });
}

function rawObservationContainsAuthority(value) {
  if (Array.isArray(value)) return value.some((entry) => rawObservationContainsAuthority(entry));
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, entry]) => (
    /(?:verdict|hash|counter)/i.test(key) || rawObservationContainsAuthority(entry)
  ));
}

function validateRawShadowObservation(observation, taskId, gateId, contract, policy) {
  if (!observation
    || rawObservationContainsAuthority(observation)
    || !exactSet(Object.keys(observation), ['schemaVersion', 'taskId', 'gateId', 'observations'])
    || observation.schemaVersion !== policy.rawObservationSchemaVersion
    || observation.taskId !== taskId
    || observation.gateId !== gateId
    || !Array.isArray(observation.observations)) {
    throw new Error('shadow-raw-observation-invalid');
  }
  const caseIds = [];
  const rows = observation.observations.map((row) => {
    const expectedCase = contract.cases.find((candidate) => candidate.id === row?.caseId);
    const value = row?.value;
    const observed = row?.state === 'OBSERVED'
      && exactSet(Object.keys(row || {}), ['caseId', 'state', 'value'])
      && value
      && exactSet(Object.keys(value), ['exitCode', 'signal', 'errorCode'])
      && (value.exitCode === null || Number.isSafeInteger(value.exitCode))
      && (value.signal === null
        || (typeof value.signal === 'string' && value.signal.length > 0 && value.signal.length <= 32))
      && (value.errorCode === null
        || (typeof value.errorCode === 'string' && value.errorCode.length > 0 && value.errorCode.length <= 64));
    const unknown = row?.state === 'UNKNOWN'
      && exactSet(Object.keys(row || {}), ['caseId', 'state', 'reason'])
      && typeof row.reason === 'string'
      && row.reason.length > 0
      && row.reason.length <= 240;
    if (!expectedCase || (!observed && !unknown)) {
      throw new Error('shadow-raw-observation-case-invalid');
    }
    caseIds.push(row.caseId);
    return Object.freeze({ ...row });
  });
  const expectedIds = contract.cases.map((row) => row.id);
  if (!exactSet(caseIds, expectedIds)) {
    throw new Error('shadow-raw-observation-case-set-invalid');
  }
  return Object.freeze({ ...observation, observations: Object.freeze(rows) });
}

export function deriveShadowProof({
  oracleObservation,
  productObservation,
  contract,
  policy,
  contractIdentity,
}) {
  const results = contract.cases.map((contractCase) => {
    const oracle = oracleObservation.observations.find((row) => row.caseId === contractCase.id);
    const product = productObservation.observations.find((row) => row.caseId === contractCase.id);
    const disposition = oracle.state !== 'OBSERVED'
      ? 'REJECTED'
      : product.state === 'UNKNOWN'
        ? 'SAFE_UNKNOWN'
        : canonicalJson(oracle.value) === canonicalJson(product.value)
          ? 'MATCH'
          : 'REJECTED';
    return Object.freeze({
      caseId: contractCase.id,
      disposition,
      oracleObservationSha256: sha256Text(canonicalJson(oracle)),
      productObservationSha256: sha256Text(canonicalJson(product)),
    });
  });
  const counters = policy.requiredCounterIds.map((id) => Object.freeze({
    id,
    observed: results.filter((row) => row.disposition === 'REJECTED'
      && contract.cases.find((candidate) => candidate.id === row.caseId)
        .failureCounterIds.includes(id)).length,
    denominator: contract.cases.filter((row) => row.failureCounterIds.includes(id)).length,
  }));
  return Object.freeze({
    schemaVersion: policy.proofSchemaVersion,
    verdict: results.some((row) => row.disposition === 'REJECTED') ? 'FAIL' : 'PASS',
    comparisonAlgorithm: policy.comparisonAlgorithm,
    contractIdentity,
    caseCount: contract.cases.length,
    results: Object.freeze(results),
    counters: Object.freeze(counters),
  });
}

function buildShadowGateEvidence({
  ownership,
  taskId,
  gate,
  headSha,
  treeSha,
  oracleObservation,
  productObservation,
  authoritySha,
  blobEvidence,
  authorityBlobEvidence,
  candidateParentShas,
  readJson,
}) {
  if (!/^T\d{3}$/.test(String(taskId || ''))
    || typeof gate?.id !== 'string'
    || !validSha1(headSha)
    || !validSha1(treeSha)
    || !validSha1(authoritySha)
    || !Array.isArray(candidateParentShas)
    || candidateParentShas[0] !== authoritySha) {
    throw new Error('checkpoint-shadow-report-input-invalid');
  }
  const shadow = shadowEvidenceContract(ownership, taskId, gate, { blobEvidence, readJson });
  const ownershipPath = 'specs/005-analysis-final-closure/contracts/task-ownership.json';
  const authorityOwnershipArtifact = authorityBlobEvidence(ownershipPath);
  const candidateOwnershipArtifact = blobEvidence(ownershipPath);
  if (canonicalJson(authorityOwnershipArtifact) !== canonicalJson(candidateOwnershipArtifact)) {
    throw new Error('shadow-authority-ownership-drift');
  }
  const authorityArtifacts = shadow.authorityArtifacts.map((candidateArtifact) => {
    const authorityArtifact = Object.freeze({
      role: candidateArtifact.role,
      ...authorityBlobEvidence(candidateArtifact.path),
    });
    if (canonicalJson(authorityArtifact) !== canonicalJson(candidateArtifact)) {
      throw new Error(`shadow-authority-candidate-drift:${candidateArtifact.role}`);
    }
    return authorityArtifact;
  });
  const judgeArtifacts = shadow.contract.cases.map((contractCase) => {
    const judgePath = contractCase.projection.argv[1];
    const authorityArtifact = authorityBlobEvidence(judgePath);
    if (canonicalJson(authorityArtifact) !== canonicalJson(blobEvidence(judgePath))) {
      throw new Error(`shadow-product-judge-drift:${taskId}:${contractCase.id}`);
    }
    return Object.freeze({ caseId: contractCase.id, ...authorityArtifact });
  });
  const validatedOracle = validateRawShadowObservation(
    oracleObservation, taskId, gate.id, shadow.contract, shadow.policy,
  );
  const validatedProduct = validateRawShadowObservation(
    productObservation, taskId, gate.id, shadow.contract, shadow.policy,
  );
  const proof = deriveShadowProof({
    oracleObservation: validatedOracle,
    productObservation: validatedProduct,
    contract: shadow.contract,
    policy: shadow.policy,
    contractIdentity: shadow.contractIdentity,
  });
  if (proof.verdict !== 'PASS' || proof.counters.some((row) => row.observed !== 0)) {
    const rejected = proof.results.filter((row) => row.disposition === 'REJECTED')
      .map((row) => row.caseId).join(',');
    throw new Error(`shadow-observation-divergence:${rejected}`);
  }
  const verifierArtifact = authorityBlobEvidence(shadow.verifierPath);
  if (canonicalJson(verifierArtifact) !== canonicalJson(blobEvidence(shadow.verifierPath))) {
    throw new Error('shadow-authority-verifier-drift');
  }
  const envelope = {
    schemaVersion: SHADOW_GATE_EVIDENCE_SCHEMA_VERSION,
    status: 'PASS',
    taskId,
    gateId: gate.id,
    candidateIdentity: { headSha, treeSha },
    authorityCommitSha: authoritySha,
    authorityOwnershipArtifact,
    registryEntryDigest: shadow.registryEntryDigest,
    verifierArtifact,
    verifierIdentity: verifierArtifact.sha256,
    authorityArtifacts,
    authorityIdentity: sha256Text(canonicalJson(authorityArtifacts)),
    judgeArtifacts,
    judgeIdentity: sha256Text(canonicalJson(judgeArtifacts)),
    observations: { oracle: validatedOracle, product: validatedProduct },
    proof,
  };
  return Object.freeze({
    ...envelope,
    candidateIdentity: Object.freeze({ ...envelope.candidateIdentity }),
    authorityOwnershipArtifact: Object.freeze({ ...authorityOwnershipArtifact }),
    authorityArtifacts: Object.freeze(authorityArtifacts),
    judgeArtifacts: Object.freeze(judgeArtifacts),
    observations: Object.freeze({ oracle: validatedOracle, product: validatedProduct }),
    proof,
    evidenceIdentity: sha256Text(canonicalJson(envelope)),
  });
}

function createShadowGateEvidenceAt({
  root, commitSha, authoritySha, ownership, taskId, gate, headSha, treeSha,
  oracleObservation, productObservation,
}) {
  if (commitSha !== headSha) throw new Error('checkpoint-shadow-report-input-invalid');
  const candidateParentShas = git(root, ['show', '-s', '--format=%P', commitSha])
    .split(/\s+/).filter(Boolean);
  return buildShadowGateEvidence({
    ownership,
    taskId,
    gate,
    headSha,
    treeSha,
    oracleObservation,
    productObservation,
    authoritySha,
    blobEvidence: (repoPath) => blobEvidenceAt(root, commitSha, repoPath),
    authorityBlobEvidence: (repoPath) => blobEvidenceAt(root, authoritySha, repoPath),
    candidateParentShas,
    readJson: (repoPath) => readJsonAt(root, authoritySha, repoPath),
  });
}

export function changedPaths(root, baseSha, headSha) {
  const result = runGit(
    root,
    ['diff', '--name-status', '-z', '--find-renames', '--find-copies', baseSha, headSha],
    { encoding: null },
  );
  if (result.status !== 0) throw new Error('git-diff-changed-path-inventory-failed');
  const output = result.stdout;
  if (!Buffer.isBuffer(output) || output.length === 0) return [];
  const tokens = [];
  let start = 0;
  for (let index = 0; index < output.length; index += 1) {
    if (output[index] !== 0) continue;
    tokens.push(output.subarray(start, index));
    start = index + 1;
  }
  if (start !== output.length) throw new Error('git-diff-name-status-not-nul-terminated');
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const decode = (token) => {
    let value;
    try {
      value = decoder.decode(token);
    } catch {
      throw new Error('git-diff-path-not-utf8');
    }
    if (value.includes('\ufeff')) throw new Error('git-diff-path-not-canonical');
    return value;
  };
  const paths = [];
  for (let index = 0; index < tokens.length;) {
    const status = decode(tokens[index++]);
    if (!/^(?:[ACDMRTUXB]|[RC][0-9]{1,3})$/.test(status)) {
      throw new Error(`git-diff-status-invalid:${status}`);
    }
    if (/^[RC]/.test(status)) paths.push(decode(tokens[index++]), decode(tokens[index++]));
    else paths.push(decode(tokens[index++]));
  }
  return [...new Set(paths)]
    .sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
}

function validIntegrationBranch(value) {
  return /^(?:recovery|analysis)\/final-closure-[a-z0-9][a-z0-9._/-]*$/.test(String(value || ''))
    && !String(value).includes('..')
    && !String(value).includes('@{')
    && !String(value).endsWith('/');
}

function componentTaskId(value) {
  const match = /^component\/final-closure-(t\d{3})-[a-z0-9][a-z0-9._-]*$/.exec(String(value || ''));
  return match ? match[1].toUpperCase() : null;
}

function githubInvocationAuthority(environment) {
  if (environment?.GITHUB_ACTIONS !== 'true') return null;
  const eventName = environment.GITHUB_EVENT_NAME;
  const eventPath = environment.GITHUB_EVENT_PATH;
  if (typeof eventPath !== 'string' || eventPath === '') throw new Error('github-event-path-missing');
  let event;
  try {
    event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
  } catch {
    throw new Error('github-event-invalid');
  }

  if (eventName === 'pull_request') {
    const headSha = event?.pull_request?.head?.sha;
    const baseSha = event?.pull_request?.base?.sha;
    const headRef = event?.pull_request?.head?.ref;
    const baseRef = event?.pull_request?.base?.ref;
    const pullRequestNumber = event?.number;
    if (!validSha1(headSha)) throw new Error('github-event-head-sha-invalid');
    if (!validSha1(baseSha)) throw new Error('github-event-base-sha-invalid');
    if (!Number.isSafeInteger(pullRequestNumber) || pullRequestNumber <= 0) {
      throw new Error('github-event-pull-request-number-invalid');
    }
    if (validIntegrationBranch(headRef) && baseRef === 'main') {
      return Object.freeze({
        eventName,
        mode: 'integration',
        headSha,
        baseSha,
        headRef,
        baseRef,
        pullRequestNumber,
      });
    }
    const taskId = componentTaskId(headRef);
    if (taskId && validIntegrationBranch(baseRef)) {
      return Object.freeze({
        eventName,
        mode: 'component',
        headSha,
        baseSha,
        headRef,
        baseRef,
        pullRequestNumber,
        taskId,
      });
    }
    throw new Error(`github-event-branch-not-authorized:${String(headRef)}:${String(baseRef)}`);
  }

  if (eventName === 'workflow_dispatch') {
    const headSha = event?.inputs?.expect_sha;
    const baseSha = event?.inputs?.expect_base_sha;
    if (!validSha1(headSha)) throw new Error('github-event-head-sha-invalid');
    if (!validSha1(baseSha)) throw new Error('github-event-base-sha-invalid');
    return Object.freeze({ eventName, mode: 'integration', headSha, baseSha });
  }
  throw new Error(`github-event-not-authorized:${String(eventName)}`);
}

export function persistentRefSnapshot(root) {
  const output = git(root, [
    'for-each-ref',
    '--format=%(refname)%09%(objectname)%09%(symref)',
    'refs',
  ]);
  const snapshot = {};
  for (const line of output.split('\n').filter(Boolean)) {
    const [refName, objectName, symbolicTarget, ...rest] = line.split('\t');
    if (rest.length > 0
      || !/^refs\//.test(String(refName || ''))
      || (!validSha1(objectName) && !symbolicTarget)) {
      throw new Error('persistent-ref-snapshot-invalid');
    }
    snapshot[refName] = symbolicTarget ? `symref:${symbolicTarget}` : objectName;
  }
  return Object.freeze(snapshot);
}

export function assertOnlyAllowedRefChanges(before, after, allowedRefs) {
  const allowed = new Set(allowedRefs || []);
  const refNames = [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])]
    .sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
  const unexpected = refNames.filter(
    (refName) => before?.[refName] !== after?.[refName] && !allowed.has(refName),
  );
  if (unexpected.length > 0) {
    throw new Error(`git-fetch-unexpected-ref-mutation:${unexpected.join(',')}`);
  }
  return Object.freeze({ changedRefs: Object.freeze(refNames.filter(
    (refName) => before?.[refName] !== after?.[refName],
  )) });
}

function optionalRefSha(root, refName) {
  const result = runGit(root, ['rev-parse', '--verify', refName]);
  return result.status === 0 ? String(result.stdout).trim() : null;
}

function fetchRemoteRef(root, sourceRef, destinationRef, errorCode) {
  const before = persistentRefSnapshot(root);
  const result = runGit(root, [
    'fetch', '--quiet', '--no-tags', '--refmap=', 'origin', `+${sourceRef}:${destinationRef}`,
  ]);
  if (result.status !== 0) throw new Error(errorCode);
  const after = persistentRefSnapshot(root);
  assertOnlyAllowedRefChanges(before, after, [destinationRef]);
  return git(root, ['rev-parse', destinationRef]);
}

function fetchRecoveryHandoffAuthority(root, expectedSha) {
  const canonicalBefore = optionalRefSha(root, RECOVERY_HANDOFF_CANONICAL_REMOTE_REF);
  const observedRemoteSha = fetchRemoteRef(
    root,
    RECOVERY_HANDOFF_FETCH_REF,
    RECOVERY_HANDOFF_SCRATCH_REMOTE_REF,
    'stage-b-recovery-ref-fetch-failed',
  );
  const canonicalAfter = optionalRefSha(root, RECOVERY_HANDOFF_CANONICAL_REMOTE_REF);
  if (canonicalBefore !== canonicalAfter) throw new Error('stage-b-recovery-canonical-ref-mutated');
  if (canonicalBefore !== null && canonicalBefore !== expectedSha) {
    throw new Error(`stage-b-recovery-canonical-ref-mismatch:${expectedSha}:${canonicalBefore}`);
  }
  if (observedRemoteSha !== expectedSha) {
    throw new Error(`stage-b-recovery-ref-sha-mismatch:${expectedSha}:${observedRemoteSha}`);
  }
  return Object.freeze({
    canonicalRef: RECOVERY_HANDOFF_CANONICAL_REMOTE_REF,
    canonicalShaBefore: canonicalBefore,
    canonicalShaAfter: canonicalAfter,
    scratchRef: RECOVERY_HANDOFF_SCRATCH_REMOTE_REF,
    observedRemoteSha,
  });
}

function fetchCurrentMain(root) {
  return fetchRemoteRef(
    root,
    'refs/heads/main',
    'refs/remotes/origin/main',
    'current-main-fetch-failed',
  );
}

function fetchComponentAuthority(root, authority) {
  const observedBase = fetchRemoteRef(
    root,
    `refs/heads/${authority.baseRef}`,
    `refs/remotes/origin/${authority.baseRef}`,
    'component-base-fetch-failed',
  );
  if (observedBase !== authority.baseSha) {
    throw new Error(`github-event-base-ref-sha-mismatch:${authority.baseSha}:${observedBase}`);
  }
  const observedHead = fetchRemoteRef(
    root,
    `refs/pull/${authority.pullRequestNumber}/head`,
    'refs/remotes/origin/__final_closure_component_head',
    'component-head-fetch-failed',
  );
  if (observedHead !== authority.headSha) {
    throw new Error(`github-event-head-ref-sha-mismatch:${authority.headSha}:${observedHead}`);
  }
}

function candidateMergeTree(root, baseSha, headSha) {
  const result = runGit(root, ['merge-tree', '--write-tree', baseSha, headSha]);
  if (result.status !== 0) throw new Error('candidate-merge-tree-conflict');
  const treeSha = result.stdout.trim().split(/\s+/)[0];
  if (!validSha1(treeSha)) throw new Error('candidate-merge-tree-invalid');
  return treeSha;
}

export function prepareComponentCandidate({ root = ROOT, environment = process.env } = {}) {
  const authority = githubInvocationAuthority(environment);
  if (!authority || authority.mode !== 'component') throw new Error('component-preparation-event-required');
  const dirty = git(root, ['status', '--porcelain', '--untracked-files=all']);
  if (dirty) throw new Error(`preflight-worktree-not-clean:\n${dirty}`);
  fetchComponentAuthority(root, authority);
  const observedHead = git(root, ['rev-parse', 'HEAD']);
  if (observedHead !== authority.baseSha) {
    throw new Error(`component-preparation-head-not-base:${observedHead}:${authority.baseSha}`);
  }
  const treeSha = candidateMergeTree(root, authority.baseSha, authority.headSha);
  const commitEnvironment = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Hex Final Closure Gate',
    GIT_AUTHOR_EMAIL: 'final-closure@example.invalid',
    GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
    GIT_COMMITTER_NAME: 'Hex Final Closure Gate',
    GIT_COMMITTER_EMAIL: 'final-closure@example.invalid',
    GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
  };
  const commitSha = git(root, [
    'commit-tree',
    treeSha,
    '-p', authority.baseSha,
    '-p', authority.headSha,
    '-m', `final-closure candidate ${authority.taskId}`,
  ], { env: commitEnvironment });
  if (!validSha1(commitSha)) throw new Error('candidate-merge-commit-invalid');
  git(root, ['checkout', '--quiet', '--detach', commitSha]);
  return Object.freeze({
    schemaVersion: 'hex-final-closure-component-candidate/v1',
    taskId: authority.taskId,
    baseSha: authority.baseSha,
    componentHeadSha: authority.headSha,
    mergeTreeSha: treeSha,
    candidateCommitSha: commitSha,
  });
}

export function verifyPerformanceLockSources(root, performanceLocks) {
  const sourceScope = performanceLocks?.profiles?.['P-SYM01']?.sourceScope;
  if (!sourceScope || !validSha1(sourceScope.commitSha) || !validSha1(sourceScope.treeSha)) {
    throw new Error('performance-source-scope-invalid');
  }
  const observedRef = fetchRemoteRef(
    root,
    sourceScope.fetchRef,
    'refs/remotes/origin/__final_closure_sym01_source',
    'performance-source-fetch-failed',
  );
  if (observedRef !== sourceScope.commitSha) {
    throw new Error(`performance-source-ref-mismatch:${sourceScope.commitSha}:${observedRef}`);
  }
  const observedTree = git(root, ['rev-parse', `${sourceScope.commitSha}^{tree}`]);
  if (observedTree !== sourceScope.treeSha) {
    throw new Error(`performance-source-tree-mismatch:${sourceScope.treeSha}:${observedTree}`);
  }
  for (const row of sourceScope.paths || []) {
    const observedBlob = git(root, ['rev-parse', `${sourceScope.commitSha}:${row.path}`]);
    if (observedBlob !== row.gitBlobSha1) {
      throw new Error(`performance-source-blob-mismatch:${row.path}:${row.gitBlobSha1}:${observedBlob}`);
    }
    const content = runGit(root, ['cat-file', 'blob', observedBlob], { encoding: null });
    if (content.status !== 0) throw new Error(`performance-source-content-missing:${row.path}`);
    const observedSha256 = createHash('sha256').update(content.stdout).digest('hex');
    if (observedSha256 !== row.sha256) {
      throw new Error(`performance-source-content-mismatch:${row.path}:${row.sha256}:${observedSha256}`);
    }
  }
  return Object.freeze({
    commitSha: sourceScope.commitSha,
    treeSha: sourceScope.treeSha,
    pathCount: sourceScope.paths.length,
  });
}

function assertAncestor(root, ancestorSha, descendantSha, errorCode) {
  const result = runGit(root, ['merge-base', '--is-ancestor', ancestorSha, descendantSha]);
  if (result.status !== 0) throw new Error(`${errorCode}:${ancestorSha}:${descendantSha}`);
}

export function verifyStageBOperationalEvidence(root, stageEvidence, currentBaseSha) {
  const { stageA, stageB } = stageEvidence;
  if (!stageA || !stageB) throw new Error('stage-b-operational-evidence-missing');
  const candidate = stageA.candidate;
  const observedCandidateTree = git(root, ['rev-parse', `${candidate.headSha}^{tree}`]);
  if (observedCandidateTree !== candidate.treeSha) {
    throw new Error(`stage-a-candidate-tree-mismatch:${candidate.treeSha}:${observedCandidateTree}`);
  }
  const observedMergeTree = candidateMergeTree(root, candidate.baseSha, candidate.headSha);
  if (observedMergeTree !== candidate.mergeTreeSha) {
    throw new Error(`stage-a-candidate-merge-tree-mismatch:${candidate.mergeTreeSha}:${observedMergeTree}`);
  }
  const acceptedMergeParents = git(root, ['show', '-s', '--format=%P', stageA.acceptedMergeCommitSha])
    .split(/\s+/)
    .filter(Boolean);
  if (acceptedMergeParents.length !== 2
    || acceptedMergeParents[0] !== candidate.baseSha
    || acceptedMergeParents[1] !== candidate.headSha) {
    throw new Error(`stage-a-accepted-merge-parents-mismatch:${stageA.acceptedMergeCommitSha}`);
  }
  const acceptedMergeTree = git(root, ['rev-parse', `${stageA.acceptedMergeCommitSha}^{tree}`]);
  if (acceptedMergeTree !== candidate.mergeTreeSha) {
    throw new Error(`stage-a-accepted-merge-tree-mismatch:${candidate.mergeTreeSha}:${acceptedMergeTree}`);
  }
  assertAncestor(root, candidate.headSha, stageA.acceptedMergeCommitSha, 'stage-a-candidate-not-accepted');
  assertAncestor(root, stageA.acceptedMergeCommitSha, stageA.refetchedMainSha, 'stage-a-merge-not-on-refetched-main');
  assertAncestor(root, stageA.refetchedMainSha, currentBaseSha, 'stage-a-refetched-main-stale');
  if (stageB.baseSha !== currentBaseSha || stageB.worktree.initialHeadSha !== currentBaseSha) {
    throw new Error(`stage-b-current-base-mismatch:${stageB.baseSha}:${currentBaseSha}`);
  }
  const recoveryTransaction = fetchRecoveryHandoffAuthority(root, stageA.recoveryRef.sha);
  const observedRecoveryRef = recoveryTransaction.observedRemoteSha;
  if (observedRecoveryRef !== stageA.recoveryRef.sha || observedRecoveryRef !== stageB.recoveryRef.sha) {
    throw new Error(`stage-b-recovery-ref-sha-mismatch:${stageA.recoveryRef.sha}:${observedRecoveryRef}`);
  }
  return Object.freeze({
    stageARefetchedMainSha: stageA.refetchedMainSha,
    stageBBaseSha: stageB.baseSha,
    recoveryRefSha: observedRecoveryRef,
    recoveryRefTransaction: recoveryTransaction,
  });
}

export function hashDirectoryTree(directory, {
  excludeTopLevel = [],
  requireContainedSymlinks = false,
} = {}) {
  const hash = createHash('sha256');
  const frame = (type, value) => {
    const typeBytes = Buffer.from(type, 'utf8');
    const valueBytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
    const lengths = Buffer.allocUnsafe(16);
    lengths.writeBigUInt64BE(BigInt(typeBytes.length), 0);
    lengths.writeBigUInt64BE(BigInt(valueBytes.length), 8);
    hash.update(lengths);
    hash.update(typeBytes);
    hash.update(valueBytes);
  };
  if (!fs.existsSync(directory)) {
    frame('tree-state', 'MISSING');
    return hash.digest('hex');
  }
  frame('tree-state', 'PRESENT');
  const rootRealPath = fs.realpathSync(directory);
  const excluded = new Set(excludeTopLevel);
  const visit = (current, relative) => {
    const entries = fs.readdirSync(current, { withFileTypes: true })
      .sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)));
    for (const entry of entries) {
      if (relative === '' && excluded.has(entry.name)) continue;
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const absolute = path.join(current, entry.name);
      const stat = fs.lstatSync(absolute);
      frame('path', childRelative);
      frame('mode', String(stat.mode));
      if (entry.isDirectory()) {
        frame('kind', 'DIRECTORY');
        visit(absolute, childRelative);
      } else if (entry.isSymbolicLink()) {
        frame('kind', 'SYMLINK');
        frame('link-target', fs.readlinkSync(absolute));
        if (requireContainedSymlinks) {
          let resolved;
          try {
            resolved = fs.realpathSync(absolute);
          } catch {
            throw new Error(`checkpoint-directory-symlink-unresolved:${childRelative}`);
          }
          const resolvedRelative = path.relative(rootRealPath, resolved);
          if (resolvedRelative === ''
            || resolvedRelative.startsWith('..')
            || path.isAbsolute(resolvedRelative)) {
            throw new Error(`checkpoint-directory-symlink-outside-root:${childRelative}`);
          }
          const targetStat = fs.statSync(absolute);
          frame('link-resolved-path', resolvedRelative);
          frame('link-target-kind', targetStat.isFile()
            ? 'FILE'
            : targetStat.isDirectory() ? 'DIRECTORY' : 'SPECIAL');
        }
      } else if (entry.isFile()) {
        frame('kind', 'FILE');
        frame('content', fs.readFileSync(absolute));
      } else {
        frame('kind', 'SPECIAL');
      }
    }
  };
  visit(directory, '');
  return hash.digest('hex');
}

function dirtyStatusPaths(status) {
  if (status === '') return [];
  const records = status.split('\0');
  if (records.at(-1) === '') records.pop();
  const paths = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.length < 4 || record[2] !== ' ') throw new Error('workspace-status-record-invalid');
    paths.push(record.slice(3));
    if (record[0] === 'R' || record[0] === 'C' || record[1] === 'R' || record[1] === 'C') {
      index += 1;
      if (index >= records.length || records[index] === '') throw new Error('workspace-status-rename-invalid');
      paths.push(records[index]);
    }
  }
  return [...new Set(paths)].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
}

function hashDirtyWorktreeState(realPath, status) {
  const hash = createHash('sha256');
  hash.update(`porcelain-v1-z\0${status}`);
  for (const repoPath of dirtyStatusPaths(status)) {
    const absolute = path.resolve(realPath, repoPath);
    const relative = path.relative(realPath, absolute);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('workspace-status-path-outside-root');
    hash.update(`path\0${repoPath}\0`);
    if (!fs.existsSync(absolute) && !fs.lstatSync(path.dirname(absolute), { throwIfNoEntry: false })) {
      hash.update('MISSING\0');
      continue;
    }
    const stat = fs.lstatSync(absolute, { throwIfNoEntry: false });
    if (!stat) {
      hash.update('MISSING\0');
    } else if (stat.isSymbolicLink()) {
      hash.update(`LINK\0${stat.mode}\0${fs.readlinkSync(absolute)}\0`);
    } else if (stat.isFile()) {
      hash.update(`FILE\0${stat.mode}\0${stat.size}\0`);
      hash.update(fs.readFileSync(absolute));
    } else if (stat.isDirectory()) {
      hash.update(`DIRECTORY\0${stat.mode}\0${hashDirectoryTree(absolute, { excludeTopLevel: ['.git'] })}\0`);
    } else {
      hash.update(`SPECIAL\0${stat.mode}\0`);
    }
  }
  return hash.digest('hex');
}

export function localWorkspaceIdentity(workspaceRoot) {
  const realPath = fs.realpathSync(workspaceRoot);
  const gitDirPath = fs.realpathSync(git(realPath, ['rev-parse', '--absolute-git-dir']));
  const statusResult = runGit(realPath, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (statusResult.status !== 0) throw new Error('workspace-status-read-failed');
  const status = String(statusResult.stdout);
  const snapshot = {
    realPath,
    gitDirPath,
    headSha: git(realPath, ['rev-parse', 'HEAD']),
    branchRef: git(realPath, ['symbolic-ref', '--quiet', '--short', 'HEAD']) || 'DETACHED',
    status,
    dirtyStateSha256: hashDirtyWorktreeState(realPath, status),
    transcriptsSha256: hashDirectoryTree(path.join(realPath, 'transcripts')),
  };
  return Object.freeze({
    ...snapshot,
    identity: stageBLocalReportSha256(workspacePreservationPayload(snapshot)),
  });
}

function localWorktreeIdentity(worktreeRoot) {
  const realPath = fs.realpathSync(worktreeRoot);
  const gitDirPath = fs.realpathSync(git(realPath, ['rev-parse', '--absolute-git-dir']));
  return Object.freeze({
    realPath,
    gitDirPath,
    identity: stageBLocalReportSha256({ realPath, gitDirPath }),
  });
}

export function localStageWorktreeIdentity(worktreeRoot) {
  const realPath = fs.realpathSync(worktreeRoot);
  const snapshot = {
    realPath,
    gitDirPath: fs.realpathSync(git(realPath, ['rev-parse', '--absolute-git-dir'])),
    headSha: git(realPath, ['rev-parse', 'HEAD']),
    branchRef: git(realPath, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
    status: git(realPath, ['status', '--porcelain', '--untracked-files=all']),
  };
  return Object.freeze({
    ...snapshot,
    identity: stageBLocalReportSha256(stageWorktreePayload(snapshot)),
  });
}

function listedWorktrees(root) {
  const output = git(root, ['worktree', 'list', '--porcelain']);
  const rows = [];
  let current = null;
  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length), branch: null, headSha: null };
      rows.push(current);
    } else if (current && line.startsWith('HEAD ')) current.headSha = line.slice(5);
    else if (current && line.startsWith('branch refs/heads/')) current.branch = line.slice('branch refs/heads/'.length);
  }
  return rows;
}

export function verifyLocalStageBWorktree({ root = ROOT, originalWorkspaceRoot = null } = {}) {
  const bundle = contractBundle(root);
  if (bundle.integrationInventory.campaignStage !== 'STAGE_B') {
    throw new Error('local-stage-b-inventory-required');
  }
  const structural = validatePreflightContracts(bundle);
  if (!structural.ok) throw new Error(`preflight-contract-invalid:\n${structural.errors.join('\n')}`);
  const stageB = structural.stageEvidence?.stageB;
  if (!stageB) throw new Error('local-stage-b-evidence-missing');
  const worktree = localWorktreeIdentity(root);
  const stageAWorktree = localStageWorktreeIdentity(structural.stageEvidence.stageA.stageAWorktree.path);
  const original = localWorkspaceIdentity(originalWorkspaceRoot || stageB.originalWorkspace.path);
  const branchRef = git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const status = git(root, ['status', '--porcelain', '--untracked-files=all']);
  const currentMainSha = fetchCurrentMain(root);
  if (stageB.baseSha !== currentMainSha) {
    throw new Error(`local-stage-b-base-mismatch:${stageB.baseSha}:${currentMainSha}`);
  }
  assertAncestor(root, currentMainSha, git(root, ['rev-parse', 'HEAD']), 'local-stage-b-head-not-on-base');
  if (worktree.realPath !== stageB.worktree.path || worktree.identity !== stageB.worktree.identity) {
    throw new Error('local-stage-b-worktree-identity-mismatch');
  }
  if (branchRef !== stageB.integrationBranch) {
    throw new Error(`local-stage-b-branch-mismatch:${branchRef}:${stageB.integrationBranch}`);
  }
  if (status !== '') throw new Error(`local-stage-b-worktree-dirty:\n${status}`);
  if (original.realPath !== stageB.originalWorkspace.path
    || original.identity !== stageB.originalWorkspace.identity) {
    throw new Error('local-stage-b-original-workspace-mismatch');
  }
  const observedStageAWorktree = {
    path: stageAWorktree.realPath,
    gitDirPath: stageAWorktree.gitDirPath,
    headSha: stageAWorktree.headSha,
    branchRef: stageAWorktree.branchRef,
    status: stageAWorktree.status,
    identity: stageAWorktree.identity,
  };
  if (canonicalJson(observedStageAWorktree)
    !== canonicalJson(structural.stageEvidence.stageA.stageAWorktree)) {
    throw new Error('local-stage-b-stage-a-worktree-mismatch');
  }
  const matchingWorktrees = listedWorktrees(root).filter((row) => {
    try {
      return fs.realpathSync(row.path) === worktree.realPath;
    } catch {
      return false;
    }
  });
  if (matchingWorktrees.length !== 1 || matchingWorktrees[0].branch !== stageB.integrationBranch) {
    throw new Error('local-stage-b-worktree-registration-mismatch');
  }
  const matchingStageAWorktrees = listedWorktrees(root).filter((row) => {
    try {
      return fs.realpathSync(row.path) === stageAWorktree.realPath;
    } catch {
      return false;
    }
  });
  if (matchingStageAWorktrees.length !== 1
    || matchingStageAWorktrees[0].branch !== stageAWorktree.branchRef
    || matchingStageAWorktrees[0].headSha !== stageAWorktree.headSha) {
    throw new Error('local-stage-b-stage-a-worktree-registration-mismatch');
  }
  if ([stageB.stageAWorktree?.path, structural.stageEvidence.stageA.stageAWorktree.path,
    stageB.originalWorkspace.path].includes(worktree.realPath)) {
    throw new Error('local-stage-b-worktree-reused');
  }
  const recoveryTransaction = fetchRecoveryHandoffAuthority(root, stageB.recoveryRef.sha);
  const recoveryRefSha = recoveryTransaction.observedRemoteSha;
  if (recoveryRefSha !== stageB.recoveryRef.sha) throw new Error('local-stage-b-recovery-ref-mismatch');
  const report = Object.freeze({
    stageBWorktreePath: worktree.realPath,
    stageBGitDirPath: worktree.gitDirPath,
    stageBWorktreeIdentity: worktree.identity,
    integrationBranch: branchRef,
    baseSha: currentMainSha,
    originalWorkspacePath: original.realPath,
    originalWorkspaceIdentity: original.identity,
    originalWorkspaceGitDirPath: original.gitDirPath,
    originalWorkspaceHeadSha: original.headSha,
    originalWorkspaceBranchRef: original.branchRef,
    originalWorkspaceStatus: original.status,
    originalWorkspaceDirtyStateSha256: original.dirtyStateSha256,
    originalWorkspaceTranscriptsSha256: original.transcriptsSha256,
    recoveryRef: stageB.recoveryRef.ref,
    recoveryRefSha,
  });
  if (canonicalJson(report) !== canonicalJson(stageB.localVerification.report)
    || stageB.localVerification.reportSha256 !== stageBLocalReportSha256(report)) {
    throw new Error('local-stage-b-recorded-report-mismatch');
  }
  return Object.freeze({
    schemaVersion: 'hex-final-closure-stage-b-local-worktree-report/v1',
    status: 'PASS',
    report,
    reportSha256: stageBLocalReportSha256(report),
  });
}

function verifyMainReconciliation(root, record, {
  expectedPreviousEvidenceSha,
  expectedIntegrationHeadSha,
  requiredCurrentMainSha = null,
  sequence,
}) {
  const label = String(sequence);
  const expectedKeys = [
    'schemaVersion',
    'mode',
    'previousEvidenceSha',
    'currentMainSha',
    'integrationHeadSha',
    'integrationHeadTreeSha',
    'autoMergeTreeSha',
    'adjustmentPaths',
    'adjustmentStableDigest',
  ];
  if (!record || !exactSet(Object.keys(record), expectedKeys)
    || record.schemaVersion !== MAIN_RECONCILIATION_SCHEMA_VERSION
    || record.previousEvidenceSha !== expectedPreviousEvidenceSha
    || record.integrationHeadSha !== expectedIntegrationHeadSha
    || !validSha1(record.currentMainSha)
    || (requiredCurrentMainSha != null && record.currentMainSha !== requiredCurrentMainSha)
    || !Array.isArray(record.adjustmentPaths)
    || !exactSet(record.adjustmentPaths, record.adjustmentPaths)
    || record.adjustmentPaths.some((repoPath) => !validRepoPath(repoPath))
    || record.adjustmentStableDigest !== stableDigest([...record.adjustmentPaths].sort())) {
    throw new Error(`checkpoint-main-reconciliation-invalid:${label}`);
  }
  const observedTreeSha = git(root, ['rev-parse', `${expectedIntegrationHeadSha}^{tree}`]);
  if (record.integrationHeadTreeSha !== observedTreeSha) {
    throw new Error(`checkpoint-main-reconciliation-tree-mismatch:${label}`);
  }
  if (record.mode === 'NOOP') {
    if (expectedIntegrationHeadSha !== expectedPreviousEvidenceSha
      || record.autoMergeTreeSha !== null
      || record.adjustmentPaths.length !== 0) {
      throw new Error(`checkpoint-main-reconciliation-noop-invalid:${label}`);
    }
    assertAncestor(
      root,
      record.currentMainSha,
      expectedIntegrationHeadSha,
      `checkpoint-main-reconciliation-main-stale:${label}`,
    );
    return Object.freeze({ ...record, adjustmentPaths: Object.freeze([]) });
  }
  if (record.mode !== 'EXACT_MERGE') {
    throw new Error(`checkpoint-main-reconciliation-mode-invalid:${label}`);
  }
  const parents = git(root, ['show', '-s', '--format=%P', expectedIntegrationHeadSha])
    .split(/\s+/)
    .filter(Boolean);
  if (parents.length !== 2
    || parents[0] !== expectedPreviousEvidenceSha
    || parents[1] !== record.currentMainSha) {
    throw new Error(`checkpoint-main-reconciliation-parents-invalid:${label}`);
  }
  const autoMergeTreeSha = candidateMergeTree(
    root,
    expectedPreviousEvidenceSha,
    record.currentMainSha,
  );
  if (record.autoMergeTreeSha !== autoMergeTreeSha) {
    throw new Error(`checkpoint-main-reconciliation-auto-tree-mismatch:${label}`);
  }
  const adjustmentPaths = changedPaths(root, autoMergeTreeSha, observedTreeSha);
  if (!exactSet(adjustmentPaths, record.adjustmentPaths)
    || adjustmentPaths.some((repoPath) => !MAIN_RECONCILIATION_ALLOWED_PATHS.includes(repoPath))) {
    throw new Error(`checkpoint-main-reconciliation-adjustment-invalid:${label}:${adjustmentPaths.join(',')}`);
  }
  return Object.freeze({ ...record, adjustmentPaths: Object.freeze([...adjustmentPaths]) });
}

function derivedTailMainReconciliation(root, {
  previousEvidenceSha,
  integrationHeadSha,
  currentMainSha = null,
}) {
  const integrationHeadTreeSha = git(root, ['rev-parse', `${integrationHeadSha}^{tree}`]);
  if (integrationHeadSha === previousEvidenceSha) {
    if (currentMainSha != null) {
      assertAncestor(root, currentMainSha, integrationHeadSha, 'checkpoint-tail-current-main-stale');
    }
    return Object.freeze({
      mode: 'NOOP',
      previousEvidenceSha,
      currentMainSha,
      integrationHeadSha,
      integrationHeadTreeSha,
      autoMergeTreeSha: null,
      adjustmentPaths: Object.freeze([]),
      adjustmentStableDigest: stableDigest([]),
    });
  }
  const parents = git(root, ['show', '-s', '--format=%P', integrationHeadSha])
    .split(/\s+/)
    .filter(Boolean);
  if (parents.length !== 2
    || parents[0] !== previousEvidenceSha
    || (currentMainSha != null && parents[1] !== currentMainSha)) {
    throw new Error('checkpoint-tail-main-reconciliation-parents-invalid');
  }
  const observedCurrentMainSha = currentMainSha ?? parents[1];
  const autoMergeTreeSha = candidateMergeTree(root, previousEvidenceSha, observedCurrentMainSha);
  const adjustmentPaths = changedPaths(root, autoMergeTreeSha, integrationHeadTreeSha);
  if (adjustmentPaths.some((repoPath) => !MAIN_RECONCILIATION_ALLOWED_PATHS.includes(repoPath))) {
    throw new Error(`checkpoint-tail-main-reconciliation-adjustment-invalid:${adjustmentPaths.join(',')}`);
  }
  return Object.freeze({
    mode: 'EXACT_MERGE',
    previousEvidenceSha,
    currentMainSha: observedCurrentMainSha,
    integrationHeadSha,
    integrationHeadTreeSha,
    autoMergeTreeSha,
    adjustmentPaths: Object.freeze(adjustmentPaths),
    adjustmentStableDigest: stableDigest([...adjustmentPaths].sort()),
  });
}

export function verifyCheckpointOperationalEvidence(root, result, integrationHeadSha, {
  componentMode = false,
  currentMainSha = null,
} = {}) {
  const checkpointResult = result?.checkpointResult;
  const sequence = checkpointResult?.checkpoint?.sequence;
  if (sequence === 0) return null;
  const ledger = checkpointResult?.ledger;
  if (!ledger || ledger.checkpoints.length !== sequence) {
    throw new Error('checkpoint-operational-ledger-missing');
  }
  const handoffs = result?.taskHandoffResult?.handoffs || {};
  const evidencePath = checkpointResult.checkpoint.evidencePath;
  const evidenceCommitShas = ledger.checkpoints.map((row, index) => {
    const searchHeadSha = index + 1 < ledger.checkpoints.length
      ? ledger.checkpoints[index + 1].integrationParentSha
      : integrationHeadSha;
    const evidenceCommitSha = git(root, ['log', '-1', '--format=%H', searchHeadSha, '--', evidencePath]);
    if (!validSha1(evidenceCommitSha)) {
      throw new Error(`checkpoint-evidence-commit-missing:${row.sequence}:${evidencePath}`);
    }
    return evidenceCommitSha;
  });
  const canonicalT046 = canonicalTaskHandoffAnchor(root, integrationHeadSha, 'T046');
  for (let rowIndex = 0; rowIndex < ledger.checkpoints.length; rowIndex += 1) {
    const row = ledger.checkpoints[rowIndex];
    const cumulativeTaskIds = ledger.checkpoints
      .slice(0, rowIndex + 1)
      .map((checkpointRow) => checkpointRow.acceptedTaskId);
    verifyMainReconciliation(root, row.mainReconciliation, {
      expectedPreviousEvidenceSha: rowIndex === 0
        ? canonicalT046.transitionCommitSha
        : evidenceCommitShas[rowIndex - 1],
      expectedIntegrationHeadSha: row.integrationParentSha,
      sequence: row.sequence,
    });
    if (row.mainReconciliation.currentMainSha !== row.cumulativeInventory.baseSha) {
      throw new Error(`checkpoint-main-reconciliation-base-mismatch:${row.sequence}`);
    }
    const handoff = handoffs[row.acceptedTaskId];
    if (!handoff
      || handoff.headSha !== row.componentHeadSha
      || handoff.treeSha !== git(root, ['rev-parse', `${row.componentHeadSha}^{tree}`])) {
      throw new Error(`checkpoint-task-handoff-mismatch:${row.sequence}:${row.acceptedTaskId}`);
    }
    const componentMergeBase = git(root, [
      'merge-base', row.integrationParentSha, row.componentHeadSha,
    ]);
    const componentPaths = changedPaths(root, componentMergeBase, row.componentHeadSha);
    const componentGeneratedPaths = componentPaths
      .filter((repoPath) => CHECKPOINT_GENERATED_PATHS.includes(repoPath));
    if (componentGeneratedPaths.length > 0) {
      throw new Error(`checkpoint-component-generated-output:${row.sequence}:${componentGeneratedPaths.join(',')}`);
    }
    const integrationParentOwnership = readJsonAt(
      root,
      row.integrationParentSha,
      'specs/005-analysis-final-closure/contracts/task-ownership.json',
    );
    const componentLane = validateTaskInventory({
      taskId: row.acceptedTaskId,
      actualPaths: componentPaths,
      ownership: integrationParentOwnership,
    });
    if (!componentLane.ok) {
      throw new Error(`checkpoint-component-inventory-invalid:${row.sequence}:${componentLane.errors.join(',')}`);
    }

    const acceptedMergeTree = git(root, ['rev-parse', `${row.acceptedMerge.commitSha}^{tree}`]);
    if (acceptedMergeTree !== row.acceptedMerge.treeSha) {
      throw new Error(`checkpoint-accepted-merge-tree-mismatch:${row.sequence}:${row.acceptedMerge.treeSha}:${acceptedMergeTree}`);
    }
    const acceptedMergeParents = git(root, ['show', '-s', '--format=%P', row.acceptedMerge.commitSha])
      .split(/\s+/)
      .filter(Boolean);
    if (acceptedMergeParents.length !== 2
      || acceptedMergeParents[0] !== row.integrationParentSha
      || acceptedMergeParents[1] !== row.componentHeadSha) {
      throw new Error(`checkpoint-accepted-merge-parents-mismatch:${row.sequence}`);
    }
    const computedTree = candidateMergeTree(root, row.integrationParentSha, row.componentHeadSha);
    if (computedTree !== row.candidateMergeTreeSha
      || computedTree !== row.acceptedMerge.treeSha) {
      throw new Error(`checkpoint-candidate-tree-mismatch:${row.sequence}:${row.candidateMergeTreeSha}:${computedTree}`);
    }

    const productTree = git(root, ['rev-parse', `${row.checkpointProduct.commitSha}^{tree}`]);
    if (productTree !== row.checkpointProduct.treeSha) {
      throw new Error(`checkpoint-product-tree-mismatch:${row.sequence}:${row.checkpointProduct.treeSha}:${productTree}`);
    }
    const productParents = git(root, ['show', '-s', '--format=%P', row.checkpointProduct.commitSha])
      .split(/\s+/)
      .filter(Boolean);
    if (productParents.length !== 1 || productParents[0] !== row.acceptedMerge.commitSha) {
      throw new Error(`checkpoint-product-parent-mismatch:${row.sequence}`);
    }
    const productPaths = changedPaths(root, row.acceptedMerge.commitSha, row.checkpointProduct.commitSha);
    const reconciliationPaths = productPaths.filter(
      (repoPath) => !CHECKPOINT_GENERATED_PATHS.includes(repoPath),
    );
    const reconciliation = row.integrationReconciliation;
    const checkpointOwnerTaskId = CHECKPOINT_OWNER_TASK_IDS[ledger.campaignStage];
    if (!reconciliation
      || reconciliation.ownerTaskId !== checkpointOwnerTaskId
      || reconciliation.mergeCommitSha !== row.acceptedMerge.commitSha
      || reconciliation.productCommitSha !== row.checkpointProduct.commitSha
      || !exactSet(reconciliationPaths, reconciliation.paths || [])
      || reconciliation.pathCount !== reconciliationPaths.length
      || reconciliation.stableDigest !== stableDigest([...reconciliationPaths].sort())
      || reconciliationPaths.some((repoPath) => CHECKPOINT_PRODUCT_PUBLICATION_PATHS.includes(repoPath))) {
      throw new Error(`checkpoint-product-reconciliation-mismatch:${row.sequence}:${reconciliationPaths.join(',')}`);
    }
    const productOwnership = readJsonAt(
      root,
      row.acceptedMerge.commitSha,
      'specs/005-analysis-final-closure/contracts/task-ownership.json',
    );
    const reconciliationLane = validateTaskInventory({
      taskId: checkpointOwnerTaskId,
      actualPaths: reconciliationPaths,
      ownership: productOwnership,
      requireNonEmpty: false,
    });
    const componentAllowedPaths = productOwnership?.tasks?.[row.acceptedTaskId]?.allowedPaths || [];
    if (!reconciliationLane.ok
      || reconciliationPaths.some((repoPath) => pathAllowed(repoPath, componentAllowedPaths))) {
      throw new Error(`checkpoint-product-reconciliation-owner-invalid:${row.sequence}:${reconciliationLane.errors.join(',')}`);
    }
    const expectedGeneration = checkpointGenerationEvidence(root, {
      acceptedMerge: row.acceptedMerge,
      checkpointProduct: row.checkpointProduct,
      integrationReconciliation: reconciliation,
    });
    if (canonicalJson(row.generation) !== canonicalJson(expectedGeneration)) {
      throw new Error(`checkpoint-generation-evidence-mismatch:${row.sequence}`);
    }
    const candidateIdentity = Object.freeze({
      headSha: row.checkpointProduct.commitSha,
      treeSha: row.checkpointProduct.treeSha,
    });
    const checkpointOwnership = readJsonAt(
      root,
      row.checkpointProduct.commitSha,
      'specs/005-analysis-final-closure/contracts/task-ownership.json',
    );
    if (computeInitialCandidateGateDigest(checkpointOwnership) !== row.initialCandidateGateDigest) {
      throw new Error(`checkpoint-gate-registry-content-mismatch:${row.sequence}`);
    }
    try {
      verifyRecordedRollingProductEvidence(
        root,
        checkpointOwnership,
        cumulativeTaskIds,
        candidateIdentity,
        row.rollingProductGates,
      );
    } catch {
      throw new Error(`checkpoint-rolling-evidence-mismatch:${row.sequence}`);
    }
    const shadowGates = cumulativeTaskIds.flatMap((taskId) => {
      const gates = checkpointOwnership?.candidateGates?.tasks?.[taskId]?.shadow;
      return Array.isArray(gates) ? gates.map((gate) => ({ taskId, gate })) : [];
    });
    const recordedReports = row.independentShadowVerifier?.reports;
    if (shadowGates.length === 0
      || cumulativeTaskIds.some((taskId) => {
        const gates = checkpointOwnership?.candidateGates?.tasks?.[taskId]?.shadow;
        return !Array.isArray(gates) || gates.length === 0;
      })
      || !Array.isArray(recordedReports)
      || shadowGates.length !== recordedReports.length) {
      throw new Error(`checkpoint-shadow-report-set-mismatch:${row.sequence}`);
    }
    const expectedReports = shadowGates.map(({ taskId, gate }) => {
      const recorded = recordedReports.find(
        (report) => report?.taskId === taskId && report?.gateId === gate.id,
      );
      if (!recorded) {
        throw new Error(`checkpoint-shadow-report-missing:${row.sequence}:${taskId}:${gate.id}`);
      }
      return createShadowGateEvidenceAt({
        root,
        commitSha: row.checkpointProduct.commitSha,
        authoritySha: row.acceptedMerge.commitSha,
        ownership: checkpointOwnership,
        taskId,
        gate,
        headSha: candidateIdentity.headSha,
        treeSha: candidateIdentity.treeSha,
        oracleObservation: recorded?.observations?.oracle,
        productObservation: recorded?.observations?.product,
      });
    });
    if (new Set(recordedReports.map(
      (report) => `${String(report?.taskId)}\0${String(report?.gateId)}`,
    )).size !== recordedReports.length
      || expectedReports.some((report, index) => canonicalJson(report) !== canonicalJson(recordedReports[index]))) {
      throw new Error(`checkpoint-shadow-report-mismatch:${row.sequence}`);
    }
    const expectedShadow = checkpointShadowGateEvidence(candidateIdentity, expectedReports);
    if (canonicalJson(row.independentShadowVerifier) !== canonicalJson(expectedShadow)) {
      throw new Error(`checkpoint-shadow-evidence-mismatch:${row.sequence}`);
    }
  }
  const latest = ledger.checkpoints.at(-1);
  const evidenceCommitSha = evidenceCommitShas.at(-1);
  if (!validSha1(evidenceCommitSha)) throw new Error(`checkpoint-evidence-commit-missing:${evidencePath}`);
  assertAncestor(root, evidenceCommitSha, integrationHeadSha, 'checkpoint-evidence-not-ancestor');
  const requiresExactCheckpointHead = componentMode
    || (checkpointResult.remainingComponentTaskIds || []).length > 0;
  const tailMainReconciliation = requiresExactCheckpointHead
    ? derivedTailMainReconciliation(root, {
      previousEvidenceSha: evidenceCommitSha,
      integrationHeadSha,
      currentMainSha,
    })
    : null;

  let priorCumulativePaths = [];
  for (let index = 0; index < ledger.checkpoints.length; index += 1) {
    const row = ledger.checkpoints[index];
    const checkpointEvidenceCommitSha = evidenceCommitShas[index];
    const observedEvidenceCommitSha = git(root, [
      'log', '-1', '--format=%H', checkpointEvidenceCommitSha, '--', evidencePath,
    ]);
    if (observedEvidenceCommitSha !== checkpointEvidenceCommitSha) {
      throw new Error(`checkpoint-evidence-commit-mismatch:${row.sequence}:${checkpointEvidenceCommitSha}:${observedEvidenceCommitSha}`);
    }
    const evidenceParents = git(root, ['show', '-s', '--format=%P', checkpointEvidenceCommitSha])
      .split(/\s+/)
      .filter(Boolean);
    if (evidenceParents.length !== 1 || evidenceParents[0] !== row.checkpointProduct.commitSha) {
      throw new Error(`checkpoint-evidence-parent-mismatch:${row.sequence}:${row.checkpointProduct.commitSha}:${evidenceParents.join(',')}`);
    }
    const evidencePaths = changedPaths(root, row.checkpointProduct.commitSha, checkpointEvidenceCommitSha);
    const allowedEvidencePaths = CHECKPOINT_EVIDENCE_ALLOWED_PATHS[ledger.campaignStage] || [];
    const invalidEvidencePaths = evidencePaths.filter(
      (repoPath) => !allowedEvidencePaths.includes(repoPath),
    );
    const missingEvidencePaths = allowedEvidencePaths.filter(
      (repoPath) => !evidencePaths.includes(repoPath),
    );
    if (invalidEvidencePaths.length > 0 || missingEvidencePaths.length > 0) {
      throw new Error(`checkpoint-evidence-path-set-invalid:${row.sequence}:invalid=${invalidEvidencePaths.join(',')}:missing=${missingEvidencePaths.join(',')}`);
    }
    const historicalErrors = [];
    const historicalLedger = parseEvidenceJsonBlock(
      readTextAt(root, checkpointEvidenceCommitSha, evidencePath),
      CHECKPOINT_BLOCKS[ledger.campaignStage],
      historicalErrors,
    );
    const expectedHistoricalLedger = {
      schemaVersion: CHECKPOINT_LEDGER_SCHEMA_VERSION,
      campaignStage: ledger.campaignStage,
      checkpoints: ledger.checkpoints.slice(0, index + 1),
    };
    if (historicalErrors.length > 0
      || canonicalJson(historicalLedger) !== canonicalJson(expectedHistoricalLedger)) {
      throw new Error(`checkpoint-evidence-ledger-mismatch:${row.sequence}`);
    }
    const actualCumulativePaths = changedPaths(
      root,
      row.cumulativeInventory.baseSha,
      checkpointEvidenceCommitSha,
    );
    const actualCumulativeDigest = stableDigest(actualCumulativePaths);
    if (row.cumulativeInventory.pathCount !== actualCumulativePaths.length
      || row.cumulativeInventory.stableDigest !== actualCumulativeDigest) {
      throw new Error(`checkpoint-cumulative-inventory-operational-mismatch:${row.sequence}`);
    }
    const previousBaseSha = index > 0
      ? ledger.checkpoints[index - 1].cumulativeInventory.baseSha
      : row.cumulativeInventory.baseSha;
    if (previousBaseSha === row.cumulativeInventory.baseSha
      && priorCumulativePaths.some((repoPath) => !actualCumulativePaths.includes(repoPath))) {
      throw new Error(`checkpoint-cumulative-inventory-nonmonotonic:${row.sequence}`);
    }
    priorCumulativePaths = actualCumulativePaths;
  }
  const currentCumulativePaths = changedPaths(
    root,
    latest.cumulativeInventory.baseSha,
    integrationHeadSha,
  );
  if (latest.cumulativeInventory.baseSha === result.integrationBaseSha
    && priorCumulativePaths.some((repoPath) => !currentCumulativePaths.includes(repoPath))) {
    throw new Error('checkpoint-current-inventory-lost-path');
  }
  return Object.freeze({
    sequence,
    acceptedTaskId: latest.acceptedTaskId,
    acceptedMergeCommitSha: latest.acceptedMerge.commitSha,
    productCommitSha: latest.checkpointProduct.commitSha,
    evidenceCommitSha,
    tailMainReconciliation,
  });
}

export function canonicalTaskHandoffAnchor(root, integrationHeadSha, taskId) {
  if (!/^T\d{3}$/.test(String(taskId || '')) || !validSha1(integrationHeadSha)) {
    throw new Error(`task-handoff-canonical-input-invalid:${String(taskId)}`);
  }
  const tasksPath = 'specs/005-analysis-final-closure/tasks.md';
  const inventoryPath = 'specs/005-analysis-final-closure/contracts/integration-inventory.json';
  const history = git(root, [
    'rev-list', '--full-history', '--topo-order', '--reverse', integrationHeadSha, '--', tasksPath,
  ]).split('\n').filter(Boolean);
  const statusCache = new Map();
  const statusAt = (commitSha) => {
    if (statusCache.has(commitSha)) return statusCache.get(commitSha);
    const historicalTasks = readOptionalText(root, tasksPath, commitSha);
    const status = historicalTasks == null
      ? null
      : (taskStatusMap(taskBlocks(String(historicalTasks))).get(taskId) ?? null);
    statusCache.set(commitSha, status);
    return status;
  };
  const transitions = [];
  for (const commitSha of history) {
    if (statusAt(commitSha) !== 'DONE') continue;
    const [, ...parentShas] = git(root, ['rev-list', '--parents', '-n', '1', commitSha])
      .split(/\s+/)
      .filter(Boolean);
    if (parentShas.every((parentSha) => statusAt(parentSha) !== 'DONE')) {
      transitions.push(commitSha);
    }
  }
  if (transitions.length === 0) {
    throw new Error(`task-handoff-canonical-transition-missing:${taskId}`);
  }
  if (transitions.length !== 1) {
    throw new Error(`task-handoff-canonical-transition-ambiguous:${taskId}:${transitions.length}`);
  }
  const [transitionCommitSha] = transitions;
  for (const commitSha of history) {
    if (commitSha === transitionCommitSha) continue;
    const descendant = runGit(root, ['merge-base', '--is-ancestor', transitionCommitSha, commitSha]);
    if (descendant.status > 1) {
      throw new Error(`task-handoff-canonical-history-invalid:${taskId}:${commitSha}`);
    }
    if (descendant.status === 0 && statusAt(commitSha) !== 'DONE') {
      throw new Error(`task-handoff-canonical-status-regressed:${taskId}:${commitSha}`);
    }
  }
  if (statusAt(integrationHeadSha) !== 'DONE') {
    throw new Error(`task-handoff-canonical-current-status-invalid:${taskId}`);
  }
  const historicalInventoryText = readOptionalText(root, inventoryPath, transitionCommitSha);
  let historicalInventory;
  try {
    historicalInventory = JSON.parse(String(historicalInventoryText));
  } catch {
    throw new Error(`task-handoff-canonical-transition-invalid:${taskId}:${transitionCommitSha}`);
  }
  const handoff = historicalInventory?.taskHandoffs?.[taskId];
  if (!handoff
    || !exactSet(Object.keys(handoff), ['headSha', 'treeSha', 'evidencePath'])
    || !validSha1(handoff.headSha)
    || !validSha1(handoff.treeSha)
    || !validRepoPath(handoff.evidencePath)) {
    throw new Error(`task-handoff-canonical-transition-invalid:${taskId}:${transitionCommitSha}`);
  }
  if (handoff.headSha === transitionCommitSha) {
    throw new Error(`task-handoff-canonical-head-not-prior:${taskId}`);
  }
  assertAncestor(root, handoff.headSha, transitionCommitSha, `task-handoff-canonical-head-not-prior:${taskId}`);
  const observedTree = git(root, ['rev-parse', `${handoff.headSha}^{tree}`]);
  if (observedTree !== handoff.treeSha) {
    throw new Error(`task-handoff-canonical-transition-invalid:${taskId}:${transitionCommitSha}`);
  }
  const evidence = runGit(root, ['cat-file', '-e', `${handoff.headSha}:${handoff.evidencePath}`]);
  if (evidence.status !== 0) {
    throw new Error(`task-handoff-canonical-transition-invalid:${taskId}:${transitionCommitSha}`);
  }
  return Object.freeze({
    taskId,
    transitionCommitSha,
    handoff: Object.freeze({ ...handoff }),
  });
}

export function verifyTaskHandoffs(root, result, integrationHeadSha, {
  requireCompleteOwners = false,
} = {}) {
  const handoffs = result?.taskHandoffResult?.handoffs || {};
  for (const [taskId, handoff] of Object.entries(handoffs)) {
    const resolved = runGit(root, ['rev-parse', '--verify', `${handoff.headSha}^{commit}`]);
    if (resolved.status !== 0) throw new Error(`task-handoff-head-missing:${taskId}:${handoff.headSha}`);
    const observedTree = git(root, ['rev-parse', `${handoff.headSha}^{tree}`]);
    if (observedTree !== handoff.treeSha) {
      throw new Error(`task-handoff-tree-mismatch:${taskId}:${handoff.treeSha}:${observedTree}`);
    }
    assertAncestor(root, handoff.headSha, integrationHeadSha, `task-handoff-head-stale:${taskId}`);
    const evidence = runGit(root, ['cat-file', '-e', `${handoff.headSha}:${handoff.evidencePath}`]);
    if (evidence.status !== 0) throw new Error(`task-handoff-evidence-missing:${taskId}:${handoff.evidencePath}`);
  }
  const completedTaskIds = new Set(result?.taskHandoffResult?.completedTaskIds || []);
  const canonicalHandoffs = {};
  for (const taskId of ['T046', 'T025']) {
    if (!completedTaskIds.has(taskId)) continue;
    const canonical = canonicalTaskHandoffAnchor(root, integrationHeadSha, taskId);
    if (canonicalJson(handoffs[taskId]) !== canonicalJson(canonical.handoff)) {
      throw new Error(`task-handoff-canonical-mismatch:${taskId}`);
    }
    canonicalHandoffs[taskId] = canonical;
  }
  const canonicalT046 = canonicalHandoffs.T046 ?? null;
  const sealOwnedPaths = requireCompleteOwners || completedTaskIds.has('T046');
  const mutableCoordinationPaths = new Set([
    'specs/005-analysis-final-closure/contracts/integration-inventory.json',
    'specs/005-analysis-final-closure/tasks.md',
  ]);
  for (const entry of result?.taskHandoffResult?.inventoryEntries || []) {
    const ownerTaskId = entry?.ownerTaskId;
    const handoff = canonicalHandoffs[ownerTaskId]?.handoff ?? handoffs[ownerTaskId];
    if (!handoff) {
      if (requireCompleteOwners && !['T049', 'T050'].includes(ownerTaskId)) {
        throw new Error(`task-handoff-inventory-owner-incomplete:${ownerTaskId}:${entry?.path}`);
      }
      continue;
    }
    if (!sealOwnedPaths || mutableCoordinationPaths.has(entry.path)) continue;
    const unchanged = runGit(root, [
      'diff', '--quiet', handoff.headSha, integrationHeadSha, '--', entry.path,
    ]);
    if (unchanged.status !== 0) {
      throw new Error(`task-handoff-owned-path-changed:${ownerTaskId}:${entry.path}`);
    }
  }
  return Object.freeze({
    taskCount: Object.keys(handoffs).length,
    canonicalT046TransitionCommitSha: canonicalT046?.transitionCommitSha ?? null,
    canonicalT025TransitionCommitSha: canonicalHandoffs.T025?.transitionCommitSha ?? null,
  });
}

function contractBundle(root, commitSha = null) {
  const text = (relativePath) => (commitSha == null
    ? fs.readFileSync(path.join(root, relativePath), 'utf8')
    : readTextAt(root, commitSha, relativePath));
  const json = (relativePath) => JSON.parse(text(relativePath));
  const integrationInventory = json('specs/005-analysis-final-closure/contracts/integration-inventory.json');
  const t025Handoff = integrationInventory?.taskHandoffs?.T025;
  const roadmapMatrixPath = 'specs/005-analysis-final-closure/evidence/roadmap-matrix.md';
  const roadmapMatrixBlob = commitSha == null
    ? (fs.existsSync(path.join(root, roadmapMatrixPath))
      ? worktreeBlobEvidence(root, roadmapMatrixPath)
      : null)
    : optionalBlobEvidenceAt(root, commitSha, roadmapMatrixPath);
  const roadmapMatrixHandoffBlob = typeof t025Handoff?.headSha === 'string'
    && typeof t025Handoff?.evidencePath === 'string'
    ? optionalBlobEvidenceAt(root, t025Handoff.headSha, t025Handoff.evidencePath)
    : null;
  return Object.freeze({
    tasksText: text('specs/005-analysis-final-closure/tasks.md'),
    ownership: json('specs/005-analysis-final-closure/contracts/task-ownership.json'),
    integrationInventory,
    platformLocks: json('specs/005-analysis-final-closure/contracts/final-platform-locks.json'),
    performanceLocks: json('specs/005-analysis-final-closure/contracts/performance-locks.json'),
    packageJson: json('package.json'),
    workflowText: text('.github/workflows/final-closure-preflight.yml'),
    preFanoutText: text('specs/005-analysis-final-closure/evidence/pre-fanout.md'),
    stageAPostMergeText: readOptionalText(
      root,
      'specs/005-analysis-final-closure/evidence/stage-a-post-merge.md',
      commitSha,
    ),
    stageBPreflightText: readOptionalText(
      root,
      'specs/005-analysis-final-closure/evidence/stage-b-preflight.md',
      commitSha,
    ),
    stageBResidualCoverageText: readOptionalText(
      root,
      STAGE_B_RESIDUAL_COVERAGE_PATH,
      commitSha,
    ),
    roadmapMatrixText: readOptionalText(
      root,
      roadmapMatrixPath,
      commitSha,
    ),
    roadmapMatrixSha256: roadmapMatrixBlob?.sha256 ?? null,
    roadmapMatrixHandoffSha256: roadmapMatrixHandoffBlob?.sha256 ?? null,
    checkpointEvidenceText: typeof integrationInventory?.checkpoint?.evidencePath === 'string'
      ? readOptionalText(root, integrationInventory.checkpoint.evidencePath, commitSha)
      : null,
    shadowAuthority: Object.fromEntries(SHADOW_AUTHORITY_ARTIFACTS.map(({ path: repoPath }) => [
      repoPath,
      text(repoPath),
    ])),
    verifierText: text('tools/validation/final-closure/preflight.mjs'),
  });
}

function validateComponentLane({ authority, bundle, root, candidateHeadSha, stageBApplicability }) {
  const blocks = taskBlocks(bundle.tasksText);
  const dependencies = dependencyMap(blocks);
  const statuses = taskStatusMap(blocks);
  if (!bundle.ownership?.tasks?.[authority.taskId] || !statuses.has(authority.taskId)) {
    throw new Error(`component-task-unknown:${authority.taskId}`);
  }
  if (bundle.integrationInventory?.campaignStage === 'STAGE_B') {
    if (stageBApplicability?.required !== true || stageBApplicability?.valid !== true) {
      throw new Error(`component-stage-b-fanout-not-green:${authority.taskId}`);
    }
    if (stageBApplicability.actionsByTask?.[authority.taskId] !== 'IMPLEMENT') {
      throw new Error(
        `component-task-not-implement:${authority.taskId}:${String(stageBApplicability.actionsByTask?.[authority.taskId] || 'MISSING')}`,
      );
    }
  }
  if (statuses.get(authority.taskId) !== 'PENDING') {
    throw new Error(`component-task-not-pending:${authority.taskId}:${statuses.get(authority.taskId) || 'UNKNOWN'}`);
  }
  if (bundle.integrationInventory?.taskHandoffs?.[authority.taskId] != null) {
    throw new Error(`component-task-already-handed-off:${authority.taskId}`);
  }
  for (const dependencyId of dependencies.get(authority.taskId) || []) {
    if (statuses.get(dependencyId) !== 'DONE') {
      throw new Error(`component-task-dependency-not-done:${authority.taskId}:${dependencyId}:${statuses.get(dependencyId) || 'UNKNOWN'}`);
    }
  }
  const forkPointSha = git(root, ['merge-base', authority.baseSha, authority.headSha]);
  const actualPaths = changedPaths(root, forkPointSha, authority.headSha);
  const candidatePaths = changedPaths(root, authority.baseSha, candidateHeadSha);
  const componentInventory = validateTaskInventory({
    taskId: authority.taskId,
    actualPaths,
    ownership: bundle.ownership,
  });
  const candidateInventory = validateTaskInventory({
    taskId: authority.taskId,
    actualPaths: candidatePaths,
    ownership: bundle.ownership,
  });
  const inventoryErrors = [...componentInventory.errors, ...candidateInventory.errors];
  if (inventoryErrors.length > 0) {
    throw new Error(`component-inventory-invalid:\n${[...new Set(inventoryErrors)].join('\n')}`);
  }
  return Object.freeze({ taskId: authority.taskId, forkPointSha, actualPaths, candidatePaths });
}

function assertAuthorityIntegrationRef(authority, integrationInventory) {
  if (!authority || authority.eventName !== 'pull_request') return;
  const observedRef = authority.mode === 'component' ? authority.baseRef : authority.headRef;
  if (observedRef !== integrationInventory?.integrationRef) {
    throw new Error(`github-event-integration-ref-mismatch:${observedRef}:${String(integrationInventory?.integrationRef)}`);
  }
}

function preflightReport({
  root,
  bundle,
  result,
  githubAuthority,
  headSha,
  treeSha,
  baseSha,
  mergeBaseSha,
  mergeTreeSha,
  performanceSourceIdentity,
  stageTransitionIdentity,
  checkpointIdentity,
  taskHandoffIdentity,
  component = null,
}) {
  return Object.freeze({
    schemaVersion: PREFLIGHT_SCHEMA_VERSION,
    verdict: 'PREFLIGHT_GREEN',
    mode: component ? 'COMPONENT_CANDIDATE' : 'INTEGRATION_HEAD',
    headSha,
    treeSha,
    baseSha,
    mergeBaseSha,
    mergeTreeSha,
    ...(component && {
      componentTaskId: component.taskId,
      componentHeadSha: githubAuthority.headSha,
      componentPathCount: component.actualPaths.length,
      componentActualChangedPaths: Object.freeze([...component.actualPaths]),
      componentInventoryDigest: stableDigest([...component.actualPaths].sort()),
      componentForkPointSha: component.forkPointSha,
      componentCandidatePathCount: component.candidatePaths.length,
      componentCandidateChangedPaths: Object.freeze([...component.candidatePaths]),
      componentCandidateInventoryDigest: stableDigest([...component.candidatePaths].sort()),
      integrationBaseSha: bundle.integrationInventory.baseSha,
    }),
    verifierIdentity: Object.freeze({
      schemaVersion: PREFLIGHT_SCHEMA_VERSION,
      sha256: sha256Text(bundle.verifierText),
    }),
    corpusIdentity: Object.freeze({
      denominatorStableDigest: bundle.platformLocks.denominatorStableDigest,
      fixtureSetStableDigest: bundle.platformLocks.denominator.fixtureSet.stableDigest,
      fullLockStableDigest: stableDigest(bundle.platformLocks),
      performanceLockStableDigest: stableDigest(bundle.performanceLocks),
      performanceSourceIdentity,
    }),
    toolchainIdentity: Object.freeze({
      node: process.version,
      git: git(root, ['--version']),
      platform: process.platform,
      architecture: process.arch,
    }),
    runtimeIdentity: Object.freeze({
      requiredClassIds: REQUIRED_RUNTIME_CLASSES,
      stableDigest: stableDigest(bundle.platformLocks.runtimeClasses),
    }),
    deploymentIdentity: 'NOT_EVALUATED_AT_PREFLIGHT',
    generatedArtifactIdentity: 'NOT_OWNED_BY_PREFLIGHT',
    invocationIdentity: githubAuthority,
    stageTransitionIdentity,
    checkpointIdentity,
    taskHandoffIdentity,
    actualInventoryDigest: result.integrationInventoryDigest,
    foundationOwnershipDigest: result.foundationOwnershipDigest,
    initialCandidateGateDigest: result.candidateGateResult.initialDigest,
    actualInventoryPathCount: result.integrationPathCount,
    taskCount: result.taskIds.length,
    requiredRuntimeClassCount: result.requiredRuntimeClassCount,
    requiredWorkloadCount: result.requiredWorkloadCount,
  });
}

export function runPreflight({ root = ROOT, expectedSha, expectedBaseSha, environment = process.env }) {
  const githubAuthority = githubInvocationAuthority(environment);
  if (githubAuthority) {
    if (expectedSha != null && expectedSha !== githubAuthority.headSha) {
      throw new Error(`github-event-head-argument-mismatch:${expectedSha}:${githubAuthority.headSha}`);
    }
    if (expectedBaseSha != null && expectedBaseSha !== githubAuthority.baseSha) {
      throw new Error(`github-event-base-argument-mismatch:${expectedBaseSha}:${githubAuthority.baseSha}`);
    }
  }

  const observedHeadSha = git(root, ['rev-parse', 'HEAD']);
  const treeSha = git(root, ['rev-parse', 'HEAD^{tree}']);
  const dirty = git(root, ['status', '--porcelain', '--untracked-files=all']);
  if (dirty) throw new Error(`preflight-worktree-not-clean:\n${dirty}`);

  if (githubAuthority?.mode === 'component') {
    fetchComponentAuthority(root, githubAuthority);
    const currentMainSha = fetchCurrentMain(root);
    const parents = git(root, ['show', '-s', '--format=%P', observedHeadSha]).split(/\s+/).filter(Boolean);
    if (!exactSet(parents, [githubAuthority.baseSha, githubAuthority.headSha])
      || parents[0] !== githubAuthority.baseSha || parents[1] !== githubAuthority.headSha) {
      throw new Error(`component-candidate-parents-invalid:${parents.join(',')}`);
    }
    const mergeTreeSha = candidateMergeTree(root, githubAuthority.baseSha, githubAuthority.headSha);
    if (mergeTreeSha !== treeSha) {
      throw new Error(`component-candidate-tree-mismatch:${mergeTreeSha}:${treeSha}`);
    }
    assertAncestor(root, currentMainSha, githubAuthority.baseSha, 'component-integration-base-stale');
    const bundle = contractBundle(root, githubAuthority.baseSha);
    if (bundle.integrationInventory.integrationRef !== githubAuthority.baseRef) {
      throw new Error(`component-integration-ref-mismatch:${githubAuthority.baseRef}:${bundle.integrationInventory.integrationRef}`);
    }
    assertAuthorityIntegrationRef(githubAuthority, bundle.integrationInventory);
    const integrationPaths = changedPaths(root, currentMainSha, githubAuthority.baseSha);
    const result = validatePreflightContracts({
      ...bundle,
      actualChangedPaths: integrationPaths,
      expectedBaseSha: currentMainSha,
    });
    if (!result.ok) throw new Error(`preflight-contract-invalid:\n${result.errors.join('\n')}`);
    const component = validateComponentLane({
      authority: githubAuthority,
      bundle,
      root,
      candidateHeadSha: observedHeadSha,
      stageBApplicability: result.stageBApplicability,
    });
    const taskHandoffIdentity = verifyTaskHandoffs(root, result, githubAuthority.baseSha, {
      requireCompleteOwners: true,
    });
    const performanceSourceIdentity = verifyPerformanceLockSources(root, bundle.performanceLocks);
    const checkpointIdentity = verifyCheckpointOperationalEvidence(root, result, githubAuthority.baseSha, {
      componentMode: true,
      currentMainSha,
    });
    const stageTransitionIdentity = bundle.integrationInventory.campaignStage === 'STAGE_B'
      ? verifyStageBOperationalEvidence(root, result.stageEvidence, currentMainSha)
      : null;
    return preflightReport({
      root,
      bundle,
      result,
      githubAuthority,
      headSha: observedHeadSha,
      treeSha,
      baseSha: githubAuthority.baseSha,
      mergeBaseSha: git(root, ['merge-base', githubAuthority.baseSha, githubAuthority.headSha]),
      mergeTreeSha,
      performanceSourceIdentity,
      stageTransitionIdentity,
      checkpointIdentity,
      taskHandoffIdentity,
      component,
    });
  }

  const authorizedHeadSha = githubAuthority?.headSha ?? expectedSha;
  const authorizedBaseSha = githubAuthority?.baseSha ?? expectedBaseSha;
  assertExactHead(authorizedHeadSha, observedHeadSha);
  const currentMainSha = fetchCurrentMain(root);
  try {
    assertExactHead(authorizedBaseSha, currentMainSha);
  } catch (error) {
    if (error?.message?.startsWith('exact-head-mismatch:')) {
      throw new Error(`exact-base-mismatch: expected ${authorizedBaseSha}, observed ${currentMainSha}`);
    }
    throw error;
  }
  assertAncestor(root, currentMainSha, observedHeadSha, 'candidate-does-not-contain-current-main');
  const mergeBaseSha = git(root, ['merge-base', currentMainSha, observedHeadSha]);
  if (mergeBaseSha !== currentMainSha) {
    throw new Error(`candidate-merge-base-mismatch:${mergeBaseSha}:${currentMainSha}`);
  }
  const mergeTreeSha = candidateMergeTree(root, currentMainSha, observedHeadSha);
  if (mergeTreeSha !== treeSha) {
    throw new Error(`candidate-merge-tree-not-head-tree:${mergeTreeSha}:${treeSha}`);
  }
  const bundle = contractBundle(root);
  if (githubAuthority?.eventName === 'pull_request'
    && bundle.integrationInventory.integrationRef !== githubAuthority.headRef) {
    throw new Error(`integration-head-ref-mismatch:${githubAuthority.headRef}:${bundle.integrationInventory.integrationRef}`);
  }
  assertAuthorityIntegrationRef(githubAuthority, bundle.integrationInventory);
  const result = validatePreflightContracts({
    ...bundle,
    actualChangedPaths: changedPaths(root, currentMainSha, observedHeadSha),
    expectedBaseSha: currentMainSha,
  });
  if (!result.ok) throw new Error(`preflight-contract-invalid:\n${result.errors.join('\n')}`);
  const taskHandoffIdentity = verifyTaskHandoffs(root, result, observedHeadSha);
  const performanceSourceIdentity = verifyPerformanceLockSources(root, bundle.performanceLocks);
  const checkpointIdentity = verifyCheckpointOperationalEvidence(root, result, observedHeadSha, {
    currentMainSha,
  });
  const stageTransitionIdentity = bundle.integrationInventory.campaignStage === 'STAGE_B'
    ? verifyStageBOperationalEvidence(root, result.stageEvidence, currentMainSha)
    : null;
  return preflightReport({
    root,
    bundle,
    result,
    githubAuthority: githubAuthority || Object.freeze({
      eventName: 'local-exact-cli',
      mode: 'integration',
      headSha: authorizedHeadSha,
      baseSha: authorizedBaseSha,
    }),
    headSha: observedHeadSha,
    treeSha,
    baseSha: currentMainSha,
    mergeBaseSha,
    mergeTreeSha,
    performanceSourceIdentity,
    stageTransitionIdentity,
    checkpointIdentity,
    taskHandoffIdentity,
  });
}

export function createShadowGateEvidence({
  root = ROOT,
  ownership,
  taskId,
  gate,
  headSha,
  treeSha,
  authoritySha,
  oracleObservation,
  productObservation,
}) {
  const candidateParentShas = git(root, ['show', '-s', '--format=%P', headSha])
    .split(/\s+/).filter(Boolean);
  return buildShadowGateEvidence({
    ownership,
    taskId,
    gate,
    headSha,
    treeSha,
    oracleObservation,
    productObservation,
    authoritySha,
    blobEvidence: (repoPath) => worktreeBlobEvidence(root, repoPath),
    authorityBlobEvidence: (repoPath) => blobEvidenceAt(root, authoritySha, repoPath),
    candidateParentShas,
    readJson: (repoPath) => readJsonAt(root, authoritySha, repoPath),
  });
}

export function emitShadowGateEvidence({
  root = ROOT,
  taskId,
  expectedSha,
  expectedTree,
  authoritySha,
  spawn = spawnSync,
  environment = process.env,
} = {}) {
  if (!/^T\d{3}$/.test(String(taskId || ''))
    || !validSha1(expectedSha)
    || !validSha1(expectedTree)
    || !validSha1(authoritySha)) {
    throw new Error('shadow-emitter-identity-invalid');
  }
  const assertExactCandidate = () => {
    const observedHeadSha = git(root, ['rev-parse', 'HEAD']);
    const observedTreeSha = git(root, ['rev-parse', 'HEAD^{tree}']);
    const status = git(root, ['status', '--porcelain', '--untracked-files=all']);
    if (observedHeadSha !== expectedSha
      || observedTreeSha !== expectedTree
      || status !== '') {
      throw new Error('shadow-emitter-candidate-state-invalid');
    }
  };
  assertExactCandidate();
  const candidateParentShas = git(root, ['show', '-s', '--format=%P', expectedSha])
    .split(/\s+/).filter(Boolean);
  if (candidateParentShas[0] !== authoritySha) {
    throw new Error('shadow-authority-not-direct-parent');
  }
  const ownershipPath = 'specs/005-analysis-final-closure/contracts/task-ownership.json';
  const authorityOwnershipArtifact = blobEvidenceAt(root, authoritySha, ownershipPath);
  const candidateOwnershipArtifact = worktreeBlobEvidence(root, ownershipPath);
  if (canonicalJson(authorityOwnershipArtifact) !== canonicalJson(candidateOwnershipArtifact)) {
    throw new Error('shadow-authority-ownership-drift');
  }
  const ownership = readJsonAt(root, authoritySha, ownershipPath);
  const shadowGates = ownership?.candidateGates?.tasks?.[taskId]?.shadow;
  if (!Array.isArray(shadowGates) || shadowGates.length !== 1) {
    throw new Error(`shadow-emitter-gate-set-invalid:${taskId}`);
  }
  const gate = shadowGates[0];
  for (const pin of ownership.candidateGates.shadowEvidence.authorityArtifacts) {
    const authorityArtifact = blobEvidenceAt(root, authoritySha, pin.path);
    const candidateArtifact = worktreeBlobEvidence(root, pin.path);
    if (canonicalJson(authorityArtifact) !== canonicalJson(candidateArtifact)) {
      throw new Error(`shadow-authority-candidate-drift:${pin.role}`);
    }
  }
  const shadow = shadowEvidenceContract(ownership, taskId, gate, {
    blobEvidence: (repoPath) => worktreeBlobEvidence(root, repoPath),
    readJson: (repoPath) => readJsonAt(root, authoritySha, repoPath),
  });
  for (const contractCase of shadow.contract.cases) {
    const judgePath = contractCase.projection.argv[1];
    const authorityJudge = blobEvidenceAt(root, authoritySha, judgePath);
    const candidateJudge = worktreeBlobEvidence(root, judgePath);
    if (canonicalJson(authorityJudge) !== canonicalJson(candidateJudge)) {
      throw new Error(`shadow-product-judge-drift:${taskId}:${contractCase.id}`);
    }
  }
  const runProvider = (side) => {
    const provider = shadow.registry.providers[side];
    const refsBefore = persistentRefSnapshot(root);
    const child = spawn(provider.argv[0], [
      ...provider.argv.slice(1),
      '--task', taskId,
      '--gate', gate.id,
    ], {
      cwd: root,
      env: { ...process.env, ...environment },
      shell: false,
      encoding: 'utf8',
      input: shadow.contractJson,
      stdio: ['pipe', 'pipe', 'inherit'],
      maxBuffer: 1024 * 1024,
    });
    const refsAfter = persistentRefSnapshot(root);
    assertOnlyAllowedRefChanges(refsBefore, refsAfter, []);
    assertExactCandidate();
    if (child?.error || child?.status !== 0) {
      throw new Error(`shadow-${side}-process-failed:${taskId}:${String(child?.status ?? 'SPAWN_ERROR')}`);
    }
    try {
      return JSON.parse(String(child.stdout ?? '').trim());
    } catch {
      throw new Error(`shadow-${side}-raw-observation-invalid:${taskId}`);
    }
  };
  const oracleObservation = runProvider('oracle');
  const productObservation = runProvider('product');
  return createShadowGateEvidence({
    root,
    ownership,
    taskId,
    gate,
    headSha: expectedSha,
    treeSha: expectedTree,
    authoritySha,
    oracleObservation,
    productObservation,
  });
}

function checkpointRuntimeEphemeralManifest(root) {
  const statusResult = runGit(root, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
    '--ignored=matching',
  ]);
  if (statusResult.status !== 0) throw new Error('checkpoint-runtime-status-read-failed');
  const statusPaths = dirtyStatusPaths(String(statusResult.stdout));
  const rootFor = (repoPath) => {
    const normalized = repoPath.endsWith('/') ? repoPath.slice(0, -1) : repoPath;
    return CHECKPOINT_RUNTIME_EPHEMERAL_ROOTS.find(
      (allowedRoot) => normalized === allowedRoot || normalized.startsWith(`${allowedRoot}/`),
    ) || null;
  };
  const unauthorized = statusPaths.filter((repoPath) => rootFor(repoPath) === null);
  if (unauthorized.length > 0) {
    throw new Error(`checkpoint-runtime-untracked-path:${unauthorized.join(',')}`);
  }
  const entries = CHECKPOINT_RUNTIME_EPHEMERAL_ROOTS.flatMap((repoPath) => {
    const absolute = path.join(root, repoPath);
    const stat = fs.lstatSync(absolute, { throwIfNoEntry: false });
    if (!stat) return [];
    if (stat.isSymbolicLink()) {
      return [{ path: repoPath, kind: 'SYMLINK', mode: stat.mode, target: fs.readlinkSync(absolute) }];
    }
    if (stat.isDirectory()) {
      return [{
        path: repoPath,
        kind: 'DIRECTORY',
        mode: stat.mode,
        treeSha256: hashDirectoryTree(absolute, {
          requireContainedSymlinks: repoPath === 'node_modules',
        }),
      }];
    }
    if (stat.isFile()) {
      return [{
        path: repoPath,
        kind: 'FILE',
        mode: stat.mode,
        size: stat.size,
        sha256: createHash('sha256').update(fs.readFileSync(absolute)).digest('hex'),
      }];
    }
    throw new Error(`checkpoint-runtime-ephemeral-special-file:${repoPath}`);
  });
  const payload = {
    schemaVersion: 'hex-final-closure-runtime-ephemeral-manifest/v1',
    allowedRoots: [...CHECKPOINT_RUNTIME_EPHEMERAL_ROOTS],
    entries,
  };
  return Object.freeze({
    ...payload,
    allowedRoots: Object.freeze(payload.allowedRoots),
    entries: Object.freeze(entries.map((entry) => Object.freeze(entry))),
    identity: sha256Text(canonicalJson(payload)),
  });
}

export function verifyCheckpointRuntimeEvidence({
  root = ROOT,
  result,
  integrationHeadSha,
  componentMode = false,
  environment = process.env,
  spawn = spawnSync,
} = {}) {
  const operational = verifyCheckpointOperationalEvidence(
    root,
    result,
    integrationHeadSha,
    { componentMode },
  );
  if (operational === null) {
    return Object.freeze({
      schemaVersion: 'hex-final-closure-checkpoint-runtime-report/v1',
      verdict: 'NOT_APPLICABLE_PREFANOUT',
      sequence: 0,
    });
  }
  const row = result.checkpointResult.ledger.checkpoints.at(-1);
  const cumulativeTaskIds = result.checkpointResult.ledger.checkpoints
    .map((checkpointRow) => checkpointRow.acceptedTaskId);
  const productIdentity = Object.freeze({
    headSha: row.checkpointProduct.commitSha,
    treeSha: row.checkpointProduct.treeSha,
  });
  const checkpointOwnership = readJsonAt(
    root,
    productIdentity.headSha,
    'specs/005-analysis-final-closure/contracts/task-ownership.json',
  );
  const temporaryWorktree = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-final-closure-checkpoint-runtime-'));
  let worktreeRegistered = false;
  let dependencyTreeSha256 = null;
  const run = (command, argv, { capture = false, errorCode }) => {
    const refsBefore = persistentRefSnapshot(root);
    const child = spawn(command, argv, {
      cwd: temporaryWorktree,
      env: { ...process.env, ...environment },
      shell: false,
      stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
      ...(capture && { encoding: 'utf8', maxBuffer: 1024 * 1024 }),
    });
    const refsAfter = persistentRefSnapshot(root);
    assertOnlyAllowedRefChanges(refsBefore, refsAfter, []);
    if (child?.error || child?.status !== 0) {
      throw new Error(`${errorCode}:${String(child?.status ?? 'SPAWN_ERROR')}`);
    }
    return child;
  };
  const assertProductState = (label, expectedEphemeralIdentity = null) => {
    const headSha = git(temporaryWorktree, ['rev-parse', 'HEAD']);
    const treeSha = git(temporaryWorktree, ['rev-parse', 'HEAD^{tree}']);
    const trackedStatus = git(temporaryWorktree, [
      'status', '--porcelain', '--untracked-files=no',
    ]);
    if (headSha !== productIdentity.headSha
      || treeSha !== productIdentity.treeSha
      || trackedStatus !== '') {
      throw new Error(`checkpoint-runtime-product-mutated:${row.sequence}:${label}`);
    }
    if (dependencyTreeSha256 !== null
      && hashDirectoryTree(path.join(temporaryWorktree, 'node_modules'), {
        requireContainedSymlinks: true,
      }) !== dependencyTreeSha256) {
      throw new Error(`checkpoint-runtime-dependency-mutated:${row.sequence}:${label}`);
    }
    const ephemeral = checkpointRuntimeEphemeralManifest(temporaryWorktree);
    if (expectedEphemeralIdentity != null && ephemeral.identity !== expectedEphemeralIdentity) {
      throw new Error(`checkpoint-runtime-ephemeral-mutated:${row.sequence}:${label}`);
    }
    return ephemeral;
  };
  try {
    const add = runGit(root, [
      'worktree', 'add', '--quiet', '--detach', temporaryWorktree, productIdentity.headSha,
    ]);
    if (add.status !== 0) throw new Error('checkpoint-runtime-worktree-create-failed');
    worktreeRegistered = true;
    run('npm', ['ci', '--no-audit', '--no-fund'], {
      errorCode: `checkpoint-runtime-dependency-install-failed:${row.sequence}`,
    });
    dependencyTreeSha256 = hashDirectoryTree(path.join(temporaryWorktree, 'node_modules'), {
      requireContainedSymlinks: true,
    });
    const dependencyInstallation = Object.freeze({
      schemaVersion: 'hex-final-closure-checkpoint-dependency-install/v1',
      argv: Object.freeze(['npm', 'ci', '--no-audit', '--no-fund']),
      candidateIdentity: productIdentity,
      packageJson: blobEvidenceAt(temporaryWorktree, productIdentity.headSha, 'package.json'),
      packageLock: blobEvidenceAt(temporaryWorktree, productIdentity.headSha, 'package-lock.json'),
      dependencyTreeSha256,
    });
    assertProductState('initial');
    run('node', ['scripts/build-userscript.mjs'], {
      errorCode: `checkpoint-runtime-generation-failed:${row.sequence}:first`,
    });
    const generatedEphemeral = assertProductState('generation-first');
    run('node', ['scripts/build-userscript.mjs'], {
      errorCode: `checkpoint-runtime-generation-failed:${row.sequence}:second`,
    });
    assertProductState('generation-second', generatedEphemeral.identity);
    const generation = checkpointGenerationEvidence(temporaryWorktree, {
      acceptedMerge: row.acceptedMerge,
      checkpointProduct: row.checkpointProduct,
      integrationReconciliation: row.integrationReconciliation,
    });
    if (canonicalJson(generation) !== canonicalJson(row.generation)) {
      throw new Error(`checkpoint-runtime-generation-evidence-mismatch:${row.sequence}`);
    }

    let rollingProductGates;
    try {
      rollingProductGates = executeRollingProductGates({
        root: temporaryWorktree,
        ownership: checkpointOwnership,
        ownershipCommitSha: productIdentity.headSha,
        taskIds: cumulativeTaskIds,
        candidateIdentity: productIdentity,
        spawn,
        environment,
        assertCandidateState: (label) => assertProductState(
          label,
          generatedEphemeral.identity,
        ),
      });
    } catch (error) {
      throw new Error(
        `checkpoint-runtime-rolling-failed:${row.sequence}:${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (canonicalJson(rollingReplayContract(rollingProductGates))
      !== canonicalJson(rollingReplayContract(row.rollingProductGates))) {
      throw new Error(`checkpoint-runtime-rolling-evidence-mismatch:${row.sequence}`);
    }

    const shadowGates = cumulativeTaskIds.flatMap((taskId) => {
      const gates = checkpointOwnership?.candidateGates?.tasks?.[taskId]?.shadow;
      return Array.isArray(gates) ? gates.map((gate) => ({ taskId, gate })) : [];
    });
    if (shadowGates.length === 0
      || cumulativeTaskIds.some((taskId) => {
        const gates = checkpointOwnership?.candidateGates?.tasks?.[taskId]?.shadow;
        return !Array.isArray(gates) || gates.length === 0;
      })) {
      throw new Error(`checkpoint-runtime-shadow-registry-missing:${row.sequence}`);
    }
    const shadowReports = shadowGates.map(({ taskId, gate }) => {
      assertProductState(`shadow-${gate.id}-before`, generatedEphemeral.identity);
      let observed;
      try {
        observed = emitShadowGateEvidence({
          root: temporaryWorktree,
          taskId,
          expectedSha: productIdentity.headSha,
          expectedTree: productIdentity.treeSha,
          authoritySha: row.acceptedMerge.commitSha,
          spawn,
          environment,
        });
      } catch {
        throw new Error(`checkpoint-runtime-shadow-report-invalid:${row.sequence}:${gate.id}`);
      }
      assertProductState(`shadow-${gate.id}-after`, generatedEphemeral.identity);
      return observed;
    });
    const independentShadowVerifier = checkpointShadowGateEvidence(productIdentity, shadowReports);
    if (canonicalJson(independentShadowVerifier) !== canonicalJson(row.independentShadowVerifier)) {
      throw new Error(`checkpoint-runtime-shadow-evidence-mismatch:${row.sequence}`);
    }
    return Object.freeze({
      schemaVersion: 'hex-final-closure-checkpoint-runtime-report/v1',
      verdict: 'CHECKPOINT_RUNTIME_GREEN',
      sequence: row.sequence,
      acceptedTaskId: row.acceptedTaskId,
      productIdentity,
      dependencyInstallation,
      generation,
      rollingProductGates,
      independentShadowVerifier,
      runtimeEphemeralIdentity: generatedEphemeral.identity,
    });
  } finally {
    if (worktreeRegistered) runGit(root, ['worktree', 'remove', '--force', temporaryWorktree]);
    fs.rmSync(temporaryWorktree, { recursive: true, force: true });
  }
}

export function runCheckpointVerification({
  root = ROOT,
  environment = process.env,
  spawn = spawnSync,
} = {}) {
  const authority = githubInvocationAuthority(environment);
  runPreflight({ root, environment });
  const componentMode = authority?.mode === 'component';
  const integrationHeadSha = componentMode ? authority.baseSha : git(root, ['rev-parse', 'HEAD']);
  const bundle = contractBundle(root, componentMode ? integrationHeadSha : null);
  const result = validatePreflightContracts(bundle);
  if (!result.ok) throw new Error(`preflight-contract-invalid:\n${result.errors.join('\n')}`);
  return verifyCheckpointRuntimeEvidence({
    root,
    result,
    integrationHeadSha,
    componentMode,
    environment,
    spawn,
  });
}

export function runComponentGates({
  root = ROOT,
  environment = process.env,
  spawn = spawnSync,
} = {}) {
  const authority = githubInvocationAuthority(environment);
  if (!authority || authority.mode !== 'component') throw new Error('component-gates-event-required');
  const preflight = runPreflight({ root, environment });
  const bundle = contractBundle(root, authority.baseSha);
  const taskGates = bundle.ownership.candidateGates.tasks[authority.taskId];
  if (!taskGates) throw new Error(`component-gates-task-missing:${authority.taskId}`);
  const initialEphemeral = checkpointRuntimeEphemeralManifest(root);
  const assertCandidateState = () => {
    const observedHeadSha = git(root, ['rev-parse', 'HEAD']);
    if (observedHeadSha !== preflight.headSha) {
      throw new Error(`component-gate-head-mismatch:${authority.taskId}:${preflight.headSha}:${observedHeadSha}`);
    }
    const observedTreeSha = git(root, ['rev-parse', 'HEAD^{tree}']);
    if (observedTreeSha !== preflight.treeSha) {
      throw new Error(`component-gate-tree-mismatch:${authority.taskId}:${preflight.treeSha}:${observedTreeSha}`);
    }
    const dirty = git(root, ['status', '--porcelain', '--untracked-files=all']);
    if (dirty) throw new Error(`component-gate-worktree-dirty:${authority.taskId}:\n${dirty}`);
    const ephemeral = checkpointRuntimeEphemeralManifest(root);
    if (ephemeral.identity !== initialEphemeral.identity) {
      throw new Error(`component-gate-ephemeral-mutated:${authority.taskId}`);
    }
  };
  const results = [];
  for (const kind of ['owned', 'rolling', 'shadow']) {
    for (const gate of taskGates[kind]) {
      assertCandidateState();
      const refsBefore = persistentRefSnapshot(root);
      const executedArgv = kind === 'shadow'
        ? [
          ...gate.argv,
          '--expect-sha', preflight.headSha,
          '--expect-tree', preflight.treeSha,
          '--authority-sha', authority.baseSha,
        ]
        : [...gate.argv];
      const shadowEvidence = kind === 'shadow'
        ? emitShadowGateEvidence({
          root,
          taskId: authority.taskId,
          expectedSha: preflight.headSha,
          expectedTree: preflight.treeSha,
          authoritySha: authority.baseSha,
          spawn,
          environment,
        })
        : null;
      const child = kind === 'shadow' ? { status: 0 } : spawn(executedArgv[0], executedArgv.slice(1), {
        cwd: root,
        env: { ...process.env, ...environment },
        shell: false,
        stdio: 'inherit',
      });
      if (child?.error) throw new Error(`component-gate-spawn-failed:${authority.taskId}:${kind}:${gate.id}`);
      const refsAfter = persistentRefSnapshot(root);
      assertOnlyAllowedRefChanges(refsBefore, refsAfter, []);
      assertCandidateState();
      if (child?.status !== 0) {
        throw new Error(`component-gate-failed:${authority.taskId}:${kind}:${gate.id}:${String(child?.status)}`);
      }
      results.push(Object.freeze({
        kind,
        id: gate.id,
        registeredArgvDigest: stableDigest(gate.argv),
        executedArgvDigest: stableDigest(executedArgv),
        candidateIdentity: shadowEvidence?.candidateIdentity ?? null,
        shadowEvidence,
        status: 'PASS',
      }));
    }
  }
  return Object.freeze({
    schemaVersion: 'hex-final-closure-component-gate-report/v1',
    verdict: 'COMPONENT_GATES_GREEN',
    taskId: authority.taskId,
    candidateCommitSha: preflight.headSha,
    candidateTreeSha: preflight.treeSha,
    componentHeadSha: preflight.componentHeadSha,
    componentActualChangedPaths: preflight.componentActualChangedPaths,
    componentInventoryDigest: preflight.componentInventoryDigest,
    initialCandidateGateDigest: preflight.initialCandidateGateDigest,
    results: Object.freeze(results),
  });
}

function argument(name, argv) {
  const index = argv.indexOf(name);
  return index === -1 ? null : argv[index + 1] ?? null;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const argv = process.argv.slice(2);
    const report = argv.includes('--run-checkpoint-verification')
      ? runCheckpointVerification()
      : argv.includes('--emit-shadow-evidence')
        ? emitShadowGateEvidence({
          taskId: argument('--task', argv),
          expectedSha: argument('--expect-sha', argv),
          expectedTree: argument('--expect-tree', argv),
          authoritySha: argument('--authority-sha', argv),
        })
      : argv.includes('--prepare-component-candidate')
      ? prepareComponentCandidate()
      : argv.includes('--run-component-gates')
        ? runComponentGates()
      : argv.includes('--verify-local-stage-b')
        ? verifyLocalStageBWorktree({ originalWorkspaceRoot: argument('--original-workspace', argv) })
        : runPreflight({
        expectedSha: argument('--expect-sha', argv),
        expectedBaseSha: argument('--expect-base-sha', argv),
      });
    console.log(JSON.stringify(report));
  } catch (error) {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  }
}
