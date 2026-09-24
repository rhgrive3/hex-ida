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
    'js/binary/elf-budget.js', // permitted
    'js/pinpoint/heuristics.js', // forbidden cross-lane
  ]);
  assert.equal(deterministicRejected.valid, false);
  assert.equal(deterministicRejected.verdict, 'BLOCKING');
  assert.deepEqual(deterministicRejected.violations, ['js/pinpoint/heuristics.js']);

  // Test cxx lane trying to touch x86
  const cxxRejected = validateInventory(manifest, 'cxx', [
    'js/rtti.js', // permitted
    'js/targets/architecture/x86/decoder.js', // forbidden cross-lane
  ]);
  assert.equal(cxxRejected.valid, false);
  assert.deepEqual(cxxRejected.violations, ['js/targets/architecture/x86/decoder.js']);

  // Test path traversal or absolute paths fail closed
  assert.equal(permitsFile(manifest, 'deterministic', '../secret.js'), false);
  assert.equal(permitsFile(manifest, 'deterministic', '/etc/passwd'), false);
  assert.equal(permitsFile(manifest, 'deterministic', 'js/binary/../../secret.js'), false);
});

test('candidate merge-tree computation and synthesis works cleanly on git commits', () => {
  const res = computeMergeTree('2bf303289', '58712d348', ROOT);
  assert.equal(res.success, true);
  assert.match(res.treeSha, /^[0-9a-f]{40}$/i);

  const candidateCommit = materializeCandidateCommit({
    baseSha: '2bf303289',
    headSha: '58712d348',
    treeSha: res.treeSha,
    message: 'test candidate commit',
    cwd: ROOT,
  });
  assert.match(candidateCommit, /^[0-9a-f]{40}$/i);
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
    repoDir: ROOT,
  });

  assert.equal(res.valid, false);
  assert.equal(res.verdict, 'BLOCKING');
  assert.ok(res.errors.some((e) => e.code === 'CANDIDATE_TREE_MISMATCH'));
});

test('candidate merge-tree verifier fails closed on ownership violation in candidate diff', () => {
  const manifest = loadManifest();
  const res = verifyCandidateMergeTree({
    lane: 'deterministic',
    baseSha: '2bf303289d11efe331e26697055be804d24b1d90',
    expectedBaseSha: '2bf303289d11efe331e26697055be804d24b1d90',
    headSha: '58712d348df3894bb3f137513aa8d7ded4ade925',
    expectedHeadSha: '58712d348df3894bb3f137513aa8d7ded4ade925',
    manifest,
    requireShadowEvidence: false,
    repoDir: ROOT,
  });

  assert.equal(res.valid, false);
  assert.equal(res.verdict, 'BLOCKING');
  assert.ok(res.errors.some((e) => e.code === 'OWNERSHIP_VIOLATION' || e.code === 'CANDIDATE_UNION_OWNERSHIP_VIOLATION'));
});

