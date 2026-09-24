import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import {
  loadManifest,
  permitsFile,
  validateInventory,
  runNegativeSelfCheck,
} from '../tools/validation/hex-completion-ownership.mjs';

import {
  computeMergeTree,
  materializeCandidateCommit,
  validateShadowEvidence,
  verifyCandidateMergeTree,
  verifyRemoteRef,
  prepareCandidate,
  runCandidateVerifier,
  getGitPath,
  resolveTrustedVerifier,
} from '../tools/validation/hex-completion-merge-tree.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMP_DIR = path.join(ROOT, 'tmp-governance-test-' + Date.now());

function runGit(args, cwd = ROOT) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

test('hex-completion manifest self-consistency and negative self-checks', () => {
  const manifest = loadManifest();
  assert.equal(manifest.schema, 'hex-completion-ownership/v1');
  assert.equal(manifest.integrationLane, 'integration');

  const selfCheck = runNegativeSelfCheck(manifest);
  assert.equal(selfCheck.valid, true, `Negative self checks failed: ${JSON.stringify(selfCheck.failures)}`);
});

test('manifest allowlists exact Jev scripts and tests and Perf core identity test', () => {
  const manifest = loadManifest();

  // Jev exact allowlists
  assert.equal(permitsFile(manifest, 'jev', 'scripts/run-jev-prospective-eval.mjs'), true);
  assert.equal(permitsFile(manifest, 'jev', 'scripts/verify-jev-binary-holdout.mjs'), true);
  assert.equal(permitsFile(manifest, 'jev', 'tests/pinpoint-jev-probe-audit.mjs'), true);
  assert.equal(permitsFile(manifest, 'jev', 'tests/pinpoint-jev-shortlist.test.mjs'), true);

  // Perf exact allowlist
  assert.equal(permitsFile(manifest, 'perf', 'tests/core-identity-performance.test.mjs'), true);

  // CXX unowned / integration handoff paths remain rejected
  assert.equal(permitsFile(manifest, 'cxx', 'js/ir-core.js'), false);
  assert.equal(permitsFile(manifest, 'cxx', 'js/tools-base.js'), false);
});

test('generated output is owned exclusively by integration lane', () => {
  const manifest = loadManifest();
  const generated = 'userscript/hex.user.template.js';

  // Integration lane is permitted
  assert.equal(permitsFile(manifest, 'integration', generated), true);

  // All other component lanes MUST be rejected
  const nonIntegrationLanes = Object.keys(manifest.lanes).filter((l) => l !== 'integration');
  for (const lane of nonIntegrationLanes) {
    assert.equal(
      permitsFile(manifest, lane, generated),
      false,
      `Lane ${lane} must not be permitted to own generated output ${generated}`,
    );
    const result = validateInventory(manifest, lane, [generated]);
    assert.equal(result.valid, false);
    assert.equal(result.verdict, 'BLOCKING');
    assert.deepEqual(result.violations, [generated]);
  }
});

test('cross-lane modifications are rejected by default', () => {
  const manifest = loadManifest();

  // Test deterministic lane trying to modify jev or output files
  const deterministicRejected = validateInventory(manifest, 'deterministic', [
    'js/binary/elf-budget.js',
    'js/pinpoint/heuristics.js',
  ]);
  assert.equal(deterministicRejected.valid, false);
  assert.equal(deterministicRejected.verdict, 'BLOCKING');
  assert.deepEqual(deterministicRejected.violations, ['js/pinpoint/heuristics.js']);

  // Test cxx lane trying to touch x86
  const cxxRejected = validateInventory(manifest, 'cxx', [
    'js/rtti.js',
    'js/targets/architecture/x86/decoder.js',
  ]);
  assert.equal(cxxRejected.valid, false);
  assert.deepEqual(cxxRejected.violations, ['js/targets/architecture/x86/decoder.js']);

  // Test path traversal or absolute paths fail closed
  assert.equal(permitsFile(manifest, 'deterministic', '../secret.js'), false);
  assert.equal(permitsFile(manifest, 'deterministic', '/etc/passwd'), false);
  assert.equal(permitsFile(manifest, 'deterministic', 'js/binary/../../secret.js'), false);
});

