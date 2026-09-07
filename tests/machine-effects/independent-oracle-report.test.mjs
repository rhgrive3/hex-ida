import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { createCorpus } from '../../tools/validation/machine-effects/oracle-corpus.mjs';
import {
  assertReleaseReady,
  createA2DenominatorSnapshot,
  createOracleReport,
  validateOracleReport,
} from '../../tools/validation/machine-effects/oracle-report.mjs';
import {
  inspectExactHead,
  parseArgs,
  verifyCandidateMergeTree,
  verifyExactHead,
} from '../../tools/validation/machine-effects/oracle-release-verify.mjs';
import { runIndependentComparison } from '../../tools/validation/machine-effects/oracle-runner.mjs';
import { sha256Digest } from '../../tools/validation/machine-effects/oracle-schema.mjs';
import { INDEPENDENT_ORACLE_CASE_FIXTURES } from './fixtures/independent-oracle-cases.mjs';
import {
  assessArchitecturalEvidence,
  createArchitecturalEvidence,
} from '../../tools/validation/machine-effects/oracle-evidence-v2.mjs';
import { evidenceInputForOracleCase } from './fixtures/evidence-v2-cases.mjs';

// This table is deliberately authored independently of the oracle fixture's
// expectedState.  The report test must detect disagreement between the two.
const INDEPENDENT_EXPECTED_OBSERVABLES = Object.freeze({
  'arm64:a64': Object.freeze({
    'flag:C': '0', 'flag:N': '1', 'flag:V': '1', 'flag:Z': '0',
    'register:x0': '0x8000000000000000',
    'register:x1': '0x7fffffffffffffff', 'register:x2': '0x0000000000000001',
    'vector:v0': '0x00112233445566778899aabbccddeeff',
  }),
  'arm64e:a64+pac': Object.freeze({
    'flag:C': '0', 'flag:N': '1', 'flag:V': '1', 'flag:Z': '0',
    'register:x0': '0x8000000000000000',
    'register:x1': '0x7fffffffffffffff', 'register:x2': '0x0000000000000001',
    'vector:v0': '0x00112233445566778899aabbccddeeff',
  }),
  'x86_64:long-64': Object.freeze({
    'flag:C': '0', 'flag:N': '1', 'flag:V': '1', 'flag:Z': '0',
    'register:rax': '0x8000000000000000', 'register:rbx': '0x0000000000000001',
  }),
  'riscv64:rv64imc': Object.freeze({
    'flag:C': '0', 'flag:N': '0', 'flag:V': '0', 'flag:Z': '0',
    'register:x1': '0x7fffffffffffffff', 'register:x2': '0x0000000000000001',
    'register:x5': '0x8000000000000000',
  }),
});

function independentlyAuthoredExpectedObservables(profileId) {
  const expected = INDEPENDENT_EXPECTED_OBSERVABLES[profileId];
  assert.ok(expected, `missing independent evidence fixture for ${profileId}`);
  return { ...expected };
}

assert.deepEqual(parseArgs(['--report', 'report.json', '--require-candidate-tree']), {
  report: 'report.json', requireCandidateTree: true,
});

