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
  getGitPath,
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

test('diagnostic mode with no-shadow does NOT return release PASS', () => {
  const manifest = loadManifest();
  const res = verifyCandidateMergeTree({
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

  assert.equal(res.valid, false, 'Diagnostic run without shadow evidence must not be valid for release');
  assert.equal(res.verdict, 'DIAGNOSTIC_PASS_NOT_RELEASE_ELIGIBLE');
  assert.equal(res.diagnosticOnly, true);
});

test('shadow evidence rejects exact counterexamples from rebuttal', () => {
  fs.mkdirSync(TEMP_DIR, { recursive: true });

  const dummyCommit = '58712d348df3894bb3f137513aa8d7ded4ade925';
  const dummyTree = 'aabbccddeeff00112233445566778899aabbccdd';

  try {
    // Exact counterexample from rebuttal:
    // {verifier:"fake",verifierVersion:"fake",candidateCommitSha:40*a,candidateTreeSha:40*b,verdict:"PASS"}, no results
    const counterexampleFile = path.join(TEMP_DIR, 'rebuttal-counterexample.json');
    fs.writeFileSync(counterexampleFile, JSON.stringify({
      verifier: 'fake',
      verifierVersion: 'fake',
      candidateCommitSha: dummyCommit,
      candidateTreeSha: dummyTree,
      verdict: 'PASS',
    }));

    const counterRes = validateShadowEvidence({
      evidencePath: counterexampleFile,
      expectedCandidateCommit: dummyCommit,
      expectedCandidateTree: dummyTree,
    });
    // MUST FAIL closed because oracle/corpus/toolchain and results are missing
    assert.equal(counterRes.valid, false);
    assert.equal(counterRes.reason, 'MISSING_PROVENANCE_METADATA');

    // Add fake provenance, but empty/absent results
    const withProvFile = path.join(TEMP_DIR, 'with-prov-no-results.json');
    fs.writeFileSync(withProvFile, JSON.stringify({
      verifier: 'fake',
      verifierVersion: 'fake',
      oracle: 'real-oracle',
      corpus: 'real-corpus',
      toolchain: 'real-toolchain',
      candidateCommitSha: dummyCommit,
      candidateTreeSha: dummyTree,
      verdict: 'PASS',
    }));
    const withProvRes = validateShadowEvidence({
      evidencePath: withProvFile,
      expectedCandidateCommit: dummyCommit,
      expectedCandidateTree: dummyTree,
    });
    assert.equal(withProvRes.valid, false);
    assert.equal(withProvRes.reason, 'EMPTY_VERIFICATION_RESULTS');

    // Mismatched trusted verifier identity
    const trustedFile = path.join(TEMP_DIR, 'trusted-test.json');
    fs.writeFileSync(trustedFile, JSON.stringify({
      verifier: 'untrusted-agent',
      verifierVersion: 'sha256-untrusted',
      oracle: 'real-oracle',
      corpus: 'real-corpus',
      toolchain: 'real-toolchain',
      candidateCommitSha: dummyCommit,
      candidateTreeSha: dummyTree,
      results: [{ test: 'unit-1', verdict: 'passed' }],
      verdict: 'PASS',
    }));
    const trustedRes = validateShadowEvidence({
      evidencePath: trustedFile,
      expectedCandidateCommit: dummyCommit,
      expectedCandidateTree: dummyTree,
      trustedVerifierIdentity: 'hex-shadow-verifier/v2',
    });
    assert.equal(trustedRes.valid, false);
    assert.equal(trustedRes.reason, 'VERIFIER_IDENTITY_MISMATCH');

    // Legitimate evidence with verified trusted identity and results passes
    const validFile = path.join(TEMP_DIR, 'legitimate.json');
    fs.writeFileSync(validFile, JSON.stringify({
      verifier: 'hex-shadow-verifier/v2',
      verifierVersion: 'sha256-trusted123',
      oracle: 'real-oracle',
      corpus: 'real-corpus',
      toolchain: 'real-toolchain',
      candidateCommitSha: dummyCommit,
      candidateTreeSha: dummyTree,
      results: [{ test: 'unit-1', verdict: 'passed' }],
      verdict: 'PASS',
    }));
    const validRes = validateShadowEvidence({
      evidencePath: validFile,
      expectedCandidateCommit: dummyCommit,
      expectedCandidateTree: dummyTree,
      trustedVerifierIdentity: 'hex-shadow-verifier/v2',
      trustedVerifierHash: 'sha256-trusted123',
    });
    assert.equal(validRes.valid, true);
    assert.equal(validRes.reason, null);

  } finally {
    fs.rmSync(TEMP_DIR, { recursive: true, force: true });
  }
});

test('remote verification fails closed on nonexistent or unreachable remote', () => {
  const badRemote = verifyRemoteRef({
    ref: 'main',
    expectedSha: '1111111111111111111111111111111111111111',
    remote: 'nonexistent-remote-name-xyz',
    cwd: ROOT,
  });

  assert.equal(badRemote.valid, false);
  assert.equal(badRemote.remoteSha, null);
  assert.equal(badRemote.reason, 'REMOTE_UNREACHABLE');
});

test('linked worktree getGitPath resolves to main git dir and supports candidate synthesis', () => {
  // Current worktree is a linked worktree: ROOT is .../governance
  const gitPath = getGitPath('test-scratch-index', ROOT);
  assert.ok(typeof gitPath === 'string');
  assert.ok(!gitPath.endsWith('.git/test-scratch-index') || fs.statSync(path.dirname(gitPath)).isDirectory());
});

test('real diverged local Git remote, moving ref, and candidate commit stability test', () => {
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

    // 8. Re-run candidate prep and verify candidate commit stability
    const prep = prepareCandidate({
      lane: 'jev',
      baseSha: reconciledIntegrationSha,
      headSha: jevHeadSha,
      repoDir,
    });
    assert.ok(prep.candidateCommitSha);
    assert.ok(prep.candidateTreeSha);

    const verifiedCandidateCommit = materializeCandidateCommit({
      baseSha: reconciledIntegrationSha,
      headSha: jevHeadSha,
      treeSha: prep.candidateTreeSha,
      cwd: repoDir,
    });
    assert.equal(prep.candidateCommitSha, verifiedCandidateCommit, 'Candidate commit must be stable between prepare and verify');

  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});