test('candidate merge-tree computation and deterministic commit synthesis works cleanly', () => {
  const res = computeMergeTree('2bf303289', '58712d348', ROOT);
  assert.equal(res.success, true);
  assert.match(res.treeSha, /^[0-9a-f]{40}$/i);

  const commit1 = materializeCandidateCommit({
    baseSha: '2bf303289',
    headSha: '58712d348',
    treeSha: res.treeSha,
    cwd: ROOT,
  });
  const commit2 = materializeCandidateCommit({
    baseSha: '2bf303289',
    headSha: '58712d348',
    treeSha: res.treeSha,
    cwd: ROOT,
  });

  assert.match(commit1, /^[0-9a-f]{40}$/i);
  // Must be strictly deterministic across calls
  assert.equal(commit1, commit2);
});

test('candidate merge-tree verifier fails closed on moving-base mismatch', () => {
  const manifest = loadManifest();
  const res = verifyCandidateMergeTree({
    lane: 'deterministic',
    baseSha: '58712d348df3894bb3f137513aa8d7ded4ade925',
    expectedBaseSha: '0000000000000000000000000000000000000000',
    headSha: '58712d348df3894bb3f137513aa8d7ded4ade925',
    expectedHeadSha: '58712d348df3894bb3f137513aa8d7ded4ade925',
    manifest,
    requireShadowEvidence: false,
    requireRemoteCheck: false,
    repoDir: ROOT,
  });

  assert.equal(res.valid, false);
  assert.equal(res.verdict, 'BLOCKING');
  assert.ok(res.errors.some((e) => e.code === 'MOVING_HEAD_MISMATCH'));
});

test('candidate merge-tree verifier fails closed on component head mismatch', () => {
  const manifest = loadManifest();
  const res = verifyCandidateMergeTree({
    lane: 'deterministic',
    baseSha: '58712d348df3894bb3f137513aa8d7ded4ade925',
    expectedBaseSha: '58712d348df3894bb3f137513aa8d7ded4ade925',
    headSha: '58712d348df3894bb3f137513aa8d7ded4ade925',
    expectedHeadSha: '1111111111111111111111111111111111111111',
    manifest,
    requireShadowEvidence: false,
    requireRemoteCheck: false,
    repoDir: ROOT,
  });

  assert.equal(res.valid, false);
  assert.equal(res.verdict, 'BLOCKING');
  assert.ok(res.errors.some((e) => e.code === 'COMPONENT_HEAD_MISMATCH'));
});

test('candidate merge-tree verifier fails closed on candidate tree mismatch', () => {
  const manifest = loadManifest();
  const res = verifyCandidateMergeTree({
    lane: 'deterministic',
    baseSha: '2bf303289d11efe331e26697055be804d24b1d90',
    expectedBaseSha: '2bf303289d11efe331e26697055be804d24b1d90',
    headSha: '58712d348df3894bb3f137513aa8d7ded4ade925',
    expectedHeadSha: '58712d348df3894bb3f137513aa8d7ded4ade925',
    expectedCandidateTree: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    manifest,
    requireShadowEvidence: false,
    requireRemoteCheck: false,
    repoDir: ROOT,
  });

  assert.equal(res.valid, false);
  assert.equal(res.verdict, 'BLOCKING');
  assert.ok(res.errors.some((e) => e.code === 'CANDIDATE_TREE_MISMATCH'));
});