const currentHead = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
const candidateTreeSha = spawnSync('git', ['merge-tree', '--write-tree', 'origin/main', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
assert.match(candidateTreeSha, /^[0-9a-f]{40}$/);
const assignedBase = spawnSync('git', ['merge-base', 'origin/main', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
assert.match(assignedBase, /^[0-9a-f]{40}$/);
const corpus = createCorpus(INDEPENDENT_ORACLE_CASE_FIXTURES);
const results = [];
for (const corpusCase of corpus.cases) {
  results.push(await runIndependentComparison({
    corpusCase,
    subject: ({ caseValue }) => ({
      subjectIdentity: 'production-machine-effects-evaluator',
      subjectRole: 'production-machine-effects-subject',
      outcome: { kind: 'normal' },
      state: caseValue.expectedState,
    }),
  }));
}

const a2Before = createA2DenominatorSnapshot();
const a2After = createA2DenominatorSnapshot();
const architecturalEvidence = corpus.cases.map((caseValue) => {
  const input = evidenceInputForOracleCase(caseValue);
  input.expectedObservables = independentlyAuthoredExpectedObservables(caseValue.profileId);
  if (!['arm64:a64', 'riscv64:rv64imc'].includes(input.profileId)) input.completeness = 'partial';
  return createArchitecturalEvidence(input);
});
const report = createOracleReport({
  productSha: currentHead,
  baseSha: assignedBase,
  candidateTreeSha,
  verifierIdentity: 'hex-independent-machine-effects-verifier',
  verifierVersion: '1.0.0',
  corpus,
  results,
  toolchain: {
    identity: 'llvm-mc-18.1.3-independent-reference',
    version: '18.1.3',
    command: 'llvm-mc',
    target: 'arm64,x86_64,riscv64',
    status: 'available',
    diagnostics: ['bounded offline reference evaluation'],
  },
  generatedArtifactIdentity: 'not-applicable:component-lane',
  a2Before,
  a2After,
  externalEvidence: INDEPENDENT_ORACLE_CASE_FIXTURES.map((item) => ({
    profileId: item.profileId,
    authorityId: item.expectedStateSource.authorityId,
    reference: item.expectedStateSource.reference,
    toolchainIdentity: item.provenance.toolchainIdentity,
    status: 'available',
  })),
  architecturalEvidence,
});

assert.equal(report.policy.productionEvaluatorIsOracle, false);
assert.equal(report.policy.productionSemanticsOwnedHere, false);
assert.equal(report.policy.denominatorAuthoritySeparate, true);
assert.equal(report.a2Preservation.preserved, true);
assert.equal(report.counts['exact/equivalent'], 4);
assert.equal(report.passCount, 4);
assert.equal(report.blockingCount, 0);
assert.equal(report.profileSummaries.length, 4);
assert.equal(report.profileSummaries.every((profile) => profile.caseCount === 1 && profile.passCount === 1 && profile.gapCount === 0), true);
assert.equal(report.externalEvidence.length, 4);
assert.deepEqual(report.evidenceBreadth.unjustifiedExactCases, results.map((result) => result.caseId));
assert.throws(() => assertReleaseReady(report, {
  expectedProductSha: currentHead,
  expectedBaseSha: assignedBase,
  expectedCandidateTreeSha: candidateTreeSha,
  requireCandidateTree: true,
}), /report-incomplete-architectural-evidence/);
assert.throws(() => validateOracleReport({
  ...report,
  counts: { ...report.counts, unexpected: 0 },
}), /report-status-counts-invalid/);
assert.throws(() => validateOracleReport({
  ...report,
  policy: { ...report.policy, networkAllowed: true },
}), /report-authority-policy-invalid/);

const mismatchedEvidenceInput = evidenceInputForOracleCase(corpus.cases[0]);
mismatchedEvidenceInput.expectedObservables = {
  ...independentlyAuthoredExpectedObservables(corpus.cases[0].profileId),
  'register:x0': '0x0000000000000000',
};
const mismatchedEvidence = createArchitecturalEvidence(mismatchedEvidenceInput);
assert.equal(assessArchitecturalEvidence({
  evidence: mismatchedEvidence,
  subject: {
    profileId: corpus.cases[0].profileId,
    effect: mismatchedEvidence.effect,
    observables: independentlyAuthoredExpectedObservables(corpus.cases[0].profileId),
  },
}).status, 'mismatch');
assert.throws(() => createOracleReport({
  productSha: currentHead,
  baseSha: assignedBase,
  corpus,
  results: [results[0], results[0]],
  architecturalEvidence,
  a2Before,
  a2After,
}), /report-result-case-duplicate/);

const evidenceMissingReport = createOracleReport({
  productSha: currentHead,
  baseSha: assignedBase,
  corpus,
  results,
  toolchain: 'unit-test-toolchain',
  a2Before,
  a2After,
});
assert.deepEqual(evidenceMissingReport.evidenceBreadth.unjustifiedExactCases, results.map((result) => result.caseId));
assert.throws(() => assertReleaseReady(evidenceMissingReport), /report-incomplete-architectural-evidence/);

const forgedBreadth = JSON.parse(JSON.stringify(report));
forgedBreadth.evidenceBreadth.unjustifiedExactCases = [];
forgedBreadth.evidenceBreadth.exactClaims[0].caseId = results[1].caseId;
const { reportId: ignoredReportId, ...forgedBreadthPayload } = forgedBreadth;
forgedBreadth.reportId = sha256Digest(forgedBreadthPayload);
assert.throws(() => validateOracleReport(forgedBreadth), /exact-claim-duplicate|unjustified-mismatch/);

// Exact-head verification is intentionally sensitive to git worktree state.
// The MachineEffects runner executes independent proof files concurrently, so
// testing against the shared repository cwd would let an unrelated sibling's
// transient generated/untracked file preempt the semantic assertion below.
// Keep requireClean=true and isolate only the unit-test worktree.
const exactHeadWorktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-me-release-worktree-'));
const exactHeadWorktree = path.join(exactHeadWorktreeRoot, 'worktree');
try {
  const addWorktree = spawnSync('git', ['worktree', 'add', '--detach', exactHeadWorktree, currentHead], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  assert.equal(addWorktree.status, 0, addWorktree.stderr || 'failed to create isolated exact-head worktree');
  const exactHeadInspection = inspectExactHead({ cwd: exactHeadWorktree, baseSha: assignedBase });
  assert.equal(exactHeadInspection.clean, true, `isolated exact-head worktree must be clean: ${exactHeadInspection.status}`);
  const exactHeadFailure = exactHeadInspection.allowlist.valid
    ? /report-incomplete-architectural-evidence/
    : /release-changed-file-outside-allowlist/;
  assert.throws(() => verifyExactHead({
    cwd: exactHeadWorktree,
    report,
    expectedHead: currentHead,
    expectedBase: assignedBase,
    expectedCandidateTree: candidateTreeSha,
    requireClean: true,
    requireCandidateTree: true,
  }), exactHeadFailure);
} finally {
  spawnSync('git', ['worktree', 'remove', '--force', exactHeadWorktree], { cwd: process.cwd(), encoding: 'utf8' });
  fs.rmSync(exactHeadWorktreeRoot, { recursive: true, force: true });
}

assert.throws(() => verifyCandidateMergeTree({
  report,
  candidateTreeSha,
  expectedBase: assignedBase,
}), /report-incomplete-architectural-evidence/);

const partialCorpus = createCorpus([INDEPENDENT_ORACLE_CASE_FIXTURES[0]]);
const partialReport = createOracleReport({
  productSha: currentHead,
  baseSha: assignedBase,
  corpus: partialCorpus,
  results: [results[0]],
  architecturalEvidence: [architecturalEvidence[0]],
  a2Before,
  a2After,
});
assert.equal(partialReport.profileSummaries.filter((profile) => profile.gapCount > 0).length, 3);
assert.equal(partialReport.profileSummaries.find((profile) => profile.profileId === 'x86_64:long-64').gaps[0].status, 'not-integrated');

console.log('machine-effects independent oracle profile/report identity: PASS (4 profiles; A2 preserved)');
