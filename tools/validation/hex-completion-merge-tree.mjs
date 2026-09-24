import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { loadManifest, validateInventory } from './hex-completion-ownership.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const CANONICAL_VERIFIER_SCRIPT = 'tools/validation/stage2/verify.mjs';

export function runGit(args, cwd = ROOT, envOverride = {}) {
  try {
    const stdout = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, ...envOverride },
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
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
 * Resolves a git directory or scratch index path safely, working in both root repos and linked worktrees.
 */
export function getGitPath(subpath, cwd = ROOT) {
  const res = runGit(['rev-parse', '--git-path', subpath], cwd);
  if (res.status === 0 && res.stdout) {
    return path.resolve(cwd, res.stdout);
  }
  const dirRes = runGit(['rev-parse', '--git-dir'], cwd);
  const gitDir = dirRes.status === 0 ? path.resolve(cwd, dirRes.stdout) : path.join(cwd, '.git');
  return path.join(gitDir, subpath);
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

    const tmpIndex = getGitPath(`temp-merge-index-${Date.now()}-${Math.random().toString(36).slice(2)}`, cwd);
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
 * Creates/synthesizes a deterministic exact candidate merge commit object.
 */
export function materializeCandidateCommit({
  baseSha,
  headSha,
  treeSha,
  message = 'candidate: synthetic merge for verification',
  cwd = ROOT,
  authorDate = '2026-09-24T00:00:00Z',
}) {
  const env = {
    GIT_AUTHOR_NAME: 'Hex Candidate Verifier',
    GIT_AUTHOR_EMAIL: 'candidate-verifier@hex.invalid',
    GIT_AUTHOR_DATE: authorDate,
    GIT_COMMITTER_NAME: 'Hex Candidate Verifier',
    GIT_COMMITTER_EMAIL: 'candidate-verifier@hex.invalid',
    GIT_COMMITTER_DATE: authorDate,
  };

  const commitRes = runGit(['commit-tree', treeSha, '-p', baseSha, '-p', headSha, '-m', message], cwd, env);
  if (commitRes.status !== 0) {
    throw new Error(`Failed to commit-tree: ${commitRes.stderr || commitRes.stdout}`);
  }
  return commitRes.stdout.trim();
}

/**
 * Calculates SHA256 of a file.
 */
export function hashFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Resolves trusted verifier identity and content hash from path or defaults.
 */
export function resolveTrustedVerifier(scriptPath = CANONICAL_VERIFIER_SCRIPT, cwd = ROOT) {
  const fullPath = path.isAbsolute(scriptPath) ? scriptPath : path.join(cwd, scriptPath);
  const hash = hashFile(fullPath);
  return {
    identity: scriptPath,
    hash: hash || 'unresolvable-verifier-hash',
  };
}

/**
 * Validates shadow evidence file for the candidate merge.
 * Release validation MANDATES:
 *  - trustedVerifierIdentity and trustedVerifierHash must be explicitly provided
 *  - Verifier identity & hash must strictly match
 *  - Oracle, corpus, and toolchain must be present and non-empty
 *  - Exact candidateCommitSha and candidateTreeSha must match
 *  - Non-empty actual results array (each result must have an id/name and pass status)
 *  - Zero failed/blocking/unknown tests
 *  - Explicit overall verdict PASS / PROVEN
 */
export function validateShadowEvidence({
  evidencePath,
  expectedCandidateCommit,
  expectedCandidateTree,
  trustedVerifierIdentity,
  trustedVerifierHash,
}) {
  if (!evidencePath || !fs.existsSync(evidencePath)) {
    return {
      valid: false,
      reason: 'MISSING_SHADOW_EVIDENCE',
      detail: `Evidence file not found: ${evidencePath}`,
    };
  }

  // Release gate mandates trusted verifier inputs
  if (!trustedVerifierIdentity || typeof trustedVerifierIdentity !== 'string') {
    return {
      valid: false,
      reason: 'MISSING_TRUSTED_VERIFIER_IDENTITY',
      detail: 'Release verification requires explicit trustedVerifierIdentity',
    };
  }
  if (!trustedVerifierHash || typeof trustedVerifierHash !== 'string') {
    return {
      valid: false,
      reason: 'MISSING_TRUSTED_VERIFIER_HASH',
      detail: 'Release verification requires explicit trustedVerifierHash',
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

  // 1. Verifier identity & hash check
  const verifierId = parsed.verifier || parsed.verifierId || parsed.verifierName;
  const verifierHash = parsed.verifierVersion || parsed.verifierHash || parsed.verifierSha;
  if (!verifierId || typeof verifierId !== 'string' || !verifierHash || typeof verifierHash !== 'string') {
    return {
      valid: false,
      reason: 'UNVERIFIED_VERIFIER_IDENTITY',
      detail: 'Evidence missing required verifier identity/hash strings',
    };
  }
  if (verifierId !== trustedVerifierIdentity) {
    return {
      valid: false,
      reason: 'VERIFIER_IDENTITY_MISMATCH',
      detail: `Verifier identity '${verifierId}' does not match trusted '${trustedVerifierIdentity}'`,
    };
  }
  if (verifierHash !== trustedVerifierHash) {
    return {
      valid: false,
      reason: 'VERIFIER_HASH_MISMATCH',
      detail: `Verifier hash '${verifierHash}' does not match trusted '${trustedVerifierHash}'`,
    };
  }

  // 2. Oracle / Corpus / Toolchain provenance
  const oracle = parsed.oracle || parsed.oracleIdentity;
  const corpus = parsed.corpus || parsed.corpusIdentity;
  const toolchain = parsed.toolchain || parsed.toolchainIdentity;
  if (!oracle || typeof oracle !== 'string' || !corpus || typeof corpus !== 'string' || !toolchain || typeof toolchain !== 'string') {
    return {
      valid: false,
      reason: 'MISSING_PROVENANCE_METADATA',
      detail: 'Evidence must specify non-empty oracle, corpus, and toolchain identities',
    };
  }

  // 3. Exact candidate commit matching
  const candidateCommit = parsed.candidateCommitSha || parsed.candidateCommit || parsed.candidateHead || parsed.headSha;
  if (!candidateCommit || candidateCommit.toLowerCase() !== expectedCandidateCommit.toLowerCase()) {
    return {
      valid: false,
      reason: 'CANDIDATE_COMMIT_MISMATCH',
      detail: `Evidence candidate commit ${candidateCommit} does not match expected ${expectedCandidateCommit}`,
    };
  }

  // 4. Exact candidate merge tree matching
  const candidateTree = parsed.candidateTreeSha || parsed.candidateTree || parsed.treeSha || parsed.mergeTree;
  if (!candidateTree || candidateTree.toLowerCase() !== expectedCandidateTree.toLowerCase()) {
    return {
      valid: false,
      reason: 'CANDIDATE_MERGE_TREE_MISMATCH',
      detail: `Evidence candidate tree ${candidateTree} does not match expected ${expectedCandidateTree}`,
    };
  }

  // 5. Results validation: must contain a nonempty results array
  const results = parsed.results;
  if (!Array.isArray(results) || results.length === 0) {
    return {
      valid: false,
      reason: 'EMPTY_VERIFICATION_RESULTS',
      detail: 'Evidence must contain a non-empty results array with individual test verdicts',
    };
  }

  // Validate each result entry
  for (let i = 0; i < results.length; i++) {
    const item = results[i];
    if (!item || typeof item !== 'object' || (!item.id && !item.name && !item.test)) {
      return {
        valid: false,
        reason: 'INVALID_RESULT_ENTRY',
        detail: `Result entry at index ${i} is missing an identifying test/case name`,
      };
    }
    const itemVerdict = String(item.verdict || item.status || '').toLowerCase();
    if (itemVerdict !== 'pass' && itemVerdict !== 'passed' && itemVerdict !== 'proven') {
      return {
        valid: false,
        reason: 'SHADOW_VERIFICATION_FAILED',
        detail: `Test ${item.id || item.name || item.test} recorded non-passing status: ${itemVerdict}`,
      };
    }
  }

  // 6. Overall verdict
  const verdict = String(parsed.verdict || parsed.status || '').toUpperCase();
  if (verdict !== 'PASS' && verdict !== 'PASSED' && verdict !== 'PROVEN') {
    return {
      valid: false,
      reason: 'SHADOW_VERIFICATION_FAILED',
      detail: `Evidence recorded non-passing overall verdict: ${verdict}`,
    };
  }

  return {
    valid: true,
    reason: null,
    evidence: parsed,
  };
}

/**
 * Validates moving ref / remote head actively against git remote.
 * Fails closed if remote is unreachable or ref does not exist.
 */
export function verifyRemoteRef({
  ref,
  expectedSha = null,
  remote = 'origin',
  cwd = ROOT,
  fetchFirst = false,
}) {
  if (fetchFirst) {
    const fetchRes = runGit(['fetch', '--no-tags', remote, ref], cwd);
    if (fetchRes.status !== 0) {
      return {
        valid: false,
        remoteSha: null,
        reason: 'REMOTE_FETCH_FAILED',
        detail: `Failed to fetch ${ref} from ${remote}: ${fetchRes.stderr || fetchRes.stdout}`,
      };
    }
  }

  // Mandatory remote query
  const lsRemote = runGit(['ls-remote', remote, ref], cwd);
  if (lsRemote.status !== 0) {
    return {
      valid: false,
      remoteSha: null,
      reason: 'REMOTE_UNREACHABLE',
      detail: `Remote ${remote} is unreachable or git ls-remote failed: ${lsRemote.stderr}`,
    };
  }

  if (!lsRemote.stdout) {
    return {
      valid: false,
      remoteSha: null,
      reason: 'REMOTE_REF_NOT_FOUND',
      detail: `Ref ${ref} was not found on remote ${remote}`,
    };
  }

  const match = lsRemote.stdout.split(/\s+/)[0];
  if (!match || !/^[0-9a-f]{40}$/i.test(match)) {
    return {
      valid: false,
      remoteSha: null,
      reason: 'INVALID_REMOTE_SHA',
      detail: `Could not parse valid 40-hex SHA from ls-remote output for ${ref}: ${lsRemote.stdout}`,
    };
  }

  if (expectedSha && match.toLowerCase() !== expectedSha.toLowerCase()) {
    return {
      valid: false,
      remoteSha: match,
      reason: 'REMOTE_REF_MOVED',
      detail: `Remote ref ${ref} on ${remote} is at ${match}, differing from expected ${expectedSha}`,
    };
  }

  return {
    valid: true,
    remoteSha: match,
    reason: null,
  };
}

/**
 * Full exact-SHA candidate merge-tree verification.
 * Follows docs/ENGINEERING_PROCESS_GUARDRAILS.md §3.3 & §7:
 * Release requirements:
 * 1. Remote check is mandatory for release PASS. If remoteCheck is skipped, verdict is DIAGNOSTIC_PASS_NOT_RELEASE_ELIGIBLE.
 * 2. Mandatory live mainRef, integrationRef, and componentRef verification against live remote.
 * 3. Proves living integration base contains live main (ancestor check).
 * 4. Proves component head matches live component ref.
 * 5. Computes candidate merge tree.
 * 6. Inspects component changed-files relative to common merge-base.
 * 7. Inspects actual candidate changed-file union (base..candidateTree).
 * 8. Runs ownership checks on changed inventories.
 * 9. Materializes deterministic candidate commit and verifies shadow proof bound to candidate commit & tree.
 */
export function verifyCandidateMergeTree({
  lane,
  baseSha,
  expectedBaseSha,
  headSha,
  expectedHeadSha,
  expectedCandidateTree = null,
  candidateCommitSha = null,
  shadowEvidencePath = null,
  requireRemoteCheck = true,
  remoteName = 'origin',
  mainRef = 'main',
  integrationRef = null,
  componentRef = null,
  expectedMainSha = null,
  trustedVerifierIdentity = null,
  trustedVerifierHash = null,
  repoDir = ROOT,
  manifest = loadManifest(),
  requireShadowEvidence = true,
}) {
  const errors = [];

  // For release, remote check and all refs are strictly required
  if (requireRemoteCheck) {
    if (!integrationRef) {
      errors.push({
        code: 'MISSING_INTEGRATION_REF',
        message: 'Release verification requires explicit --integration-ref',
      });
    }
    if (!componentRef) {
      errors.push({
        code: 'MISSING_COMPONENT_REF',
        message: 'Release verification requires explicit --component-ref',
      });
    }

    // Check live main
    const mainCheck = verifyRemoteRef({ ref: mainRef, expectedSha: expectedMainSha, remote: remoteName, cwd: repoDir, fetchFirst: true });
    if (!mainCheck.valid) {
      errors.push({
        code: mainCheck.reason,
        message: `Live main ref verification failed: ${mainCheck.detail}`,
      });
    } else {
      const liveMainSha = mainCheck.remoteSha;
      // Verify integration base contains live main
      const isAncestor = runGit(['merge-base', '--is-ancestor', liveMainSha, baseSha], repoDir);
      if (isAncestor.status !== 0) {
        errors.push({
          code: 'INTEGRATION_NOT_RECONCILED_WITH_MAIN',
          message: `Living integration base ${baseSha} does not contain live main ${liveMainSha}`,
        });
      }
    }

    // Check live integration ref
    if (integrationRef) {
      const intCheck = verifyRemoteRef({ ref: integrationRef, expectedSha: expectedBaseSha || baseSha, remote: remoteName, cwd: repoDir, fetchFirst: true });
      if (!intCheck.valid) {
        errors.push({
          code: intCheck.reason,
          message: `Live integration ref verification failed: ${intCheck.detail}`,
        });
      }
    }

    // Check live component ref
    if (componentRef) {
      const compCheck = verifyRemoteRef({ ref: componentRef, expectedSha: expectedHeadSha || headSha, remote: remoteName, cwd: repoDir, fetchFirst: true });
      if (!compCheck.valid) {
        errors.push({
          code: compCheck.reason,
          message: `Live component ref verification failed: ${compCheck.detail}`,
        });
      }
    }
  }

  // Base and head expected checks
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

  // 3 & 4. Accurate changed files
  let componentFiles = [];
  let candidateTreeFiles = [];
  let diffOk = true;

  const mergeBaseRes = runGit(['merge-base', baseSha, headSha], repoDir);
  if (mergeBaseRes.status !== 0) {
    errors.push({
      code: 'MERGE_BASE_FAILURE',
      message: `git merge-base failed between ${baseSha} and ${headSha}: ${mergeBaseRes.stderr}`,
    });
    diffOk = false;
  } else {
    const mergeBase = mergeBaseRes.stdout;
    const compDiff = runGit(['diff', '--name-only', `${mergeBase}..${headSha}`], repoDir);
    if (compDiff.status === 0) {
      componentFiles = compDiff.stdout.split('\n').filter(Boolean);
    } else {
      errors.push({ code: 'GIT_DIFF_FAILED', message: `Component diff failed: ${compDiff.stderr}` });
      diffOk = false;
    }
  }

  if (candidateTreeSha) {
    const treeDiff = runGit(['diff', '--name-only', baseSha, candidateTreeSha], repoDir);
    if (treeDiff.status === 0) {
      candidateTreeFiles = treeDiff.stdout.split('\n').filter(Boolean);
    } else {
      errors.push({ code: 'CANDIDATE_TREE_DIFF_FAILED', message: `Candidate tree diff failed: ${treeDiff.stderr}` });
      diffOk = false;
    }
  }

  const candidateUnionFiles = [...new Set([...componentFiles, ...candidateTreeFiles])].sort();

  // Validate ownership
  let compOwnership = null;
  if (diffOk) {
    compOwnership = validateInventory(manifest, lane, componentFiles, { allowIntegrationGovernance: lane === 'integration' });
    if (!compOwnership.valid) {
      errors.push({
        code: 'OWNERSHIP_VIOLATION',
        message: `Lane ${lane} component diff violates ownership: ${compOwnership.violations.join(', ')}`,
        violations: compOwnership.violations,
      });
    }

    if (lane !== manifest.integrationLane) {
      const forbiddenUnion = candidateTreeFiles.filter((f) => !validateInventory(manifest, lane, [f]).valid);
      if (forbiddenUnion.length > 0) {
        errors.push({
          code: 'CANDIDATE_UNION_OWNERSHIP_VIOLATION',
          message: `Candidate tree introduces forbidden changes for lane ${lane}: ${forbiddenUnion.join(', ')}`,
          violations: forbiddenUnion,
        });
      }
    }
  }

  // 5. Materialize or verify candidate commit
  let actualCandidateCommit = candidateCommitSha;
  if (candidateTreeSha) {
    try {
      const deterministicCommit = materializeCandidateCommit({
        baseSha,
        headSha,
        treeSha: candidateTreeSha,
        cwd: repoDir,
      });
      if (actualCandidateCommit && actualCandidateCommit.toLowerCase() !== deterministicCommit.toLowerCase()) {
        errors.push({
          code: 'CANDIDATE_COMMIT_MISMATCH',
          message: `Supplied candidate commit ${actualCandidateCommit} does not match deterministic candidate commit ${deterministicCommit}`,
        });
      }
      actualCandidateCommit = deterministicCommit;
    } catch (commitErr) {
      errors.push({
        code: 'CANDIDATE_COMMIT_CREATION_FAILED',
        message: commitErr.message,
      });
    }
  }

  // 6. Shadow evidence verification
  let shadowResult = null;
  if (requireShadowEvidence) {
    if (!shadowEvidencePath) {
      errors.push({
        code: 'MISSING_SHADOW_EVIDENCE',
        message: 'No shadow evidence path provided and requireShadowEvidence is true',
      });
    } else if (actualCandidateCommit && candidateTreeSha) {
      shadowResult = validateShadowEvidence({
        evidencePath: shadowEvidencePath,
        expectedCandidateCommit: actualCandidateCommit,
        expectedCandidateTree: candidateTreeSha,
        trustedVerifierIdentity,
        trustedVerifierHash,
      });
      if (!shadowResult.valid) {
        errors.push({
          code: shadowResult.reason,
          message: shadowResult.detail,
        });
      }
    }
  }

  const isReleaseEligible = requireRemoteCheck && requireShadowEvidence;
  let verdict = 'BLOCKING';
  if (errors.length === 0) {
    verdict = isReleaseEligible ? 'PASS' : 'DIAGNOSTIC_PASS_NOT_RELEASE_ELIGIBLE';
  }

  return {
    verdict,
    valid: errors.length === 0 && isReleaseEligible,
    diagnosticOnly: !isReleaseEligible,
    lane,
    baseSha,
    headSha,
    candidateTreeSha,
    candidateCommitSha: actualCandidateCommit,
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

/**
 * Runs an actual verification command in a detached candidate worktree.
 * Creates detached worktree at candidateCommitSha, executes command, collects structured output,
 * cleans up worktree, and returns validated report.
 */
export function runCandidateVerifier({
  candidateCommitSha,
  verifierCommand = ['npm', 'test'],
  outputReportPath = null,
  worktreeDir = null,
  repoDir = ROOT,
  oracle = 'hex-independent-runner',
  corpus = 'production-corpus',
  toolchain = 'node-' + process.version,
  verifierIdentity = 'candidate-verifier/runner',
}) {
  const scratchDir = worktreeDir || path.join(getGitPath('scratch-candidate-wt', repoDir), `cand-${Date.now()}`);
  fs.mkdirSync(path.dirname(scratchDir), { recursive: true });

  const addWt = runGit(['worktree', 'add', '--detach', scratchDir, candidateCommitSha], repoDir);
  if (addWt.status !== 0) {
    throw new Error(`Failed to create detached candidate worktree at ${scratchDir}: ${addWt.stderr || addWt.stdout}`);
  }

  let testStatus = 0;
  let stdout = '';
  let stderr = '';
  try {
    const [cmd, ...args] = verifierCommand;
    stdout = execFileSync(cmd, args, { cwd: scratchDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    testStatus = err.status ?? 1;
    stdout = (err.stdout ?? '').toString();
    stderr = (err.stderr ?? '').toString();
  } finally {
    runGit(['worktree', 'remove', '--force', scratchDir], repoDir);
  }

  const verifierHash = crypto.createHash('sha256').update(String(verifierCommand.join(' '))).digest('hex');
  const treeSha = runGit(['rev-parse', `${candidateCommitSha}^{tree}`], repoDir).stdout;

  const evidence = {
    schemaVersion: 'hex-shadow-evidence/v2',
    verifier: verifierIdentity,
    verifierVersion: verifierHash,
    oracle,
    corpus,
    toolchain,
    candidateCommitSha,
    candidateTreeSha: treeSha,
    status: testStatus === 0 ? 'PASS' : 'FAIL',
    verdict: testStatus === 0 ? 'PASS' : 'BLOCKING',
    results: [
      {
        id: verifierCommand.join(' '),
        status: testStatus === 0 ? 'PASS' : 'FAIL',
        verdict: testStatus === 0 ? 'PASS' : 'FAIL',
        exitCode: testStatus,
      },
    ],
    timestamp: new Date().toISOString(),
  };

  if (outputReportPath) {
    fs.mkdirSync(path.dirname(outputReportPath), { recursive: true });
    fs.writeFileSync(outputReportPath, JSON.stringify(evidence, null, 2) + '\n');
  }

  return evidence;
}

export function runCli(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr } = {}) {
  let lane = null;
  let baseSha = null;
  let expectedBaseSha = null;
  let headSha = null;
  let expectedHeadSha = null;
  let expectedTreeSha = null;
  let candidateCommit = null;
  let shadowEvidencePath = null;
  let repoDir = ROOT;
  let requireShadowEvidence = true;
  let requireRemoteCheck = true;
  let remoteName = 'origin';
  let mainRef = 'main';
  let integrationRef = null;
  let componentRef = null;
  let expectedMainSha = null;
  let trustedVerifierIdentity = null;
  let trustedVerifierHash = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--lane' && argv[i + 1]) lane = argv[++i];
    else if (arg === '--base' && argv[i + 1]) baseSha = argv[++i];
    else if (arg === '--expected-base' && argv[i + 1]) expectedBaseSha = argv[++i];
    else if (arg === '--head' && argv[i + 1]) headSha = argv[++i];
    else if (arg === '--expected-head' && argv[i + 1]) expectedHeadSha = argv[++i];
    else if (arg === '--expected-tree' && argv[i + 1]) expectedTreeSha = argv[++i];
    else if (arg === '--candidate-commit' && argv[i + 1]) candidateCommit = argv[++i];
    else if (arg === '--shadow-evidence' && argv[i + 1]) shadowEvidencePath = argv[++i];
    else if (arg === '--trusted-verifier' && argv[i + 1]) trustedVerifierIdentity = argv[++i];
    else if (arg === '--trusted-verifier-hash' && argv[i + 1]) trustedVerifierHash = argv[++i];
    else if (arg === '--repo' && argv[i + 1]) repoDir = argv[++i];
    else if (arg === '--remote' && argv[i + 1]) remoteName = argv[++i];
    else if (arg === '--main-ref' && argv[i + 1]) mainRef = argv[++i];
    else if (arg === '--integration-ref' && argv[i + 1]) integrationRef = argv[++i];
    else if (arg === '--component-ref' && argv[i + 1]) componentRef = argv[++i];
    else if (arg === '--expected-main' && argv[i + 1]) expectedMainSha = argv[++i];
    else if (arg === '--skip-remote-check') requireRemoteCheck = false;
    else if (arg === '--no-shadow') requireShadowEvidence = false;
  }

  if (!lane || !baseSha || !headSha) {
    stderr.write('Usage: node hex-completion-merge-tree.mjs --lane <lane> --base <baseSha> --head <headSha> [--expected-base <sha>] [--expected-head <sha>] [--expected-tree <sha>] [--candidate-commit <sha>] [--shadow-evidence <path>] --trusted-verifier <id> --trusted-verifier-hash <hash> [--main-ref <ref>] [--expected-main <sha>] --integration-ref <ref> --component-ref <ref> [--skip-remote-check] [--no-shadow]\n');
    return 1;
  }

  const result = verifyCandidateMergeTree({
    lane,
    baseSha,
    expectedBaseSha: expectedBaseSha || baseSha,
    headSha,
    expectedHeadSha: expectedHeadSha || headSha,
    expectedCandidateTree: expectedTreeSha,
    candidateCommitSha: candidateCommit,
    shadowEvidencePath,
    requireRemoteCheck,
    remoteName,
    mainRef,
    integrationRef,
    componentRef,
    expectedMainSha,
    trustedVerifierIdentity,
    trustedVerifierHash,
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