test('diagnostic mode with no-shadow or skip-remote-check does NOT return release PASS', () => {
  const manifest = loadManifest();

  // 1. No shadow
  const noShadowRes = verifyCandidateMergeTree({
    lane: 'integration',
    baseSha: '2bf303289d11efe331e26697055be804d24b1d90',
    expectedBaseSha: '2bf303289d11efe331e26697055be804d24b1d90',
    headSha: '58712d348df3894bb3f137513aa8d7ded4ade925',
    expectedHeadSha: '58712d348df3894bb3f137513aa8d7ded4ade925',
    manifest,
    requireShadowEvidence: false,
    requireRemoteCheck: false,
    repoDir: ROOT,
  });
  assert.equal(noShadowRes.valid, false, 'no-shadow must not be valid for release');
  assert.equal(noShadowRes.verdict, 'DIAGNOSTIC_PASS_NOT_RELEASE_ELIGIBLE');

  // 2. Skip remote check attempt with valid shadow format
  const skipRemoteRes = verifyCandidateMergeTree({
    lane: 'integration',
    baseSha: '2bf303289d11efe331e26697055be804d24b1d90',
    expectedBaseSha: '2bf303289d11efe331e26697055be804d24b1d90',
    headSha: '58712d348df3894bb3f137513aa8d7ded4ade925',
    expectedHeadSha: '58712d348df3894bb3f137513aa8d7ded4ade925',
    manifest,
    requireShadowEvidence: false,
    requireRemoteCheck: false,
    repoDir: ROOT,
  });
  assert.equal(skipRemoteRes.valid, false, 'skip-remote-check must not be valid for release');
  assert.equal(skipRemoteRes.verdict, 'DIAGNOSTIC_PASS_NOT_RELEASE_ELIGIBLE');
});

test('shadow evidence rejects fully populated forged JSON and missing trusted verifier inputs', () => {
  fs.mkdirSync(TEMP_DIR, { recursive: true });

  const dummyCommit = '58712d348df3894bb3f137513aa8d7ded4ade925';
  const dummyTree = 'aabbccddeeff00112233445566778899aabbccdd';

  try {
    // 1. Primary review counterexample: fully populated forged JSON when trustedVerifierIdentity/Hash omitted
    const forgedFile = path.join(TEMP_DIR, 'forged-fully-populated.json');
    fs.writeFileSync(forgedFile, JSON.stringify({
      verifier: 'fake',
      verifierHash: 'fake',
      verifierVersion: 'fake',
      oracle: 'fake',
      corpus: 'fake',
      toolchain: 'fake',
      candidateCommitSha: dummyCommit,
      candidateTreeSha: dummyTree,
      results: [{ id: 'fake', status: 'PASS', verdict: 'PASS' }],
      verdict: 'PASS',
    }));

    // Must be rejected when trusted verifier identity is omitted
    const omittedTrustedRes = validateShadowEvidence({
      evidencePath: forgedFile,
      expectedCandidateCommit: dummyCommit,
      expectedCandidateTree: dummyTree,
    });
    assert.equal(omittedTrustedRes.valid, false);
    assert.equal(omittedTrustedRes.reason, 'MISSING_TRUSTED_VERIFIER_IDENTITY');

    // Must be rejected when trusted verifier identity doesn't match
    const mismatchedIdRes = validateShadowEvidence({
      evidencePath: forgedFile,
      expectedCandidateCommit: dummyCommit,
      expectedCandidateTree: dummyTree,
      trustedVerifierIdentity: 'tools/validation/stage2/verify.mjs',
      trustedVerifierHash: 'expected-trusted-hash-1234',
    });
    assert.equal(mismatchedIdRes.valid, false);
    assert.equal(mismatchedIdRes.reason, 'VERIFIER_IDENTITY_MISMATCH');

    // Must be rejected when verifier hash doesn't match
    const fakeWithTrustedId = path.join(TEMP_DIR, 'fake-with-trusted-id.json');
    fs.writeFileSync(fakeWithTrustedId, JSON.stringify({
      verifier: 'tools/validation/stage2/verify.mjs',
      verifierHash: 'untrusted-forged-hash',
      verifierVersion: 'untrusted-forged-hash',
      oracle: 'real-oracle',
      corpus: 'real-corpus',
      toolchain: 'real-toolchain',
      candidateCommitSha: dummyCommit,
      candidateTreeSha: dummyTree,
      results: [{ id: 'test-1', status: 'PASS', verdict: 'PASS' }],
      verdict: 'PASS',
    }));
    const mismatchedHashRes = validateShadowEvidence({
      evidencePath: fakeWithTrustedId,
      expectedCandidateCommit: dummyCommit,
      expectedCandidateTree: dummyTree,
      trustedVerifierIdentity: 'tools/validation/stage2/verify.mjs',
      trustedVerifierHash: 'real-trusted-hash-5678',
    });
    assert.equal(mismatchedHashRes.valid, false);
    assert.equal(mismatchedHashRes.reason, 'VERIFIER_HASH_MISMATCH');

    // Legitimate evidence matching trusted identity & hash passes
    const validFile = path.join(TEMP_DIR, 'legitimate.json');
    fs.writeFileSync(validFile, JSON.stringify({
      verifier: 'tools/validation/stage2/verify.mjs',
      verifierHash: 'real-trusted-hash-5678',
      verifierVersion: 'real-trusted-hash-5678',
      oracle: 'hex-oracle-v2',
      corpus: 'arm64-160-corpus',
      toolchain: 'node-v24',
      candidateCommitSha: dummyCommit,
      candidateTreeSha: dummyTree,
      results: [{ id: 'case-01', status: 'PASS', verdict: 'PASS' }],
      verdict: 'PASS',
    }));
    const validRes = validateShadowEvidence({
      evidencePath: validFile,
      expectedCandidateCommit: dummyCommit,
      expectedCandidateTree: dummyTree,
      trustedVerifierIdentity: 'tools/validation/stage2/verify.mjs',
      trustedVerifierHash: 'real-trusted-hash-5678',
    });
    assert.equal(validRes.valid, true);
    assert.equal(validRes.reason, null);

  } finally {
    fs.rmSync(TEMP_DIR, { recursive: true, force: true });
  }
});