test('shadow evidence fails closed on forged, malformed, empty or mismatched data', () => {
  fs.mkdirSync(TEMP_DIR, { recursive: true });

  const dummyCommit = '58712d348df3894bb3f137513aa8d7ded4ade925';
  const dummyTree = 'aabbccddeeff00112233445566778899aabbccdd';

  try {
    // 1. Missing evidence file
    const missingRes = validateShadowEvidence({
      evidencePath: path.join(TEMP_DIR, 'non-existent.json'),
      expectedCandidateCommit: dummyCommit,
      expectedCandidateTree: dummyTree,
    });
    assert.equal(missingRes.valid, false);
    assert.equal(missingRes.reason, 'MISSING_SHADOW_EVIDENCE');

    // 2. Malformed JSON
    const malformedFile = path.join(TEMP_DIR, 'malformed.json');
    fs.writeFileSync(malformedFile, '{ not valid json');
    const malformedRes = validateShadowEvidence({
      evidencePath: malformedFile,
      expectedCandidateCommit: dummyCommit,
      expectedCandidateTree: dummyTree,
    });
    assert.equal(malformedRes.valid, false);
    assert.equal(malformedRes.reason, 'MALFORMED_SHADOW_EVIDENCE');

    // 3. Forged shadow evidence missing verifier identity/hash
    const forgedFile = path.join(TEMP_DIR, 'forged-no-verifier.json');
    fs.writeFileSync(forgedFile, JSON.stringify({
      candidateCommitSha: dummyCommit,
      candidateTreeSha: dummyTree,
      verdict: 'PASS',
      totalCount: 10,
    }));
    const forgedRes = validateShadowEvidence({
      evidencePath: forgedFile,
      expectedCandidateCommit: dummyCommit,
      expectedCandidateTree: dummyTree,
    });
    assert.equal(forgedRes.valid, false);
    assert.equal(forgedRes.reason, 'UNVERIFIED_VERIFIER_IDENTITY');

    // 4. Candidate commit mismatch
    const mismatchedCommitFile = path.join(TEMP_DIR, 'mismatched-commit.json');
    fs.writeFileSync(mismatchedCommitFile, JSON.stringify({
      verifier: 'hex-shadow-verifier/v1',
      verifierVersion: 'sha256-abc123',
      candidateCommitSha: '1111111111111111111111111111111111111111',
      candidateTreeSha: dummyTree,
      totalCount: 1,
      verdict: 'PASS',
    }));
    const commitRes = validateShadowEvidence({
      evidencePath: mismatchedCommitFile,
      expectedCandidateCommit: dummyCommit,
      expectedCandidateTree: dummyTree,
    });
    assert.equal(commitRes.valid, false);
    assert.equal(commitRes.reason, 'CANDIDATE_COMMIT_MISMATCH');

    // 5. Candidate tree mismatch
    const mismatchedTreeFile = path.join(TEMP_DIR, 'mismatched-tree.json');
    fs.writeFileSync(mismatchedTreeFile, JSON.stringify({
      verifier: 'hex-shadow-verifier/v1',
      verifierVersion: 'sha256-abc123',
      candidateCommitSha: dummyCommit,
      candidateTreeSha: '2222222222222222222222222222222222222222',
      totalCount: 1,
      verdict: 'PASS',
    }));
    const treeRes = validateShadowEvidence({
      evidencePath: mismatchedTreeFile,
      expectedCandidateCommit: dummyCommit,
      expectedCandidateTree: dummyTree,
    });
    assert.equal(treeRes.valid, false);
    assert.equal(treeRes.reason, 'CANDIDATE_MERGE_TREE_MISMATCH');

    // 6. Empty results
    const emptyFile = path.join(TEMP_DIR, 'empty-results.json');
    fs.writeFileSync(emptyFile, JSON.stringify({
      verifier: 'hex-shadow-verifier/v1',
      verifierVersion: 'sha256-abc123',
      candidateCommitSha: dummyCommit,
      candidateTreeSha: dummyTree,
      results: [],
      verdict: 'PASS',
    }));
    const emptyRes = validateShadowEvidence({
      evidencePath: emptyFile,
      expectedCandidateCommit: dummyCommit,
      expectedCandidateTree: dummyTree,
    });
    assert.equal(emptyRes.valid, false);
    assert.equal(emptyRes.reason, 'EMPTY_VERIFICATION_RESULTS');

    // 7. Non-passing verdict / test failures
    const nonPassingFile = path.join(TEMP_DIR, 'non-passing.json');
    fs.writeFileSync(nonPassingFile, JSON.stringify({
      verifier: 'hex-shadow-verifier/v1',
      verifierVersion: 'sha256-abc123',
      candidateCommitSha: dummyCommit,
      candidateTreeSha: dummyTree,
      totalCount: 5,
      failedCount: 1,
      verdict: 'FAIL',
    }));
    const verdictRes = validateShadowEvidence({
      evidencePath: nonPassingFile,
      expectedCandidateCommit: dummyCommit,
      expectedCandidateTree: dummyTree,
    });
    assert.equal(verdictRes.valid, false);
    assert.equal(verdictRes.reason, 'SHADOW_VERIFICATION_FAILED');

    // 8. Legitimate evidence passes
    const validFile = path.join(TEMP_DIR, 'valid.json');
    fs.writeFileSync(validFile, JSON.stringify({
      verifier: 'hex-shadow-verifier/v1',
      verifierVersion: 'sha256-abc123',
      candidateCommitSha: dummyCommit,
      candidateTreeSha: dummyTree,
      totalCount: 15,
      failedCount: 0,
      verdict: 'PASS',
      results: [
        { test: 'suite-1', verdict: 'passed' }
      ]
    }));
    const validRes = validateShadowEvidence({
      evidencePath: validFile,
      expectedCandidateCommit: dummyCommit,
      expectedCandidateTree: dummyTree,
    });
    assert.equal(validRes.valid, true);
    assert.equal(validRes.reason, null);

  } finally {
    fs.rmSync(TEMP_DIR, { recursive: true, force: true });
  }
});

