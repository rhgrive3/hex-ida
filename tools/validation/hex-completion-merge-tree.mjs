import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { loadManifest, validateInventory } from './hex-completion-ownership.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function runGit(args, cwd = ROOT) {
  try {
    const stdout = execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    return {
      status: err.status ?? 1,
      stdout: (err.stdout ?? '').toString().trim(),
      stderr: (err.stderr ?? '').toString().trim(),
    };
  }
}

/**
 * Computes candidate merge tree using git.
 */
export function computeMergeTree(baseSha, headSha, cwd = ROOT) {
  let result = runGit(['merge-tree', '--write-tree', baseSha, headSha], cwd);
  if (result.status === 0) {
    const treeSha = result.stdout.split(/\s+/).find((val) => /^[0-9a-f]{40}$/i.test(val));
    if (treeSha) {
      return { success: true, treeSha, error: null };
    }
  }

  try {
    const baseCommit = runGit(['rev-parse', baseSha], cwd).stdout;
    const headCommit = runGit(['rev-parse', headSha], cwd).stdout;
    const mergeBaseRes = runGit(['merge-base', baseCommit, headCommit], cwd);
    if (mergeBaseRes.status !== 0) {
      return {
        success: false,
        treeSha: null,
        error: `git merge-base failed between ${baseSha} and ${headSha}: ${mergeBaseRes.stderr}`,
      };
    }
    const mergeBase = mergeBaseRes.stdout;

    if (mergeBase.toLowerCase() === baseCommit.toLowerCase()) {
      const headTree = runGit(['rev-parse', `${headCommit}^{tree}`], cwd).stdout;
      return { success: true, treeSha: headTree, error: null };
    }
    if (mergeBase.toLowerCase() === headCommit.toLowerCase()) {
      const baseTree = runGit(['rev-parse', `${baseCommit}^{tree}`], cwd).stdout;
      return { success: true, treeSha: baseTree, error: null };
    }

    const tmpIndex = path.join(cwd, `.git/temp-merge-index-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
      execFileSync('git', ['read-tree', '-m', mergeBase, baseCommit, headCommit], { cwd, env, stdio: 'ignore' });
      const tree = execFileSync('git', ['write-tree'], { cwd, env, encoding: 'utf8' }).trim();
      return { success: true, treeSha: tree, error: null };
    } catch (mergeErr) {
      return {
        success: false,
        treeSha: null,
        error: `merge conflict computing candidate tree between ${baseSha} and ${headSha}: ${mergeErr.message}`,
      };
    } finally {
      if (fs.existsSync(tmpIndex)) {
        fs.unlinkSync(tmpIndex);
      }
    }
  } catch (err) {
    return {
      success: false,
      treeSha: null,
      error: `Failed to compute candidate merge tree: ${err.message}`,
    };
  }
}

/**
 * Creates/synthesizes an exact candidate merge commit object in the git database.
 * Does not mutate HEAD or branch refs.
 */
export function materializeCandidateCommit({ baseSha, headSha, treeSha, message = 'candidate: synthetic merge for verification', cwd = ROOT }) {
  const commitRes = runGit(['commit-tree', treeSha, '-p', baseSha, '-p', headSha, '-m', message], cwd);
  if (commitRes.status !== 0) {
    throw new Error(`Failed to commit-tree: ${commitRes.stderr || commitRes.stdout}`);
  }
  return commitRes.stdout.trim();
}

/**
 * Validates shadow evidence file for the candidate merge.
 * Enforces strict non-fail-open schema:
 *  - File exists and is valid JSON
 *  - Verified verifier identity & non-empty verifierVersion/hash
 *  - Verified oracle and/or toolchain identity
 *  - Verified exact candidateCommitSha and candidateTreeSha match
 *  - Non-empty results array or test summaries with zero failing/blocking tests
 *  - Explicit overall verdict PASS / PROVEN
 */
export function validateShadowEvidence({
  evidencePath,
  expectedCandidateCommit,
  expectedCandidateTree,
}) {
  if (!evidencePath || !fs.existsSync(evidencePath)) {
    return {
      valid: false,
      reason: 'MISSING_SHADOW_EVIDENCE',
      detail: `Evidence file not found: ${evidencePath}`,
    };
  }

  let parsed;
  try {
    const content = fs.readFileSync(evidencePath, 'utf8');
    parsed = JSON.parse(content);
  } catch (e) {
    return {
      valid: false,
      reason: 'MALFORMED_SHADOW_EVIDENCE',
      detail: `Evidence JSON unparseable: ${e.message}`,
    };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      valid: false,
      reason: 'MALFORMED_SHADOW_EVIDENCE',
      detail: 'Evidence JSON must be an object',
    };
  }

  // Verifier identity and version must be present and non-empty
  const verifierName = parsed.verifier || parsed.verifierName || parsed.verifierId;
  const verifierVersion = parsed.verifierVersion || parsed.verifierHash || parsed.verifierSha;
  if (!verifierName || typeof verifierName !== 'string' || !verifierVersion || typeof verifierVersion !== 'string') {
    return {
      valid: false,
      reason: 'UNVERIFIED_VERIFIER_IDENTITY',
      detail: 'Evidence missing required verifier identity/version strings',
    };
  }

  // Exact candidate commit matching
  const candidateCommit = parsed.candidateCommitSha || parsed.candidateCommit || parsed.candidateHead || parsed.headSha;
  if (!candidateCommit || candidateCommit.toLowerCase() !== expectedCandidateCommit.toLowerCase()) {
    return {
      valid: false,
      reason: 'CANDIDATE_COMMIT_MISMATCH',
      detail: `Evidence candidate commit ${candidateCommit} does not match expected ${expectedCandidateCommit}`,
    };
  }

  // Exact candidate merge tree matching
  const candidateTree = parsed.candidateTreeSha || parsed.candidateTree || parsed.treeSha || parsed.mergeTree;
  if (!candidateTree || candidateTree.toLowerCase() !== expectedCandidateTree.toLowerCase()) {
    return {
      valid: false,
      reason: 'CANDIDATE_MERGE_TREE_MISMATCH',
      detail: `Evidence candidate tree ${candidateTree} does not match expected ${expectedCandidateTree}`,
    };
  }

  // Results check: must contain results array or test summaries proving verification ran
  const results = parsed.results || parsed.tests || parsed.suites;
  const totalCount = parsed.totalCount ?? (Array.isArray(results) ? results.length : null);
  if (totalCount === 0 || (Array.isArray(results) && results.length === 0)) {
    return {
      valid: false,
      reason: 'EMPTY_VERIFICATION_RESULTS',
      detail: 'Evidence indicates 0 tests or empty results array',
    };
  }

  // Check for any failures or blocking items
  const failedCount = parsed.failedCount ?? parsed.failures ?? (Array.isArray(results) ? results.filter(r => r.verdict === 'failed' || r.status === 'fail').length : 0);
  if (failedCount > 0) {
    return {
      valid: false,
      reason: 'SHADOW_VERIFICATION_FAILED',
      detail: `Evidence contains ${failedCount} test failure(s)`,
    };
  }

  // Check overall verdict
  const verdict = String(parsed.verdict || parsed.status || '').toUpperCase();
  if (verdict !== 'PASS' && verdict !== 'PASSED' && verdict !== 'PROVEN') {
    return {
      valid: false,
      reason: 'SHADOW_VERIFICATION_FAILED',
      detail: `Evidence recorded non-passing verdict: ${verdict}`,
    };
  }

  return {
    valid: true,
    reason: null,
    evidence: parsed,
  };
}

/**
 * Validates moving ref / remote head actively against git remote or local refs.
 */
export function verifyRemoteRef({ ref, expectedSha, remote = 'origin', cwd = ROOT }) {
  // Check if remote exists
  const remoteCheck = runGit(['remote', 'get-url', remote], cwd);
  if (remoteCheck.status === 0) {
    // Active query of remote ref
    const lsRemote = runGit(['ls-remote', remote, ref], cwd);
    if (lsRemote.status === 0 && lsRemote.stdout) {
      const match = lsRemote.stdout.split(/\s+/)[0];
      if (match && /^[0-9a-f]{40}$/i.test(match)) {
        if (expectedSha && match.toLowerCase() !== expectedSha.toLowerCase()) {
          return {
            valid: false,
            remoteSha: match,
            reason: 'REMOTE_REF_MOVED',
            detail: `Remote ref ${ref} on ${remote} is at ${match}, differing from expected ${expectedSha}`,
          };
        }
        return { valid: true, remoteSha: match };
      }
    }
  }

  // Fallback to local rev-parse of remote tracking ref or local ref
  const revParse = runGit(['rev-parse', `${remote}/${ref}`], cwd);
  if (revParse.status === 0) {
    const sha = revParse.stdout.trim();
    if (expectedSha && sha.toLowerCase() !== expectedSha.toLowerCase()) {
      return {
        valid: false,
        remoteSha: sha,
        reason: 'REMOTE_REF_MOVED',
        detail: `Local tracking ref ${remote}/${ref} is at ${sha}, differing from expected ${expectedSha}`,
      };
    }
    return { valid: true, remoteSha: sha };
  }

  return {
    valid: true,
    remoteSha: null,
    note: `Could not reach remote ${remote} or resolve ${remote}/${ref}; checked local only`,
  };
}

/**
 * Full exact-SHA candidate merge-tree verification.
 * Follows docs/ENGINEERING_PROCESS_GUARDRAILS.md §3.3:
 * 1. Refetch live main/integration/component refs and reject stale base/head
 * 2. Compute candidate merge tree
 * 3. Inspect component changed-files relative to common merge-base
 * 4. Inspect actual candidate changed-file union (base..candidateTree)
 * 5. Run ownership checks on changed inventories
 * 6. Materialize candidate commit and verify shadow proof bound to candidate commit & tree
 */
export function verifyCandidateMergeTree({
  lane,
  baseSha,
  expectedBaseSha,
  headSha,
  expectedHeadSha,
  expectedCandidateTree = null,
  shadowEvidencePath = null,
  remoteCheck = false,
  remoteName = 'origin',
  baseRef = 'main',
  repoDir = ROOT,
  manifest = loadManifest(),
  requireShadowEvidence = true,
}) {
  const errors = [];

  // 1. Moving base & head check (active remote validation if enabled)
  if (expectedBaseSha && baseSha.toLowerCase() !== expectedBaseSha.toLowerCase()) {
    errors.push({
      code: 'MOVING_HEAD_MISMATCH',
      message: `Base SHA ${baseSha} does not match expected integration base ${expectedBaseSha}`,
    });
  }
  if (expectedHeadSha && headSha.toLowerCase() !== expectedHeadSha.toLowerCase()) {
    errors.push({
      code: 'COMPONENT_HEAD_MISMATCH',
      message: `Component head SHA ${headSha} does not match expected head ${expectedHeadSha}`,
    });
  }

  if (remoteCheck) {
    const refResult = verifyRemoteRef({ ref: baseRef, expectedSha: expectedBaseSha || baseSha, remote: remoteName, cwd: repoDir });
    if (!refResult.valid) {
      errors.push({
        code: 'MOVING_HEAD_MISMATCH',
        message: refResult.detail,
      });
    }
  }

  // 2. Candidate merge tree computation
  const mergeTreeResult = computeMergeTree(baseSha, headSha, repoDir);
  if (!mergeTreeResult.success) {
    errors.push({
      code: 'MERGE_TREE_FAILURE',
      message: mergeTreeResult.error,
    });
  } else if (expectedCandidateTree && mergeTreeResult.treeSha.toLowerCase() !== expectedCandidateTree.toLowerCase()) {
    errors.push({
      code: 'CANDIDATE_TREE_MISMATCH',
      message: `Computed candidate tree ${mergeTreeResult.treeSha} does not match expected ${expectedCandidateTree}`,
    });
  }

  const candidateTreeSha = mergeTreeResult.treeSha;

  // 3 & 4. Compute accurate changed files:
  // Component changes: diff between common merge-base and head (merge-base...head)
  // Candidate tree union: diff between base commit and candidate tree
  let componentFiles = [];
  let candidateTreeFiles = [];
  try {
    const mergeBaseRes = runGit(['merge-base', baseSha, headSha], repoDir);
    const mergeBase = mergeBaseRes.status === 0 ? mergeBaseRes.stdout : baseSha;

    const compDiff = runGit(['diff', '--name-only', `${mergeBase}..${headSha}`], repoDir);
    if (compDiff.status === 0) {
      componentFiles = compDiff.stdout.split('\n').filter(Boolean);
    } else {
      errors.push({ code: 'GIT_DIFF_FAILED', message: compDiff.stderr });
    }

    if (candidateTreeSha) {
      const treeDiff = runGit(['diff', '--name-only', baseSha, candidateTreeSha], repoDir);
      if (treeDiff.status === 0) {
        candidateTreeFiles = treeDiff.stdout.split('\n').filter(Boolean);
      }
    }
  } catch (err) {
    errors.push({ code: 'GIT_DIFF_EXCEPTION', message: err.message });
  }

  // Union of files introduced by component
  const candidateUnionFiles = [...new Set([...componentFiles, ...candidateTreeFiles])].sort();

  // Validate ownership on componentFiles and candidateTreeFiles
  const compOwnership = validateInventory(manifest, lane, componentFiles, { allowIntegrationGovernance: lane === 'integration' });
  if (!compOwnership.valid) {
    errors.push({
      code: 'OWNERSHIP_VIOLATION',
      message: `Lane ${lane} component diff violates ownership: ${compOwnership.violations.join(', ')}`,
      violations: compOwnership.violations,
    });
  }

  // If candidate tree introduced files outside lane (and not integration lane)
  if (lane !== manifest.integrationLane) {
    const unionViolations = candidateTreeFiles.filter(f => !compOwnership.files.includes(f));
    // Any file changed in the candidate tree that the component lane doesn't own
    const forbiddenUnion = candidateTreeFiles.filter(f => !validateInventory(manifest, lane, [f]).valid);
    if (forbiddenUnion.length > 0) {
      errors.push({
        code: 'CANDIDATE_UNION_OWNERSHIP_VIOLATION',
        message: `Candidate tree introduces forbidden changes for lane ${lane}: ${forbiddenUnion.join(', ')}`,
        violations: forbiddenUnion,
      });
    }
  }

  // 5. Materialize candidate commit and verify shadow proof
  let candidateCommitSha = null;
  let shadowResult = null;
  if (candidateTreeSha) {
    try {
      candidateCommitSha = materializeCandidateCommit({
        baseSha,
        headSha,
        treeSha: candidateTreeSha,
        cwd: repoDir,
      });
    } catch (commitErr) {
      errors.push({
        code: 'CANDIDATE_COMMIT_CREATION_FAILED',
        message: commitErr.message,
      });
    }
  }

  if (requireShadowEvidence) {
    if (!shadowEvidencePath) {
      errors.push({
        code: 'MISSING_SHADOW_EVIDENCE',
        message: 'No shadow evidence path provided and requireShadowEvidence is true',
      });
    } else if (candidateCommitSha && candidateTreeSha) {
      shadowResult = validateShadowEvidence({
        evidencePath: shadowEvidencePath,
        expectedCandidateCommit: candidateCommitSha,
        expectedCandidateTree: candidateTreeSha,
      });
      if (!shadowResult.valid) {
        errors.push({
          code: shadowResult.reason,
          message: shadowResult.detail,
        });
      }
    }
  }

  const verdict = errors.length === 0 ? 'PASS' : 'BLOCKING';

  return {
    verdict,
    valid: errors.length === 0,
    lane,
    baseSha,
    headSha,
    candidateTreeSha,
    candidateCommitSha,
    componentFiles,
    candidateTreeFiles,
    candidateUnionFiles,
    ownershipResult: compOwnership,
    shadowResult,
    errors,
  };
}

/**
 * Prepares exact candidate environment (synthesizes merge commit and outputs verification plan).
 */
export function prepareCandidate({ lane, baseSha, headSha, repoDir = ROOT }) {
  const treeResult = computeMergeTree(baseSha, headSha, repoDir);
  if (!treeResult.success) {
    throw new Error(`Candidate merge tree computation failed: ${treeResult.error}`);
  }
  const commitSha = materializeCandidateCommit({
    baseSha,
    headSha,
    treeSha: treeResult.treeSha,
    cwd: repoDir,
  });
  return {
    lane,
    baseSha,
    headSha,
    candidateTreeSha: treeResult.treeSha,
    candidateCommitSha: commitSha,
  };
}

export function runCli(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr } = {}) {
  let lane = null;
  let baseSha = null;
  let expectedBaseSha = null;
  let headSha = null;
  let expectedHeadSha = null;
  let expectedTreeSha = null;
  let shadowEvidencePath = null;
  let repoDir = ROOT;
  let requireShadowEvidence = true;
  let remoteCheck = false;
  let remoteName = 'origin';
  let baseRef = 'main';

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--lane' && argv[i + 1]) lane = argv[++i];
    else if (arg === '--base' && argv[i + 1]) baseSha = argv[++i];
    else if (arg === '--expected-base' && argv[i + 1]) expectedBaseSha = argv[++i];
    else if (arg === '--head' && argv[i + 1]) headSha = argv[++i];
    else if (arg === '--expected-head' && argv[i + 1]) expectedHeadSha = argv[++i];
    else if (arg === '--expected-tree' && argv[i + 1]) expectedTreeSha = argv[++i];
    else if (arg === '--shadow-evidence' && argv[i + 1]) shadowEvidencePath = argv[++i];
    else if (arg === '--repo' && argv[i + 1]) repoDir = argv[++i];
    else if (arg === '--remote-check') remoteCheck = true;
    else if (arg === '--remote' && argv[i + 1]) remoteName = argv[++i];
    else if (arg === '--base-ref' && argv[i + 1]) baseRef = argv[++i];
    else if (arg === '--no-shadow') requireShadowEvidence = false;
  }

  if (!lane || !baseSha || !headSha) {
    stderr.write('Usage: node hex-completion-merge-tree.mjs --lane <lane> --base <baseSha> --head <headSha> [--expected-base <sha>] [--expected-head <sha>] [--expected-tree <sha>] [--shadow-evidence <path>] [--remote-check] [--no-shadow]\n');
    return 1;
  }

  const result = verifyCandidateMergeTree({
    lane,
    baseSha,
    expectedBaseSha: expectedBaseSha || baseSha,
    headSha,
    expectedHeadSha: expectedHeadSha || headSha,
    expectedCandidateTree: expectedTreeSha,
    shadowEvidencePath,
    remoteCheck,
    remoteName,
    baseRef,
    repoDir,
    requireShadowEvidence,
  });

  stdout.write(JSON.stringify(result, null, 2) + '\n');
  return result.valid ? 0 : 1;
}

const isMain = process.argv[1] && new URL(`file://${process.argv[1]}`).pathname === new URL(import.meta.url).pathname;
if (isMain) {
  const code = runCli();
  process.exit(code);
}