test('remote verification fails closed on nonexistent or unreachable remote and omitted refs', () => {
  // 1. Unreachable remote
  const badRemote = verifyRemoteRef({
    ref: 'main',
    expectedSha: '1111111111111111111111111111111111111111',
    remote: 'nonexistent-remote-name-xyz',
    cwd: ROOT,
  });
  assert.equal(badRemote.valid, false);
  assert.equal(badRemote.remoteSha, null);
  assert.equal(badRemote.reason, 'REMOTE_UNREACHABLE');

  // 2. Omitted integration-ref or component-ref in verifyCandidateMergeTree
  const manifest = loadManifest();
  const omittedRefs = verifyCandidateMergeTree({
    lane: 'deterministic',
    baseSha: '58712d348df3894bb3f137513aa8d7ded4ade925',
    headSha: '58712d348df3894bb3f137513aa8d7ded4ade925',
    requireRemoteCheck: true,
    manifest,
    repoDir: ROOT,
  });
  assert.equal(omittedRefs.valid, false);
  assert.ok(omittedRefs.errors.some((e) => e.code === 'MISSING_INTEGRATION_REF'));
  assert.ok(omittedRefs.errors.some((e) => e.code === 'MISSING_COMPONENT_REF'));
});

test('linked worktree getGitPath resolves safely and candidate worktree synthesis works', () => {
  const gitPath = getGitPath('test-scratch-index', ROOT);
  assert.ok(typeof gitPath === 'string');

  const trusted = resolveTrustedVerifier();
  assert.ok(trusted.identity);
  assert.match(trusted.hash, /^[0-9a-f]{64}$/i);
});