test('real diverged local Git remote and moving ref negative test', () => {
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

    // 3. Create component branch 'jev-work' from initial base
    runGit(['checkout', '-b', 'jev-work'], repoDir);
    fs.writeFileSync(path.join(repoDir, 'js-pinpoint.js'), 'export const pinpoint = 1;\n');
    runGit(['add', 'js-pinpoint.js'], repoDir);
    runGit(['-c', 'user.name=test', '-c', 'user.email=test@test.local', 'commit', '-m', 'jev change'], repoDir);
    const jevHeadSha = runGit(['rev-parse', 'HEAD'], repoDir);

    // 4. Advance main with another commit (simulating diverged/moving main)
    runGit(['checkout', 'main'], repoDir);
    fs.writeFileSync(path.join(repoDir, 'main-advance.txt'), 'main advance\n');
    runGit(['add', 'main-advance.txt'], repoDir);
    runGit(['-c', 'user.name=test', '-c', 'user.email=test@test.local', 'commit', '-m', 'main moved ahead'], repoDir);
    runGit(['push', 'origin', 'main'], repoDir);
    const advancedMainSha = runGit(['rev-parse', 'HEAD'], repoDir);

    // 5. Verify moving ref detection against real git remote:
    // If verifier expected initialBaseSha, it MUST detect REMOTE_REF_MOVED
    const refCheck = verifyRemoteRef({
      ref: 'main',
      expectedSha: initialBaseSha,
      remote: 'origin',
      cwd: repoDir,
    });
    assert.equal(refCheck.valid, false);
    assert.equal(refCheck.reason, 'REMOTE_REF_MOVED');

    // 6. Test diverged branch diff semantics:
    // In our candidate merge tree verifier, diff between mergeBase and head must only contain jev files,
    // not reverse diff of main-advance.txt!
    const candidatePrep = prepareCandidate({
      lane: 'jev',
      baseSha: advancedMainSha,
      headSha: jevHeadSha,
      repoDir,
    });
    assert.ok(candidatePrep.candidateCommitSha);
    assert.ok(candidatePrep.candidateTreeSha);

    const manifest = loadManifest();
    const verifierRes = verifyCandidateMergeTree({
      lane: 'jev',
      baseSha: advancedMainSha,
      expectedBaseSha: advancedMainSha,
      headSha: jevHeadSha,
      expectedHeadSha: jevHeadSha,
      expectedCandidateTree: candidatePrep.candidateTreeSha,
      repoDir,
      requireShadowEvidence: false,
      manifest,
    });

    // The component changed js-pinpoint.js which is outside jev allowlist!
    // So it correctly catches OWNERSHIP_VIOLATION without being confused by main-advance.txt
    assert.equal(verifierRes.valid, false);
    assert.ok(verifierRes.errors.some((e) => e.code === 'OWNERSHIP_VIOLATION'));
    assert.deepEqual(verifierRes.componentFiles, ['js-pinpoint.js']);

  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});
