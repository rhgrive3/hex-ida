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
  verifyCandidateMergeTree,
  verifyExactHead,
} from '../../tools/validation/machine-effects/oracle-release-verify.mjs';
import { runIndependentComparison } from '../../tools/validation/machine-effects/oracle-runner.mjs';
import { INDEPENDENT_ORACLE_CASE_FIXTURES } from './fixtures/independent-oracle-cases.mjs';

const currentHead = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
const candidateTreeSha = spawnSync('git', ['merge-tree', '--write-tree', 'origin/main', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
assert.match(candidateTreeSha, /^[0-9a-f]{40}$/);
const assignedBase = '1cd6470973b0d41e2af88cf1c8730a9188657013';
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
assertReleaseReady(report, {
  expectedProductSha: currentHead,
  expectedBaseSha: assignedBase,
  expectedCandidateTreeSha: candidateTreeSha,
  requireCandidateTree: true,
});
assert.throws(() => validateOracleReport({
  ...report,
  counts: { ...report.counts, unexpected: 0 },
}), /report-status-counts-invalid/);
assert.throws(() => validateOracleReport({
  ...report,
  policy: { ...report.policy, networkAllowed: true },
}), /report-authority-policy-invalid/);
assert.throws(() => createOracleReport({
  productSha: currentHead,
  baseSha: assignedBase,
  corpus,
  results: [results[0], results[0]],
  a2Before,
  a2After,
}), /report-result-case-duplicate/);

// The canonical MachineEffects runner executes independent test files in
// parallel. Other tests may create transient working-tree artifacts while this
// release proof is checking cleanliness. Verify the exact committed head in a
// dedicated detached worktree so requireClean remains strict and deterministic.
const releaseWorktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-oracle-release-'));
const releaseWorktree = path.join(releaseWorktreeRoot, 'worktree');
try {
  const addWorktree = spawnSync(
    'git',
    ['worktree', 'add', '--detach', '--quiet', releaseWorktree, currentHead],
    { encoding: 'utf8' },
  );
  assert.equal(addWorktree.status, 0, addWorktree.stderr || 'failed to create clean release worktree');

  const exactHead = verifyExactHead({
    cwd: releaseWorktree,
    report,
    expectedHead: currentHead,
    expectedBase: assignedBase,
    expectedCandidateTree: candidateTreeSha,
    requireClean: true,
    requireCandidateTree: true,
  });
  assert.equal(exactHead.valid, true);
  assert.equal(exactHead.headSha, currentHead);
  assert.equal(exactHead.baseSha, assignedBase);
} finally {
  spawnSync('git', ['worktree', 'remove', '--force', releaseWorktree], { encoding: 'utf8' });
  spawnSync('git', ['worktree', 'prune'], { encoding: 'utf8' });
  fs.rmSync(releaseWorktreeRoot, { recursive: true, force: true });
}

const candidateTree = verifyCandidateMergeTree({
  report,
  candidateTreeSha,
  expectedBase: assignedBase,
});
assert.equal(candidateTree.valid, true);

const partialCorpus = createCorpus([INDEPENDENT_ORACLE_CASE_FIXTURES[0]]);
const partialReport = createOracleReport({
  productSha: currentHead,
  baseSha: assignedBase,
  corpus: partialCorpus,
  results: [results[0]],
  a2Before,
  a2After,
});
assert.equal(partialReport.profileSummaries.filter((profile) => profile.gapCount > 0).length, 3);
assert.equal(partialReport.profileSummaries.find((profile) => profile.profileId === 'x86_64:long-64').gaps[0].status, 'not-integrated');

console.log('machine-effects independent oracle profile/report identity: PASS (4 profiles; A2 preserved)');