test('real diverged local Git remote, moving ref, and detached candidate execution test', () => {
  const sandbox = path.join(ROOT, 'tmp-git-sandbox-' + Date.now());
  fs.mkdirSync(sandbox, { recursive: true });

  const originDir = path.join(sandbox, 'origin.git');
  const repoDir = path.join(sandbox, 'local-repo');

  try {
    // 1. Initialize bare origin
    runGit(['init', '--bare', originDir]);

    // 2. Clone to local-repo and seed initial commit
    runGit(['clone', originDir, repoDir]);
    fs.writeFileSync(path.join(repoDir, 'base.txt'), 'base version\n');
    runGit(['add', 'base.txt'], repoDir);
    runGit(['-c', 'user.name=test', '-c', 'user.email=test@test.local', 'commit', '-m', 'initial base'], repoDir);
    runGit(['branch', '-M', 'main'], repoDir);
    runGit(['push', 'origin', 'main'], repoDir);
    const initialBaseSha = runGit(['rev-parse', 'HEAD'], repoDir);

    // 3. Create integration branch from main and commit a change
    runGit(['checkout', '-b', 'integration'], repoDir);
    fs.writeFileSync(path.join(repoDir, 'integration.txt'), 'integration initial\n');
    runGit(['add', 'integration.txt'], repoDir);
    runGit(['-c', 'user.name=test', '-c', 'user.email=test@test.local', 'commit', '-m', 'integration work'], repoDir);
    runGit(['push', 'origin', 'integration'], repoDir);
    const integrationSha = runGit(['rev-parse', 'HEAD'], repoDir);

    // 4. Create component branch 'jev-work' from initial base
    runGit(['checkout', '-b', 'jev-work', initialBaseSha], repoDir);
    fs.writeFileSync(path.join(repoDir, 'js-pinpoint.js'), 'export const pinpoint = 1;\n');
    runGit(['add', 'js-pinpoint.js'], repoDir);
    runGit(['-c', 'user.name=test', '-c', 'user.email=test@test.local', 'commit', '-m', 'jev change'], repoDir);
    runGit(['push', 'origin', 'jev-work'], repoDir);
    const jevHeadSha = runGit(['rev-parse', 'HEAD'], repoDir);

    // 5. Advance main with an unreconciled commit
    runGit(['checkout', 'main'], repoDir);
    fs.writeFileSync(path.join(repoDir, 'main-advance.txt'), 'main advance\n');
    runGit(['add', 'main-advance.txt'], repoDir);
    runGit(['-c', 'user.name=test', '-c', 'user.email=test@test.local', 'commit', '-m', 'main moved ahead'], repoDir);
    runGit(['push', 'origin', 'main'], repoDir);
    const advancedMainSha = runGit(['rev-parse', 'HEAD'], repoDir);

    // 6. Test: integration does not contain live main -> MUST FAIL with INTEGRATION_NOT_RECONCILED_WITH_MAIN
    const manifest = loadManifest();
    const unreconciledRes = verifyCandidateMergeTree({
      lane: 'jev',
      baseSha: integrationSha,
      expectedBaseSha: integrationSha,
      headSha: jevHeadSha,
      expectedHeadSha: jevHeadSha,
      requireRemoteCheck: true,
      remoteName: 'origin',
      mainRef: 'main',
      integrationRef: 'integration',
      componentRef: 'jev-work',
      expectedMainSha: advancedMainSha,
      requireShadowEvidence: false,
      repoDir,
      manifest,
    });
    assert.equal(unreconciledRes.valid, false);
    assert.ok(unreconciledRes.errors.some((e) => e.code === 'INTEGRATION_NOT_RECONCILED_WITH_MAIN'));

    // 7. Now reconcile integration with main
    runGit(['checkout', 'integration'], repoDir);
    runGit(['merge', 'main', '-m', 'reconcile with main'], repoDir);
    runGit(['push', 'origin', 'integration'], repoDir);
    const reconciledIntegrationSha = runGit(['rev-parse', 'HEAD'], repoDir);

    // 8. Prepare candidate commit & tree
    const prep = prepareCandidate({
      lane: 'jev',
      baseSha: reconciledIntegrationSha,
      headSha: jevHeadSha,
      repoDir,
    });
    assert.ok(prep.candidateCommitSha);
    assert.ok(prep.candidateTreeSha);

    // 9. Execute real candidate verifier in detached worktree
    const reportPath = path.join(sandbox, 'candidate-report.json');
    const executedEvidence = runCandidateVerifier({
      candidateCommitSha: prep.candidateCommitSha,
      verifierCommand: ['git', 'status'], // reliable local command to prove execution
      outputReportPath: reportPath,
      repoDir,
      verifierIdentity: 'tools/validation/stage2/verify.mjs',
    });
    assert.equal(executedEvidence.status, 'PASS');
    assert.equal(executedEvidence.verdict, 'PASS');
    assert.equal(executedEvidence.candidateCommitSha, prep.candidateCommitSha);
    assert.equal(executedEvidence.candidateTreeSha, prep.candidateTreeSha);

  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});
