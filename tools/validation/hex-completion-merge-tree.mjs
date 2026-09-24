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
 * Supports modern git `git merge-tree --write-tree base head`, or 3-arg `git merge-tree <ancestor> <base> <head>`.
 * Alternatively, if git version is older than 2.38 and doesn't support --write-tree,
 * derives merge tree via `git merge-base` or index commit simulation.
 */
export function computeMergeTree(baseSha, headSha, cwd = ROOT) {
  // First attempt: git merge-tree --write-tree (Git 2.38+)
  let result = runGit(['merge-tree', '--write-tree', baseSha, headSha], cwd);
  if (result.status === 0) {
    const treeSha = result.stdout.split(/\s+/).find((val) => /^[0-9a-f]{40}$/i.test(val));
    if (treeSha) {
      return { success: true, treeSha, error: null };
    }
  }

  // Fallback for Git < 2.38: compute merge-base and tree using temporary index
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

    // If head is descendant of base, the tree is simply head's tree
    if (mergeBase.toLowerCase() === baseCommit.toLowerCase()) {
      const headTree = runGit(['rev-parse', `${headCommit}^{tree}`], cwd).stdout;
      return { success: true, treeSha: headTree, error: null };
    }
    // If base is descendant of head, tree is base's tree
    if (mergeBase.toLowerCase() === headCommit.toLowerCase()) {
      const baseTree = runGit(['rev-parse', `${baseCommit}^{tree}`], cwd).stdout;
      return { success: true, treeSha: baseTree, error: null };
    }

    // Otherwise compute simulated merge tree safely using a custom isolated temporary index
    const tmpIndex = path.join(cwd, `.git/temp-merge-index-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
      execFileSync('git', ['read-tree', '-m', '-u', '--reset', mergeBase, baseCommit, headCommit], { cwd, env, stdio: 'ignore' });
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
 * Validates shadow evidence file for the candidate merge.
 * Requires:
 *  - File exists and is non-empty valid JSON
 *  - Verifies candidateCommitSha matches expected candidate head
 *  - Verifies candidateTreeSha matches expected candidate merge tree
 *  - Verifies verdict is PASS / proven
 */
export function validateShadowEvidence({
  evidencePath,
  expectedCandidateHead,
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

  if (!parsed || typeof parsed !== 'object') {
    return {
      valid: false,
      reason: 'MALFORMED_SHADOW_EVIDENCE',
      detail: 'Evidence JSON is not an object',
    };
  }

  // Exact head matching
  const candidateHead = parsed.candidateHead || parsed.candidateCommitSha || parsed.headSha || parsed.head;
  if (!candidateHead || candidateHead.toLowerCase() !== expectedCandidateHead.toLowerCase()) {
    return {
      valid: false,
      reason: 'CANDIDATE_HEAD_MISMATCH',
      detail: `Evidence candidate head ${candidateHead} does not match expected ${expectedCandidateHead}`,
    };
  }

  // Exact candidate merge tree matching
  const candidateTree = parsed.candidateTree || parsed.candidateTreeSha || parsed.treeSha || parsed.mergeTree;
  if (!candidateTree || candidateTree.toLowerCase() !== expectedCandidateTree.toLowerCase()) {
    return {
      valid: false,
      reason: 'CANDIDATE_MERGE_TREE_MISMATCH',
      detail: `Evidence candidate tree ${candidateTree} does not match expected ${expectedCandidateTree}`,
    };
  }

  // Check verdict
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
 * Full exact-SHA candidate merge-tree verification.
 * Checks:
 * 1. Base SHA matches expected living integration base (moving-head guardrail)
 * 2. Component head matches expected component SHA
 * 3. Changed file inventory strictly conforms to lane ownership policy
 * 4. Merge tree can be computed cleanly and matches expectedCandidateTree (if provided)
 * 5. Independent shadow evidence exists and proves exact (headSha, treeSha)
 */
export function verifyCandidateMergeTree({
  lane,
  baseSha,
  expectedBaseSha,
  headSha,
  expectedHeadSha,
  expectedCandidateTree = null,
  shadowEvidencePath = null,
  repoDir = ROOT,
  manifest = loadManifest(),
  requireShadowEvidence = true,
}) {
  const errors = [];

  // 1. Moving base check
  if (expectedBaseSha && baseSha.toLowerCase() !== expectedBaseSha.toLowerCase()) {
    errors.push({
      code: 'MOVING_HEAD_MISMATCH',
      message: `Base SHA ${baseSha} does not match expected integration base ${expectedBaseSha}`,
    });
  }

  // 2. Component head check
  if (expectedHeadSha && headSha.toLowerCase() !== expectedHeadSha.toLowerCase()) {
    errors.push({
      code: 'COMPONENT_HEAD_MISMATCH',
      message: `Component head SHA ${headSha} does not match expected head ${expectedHeadSha}`,
    });
  }

  // 3. Ownership validation on changed files
  let changedFiles = [];
  try {
    const gitDiff = runGit(['diff', '--name-only', `${baseSha}..${headSha}`], repoDir);
    if (gitDiff.status !== 0) {
      errors.push({
        code: 'GIT_DIFF_FAILED',
        message: `Failed to diff ${baseSha}..${headSha}: ${gitDiff.stderr}`,
      });
    } else {
      changedFiles = gitDiff.stdout.split('\n').filter(Boolean);
    }
  } catch (err) {
    errors.push({
      code: 'GIT_DIFF_EXCEPTION',
      message: err.message,
    });
  }

  const ownershipResult = validateInventory(manifest, lane, changedFiles, { allowIntegrationGovernance: lane === 'integration' });
  if (!ownershipResult.valid) {
    errors.push({
      code: 'OWNERSHIP_VIOLATION',
      message: `Lane ${lane} modified forbidden files: ${ownershipResult.violations.join(', ')}`,
      violations: ownershipResult.violations,
    });
  }

  // 4. Merge tree computation
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

  const actualTreeSha = mergeTreeResult.treeSha;

  // 5. Shadow evidence verification
  let shadowResult = null;
  if (requireShadowEvidence) {
    if (!shadowEvidencePath) {
      errors.push({
        code: 'MISSING_SHADOW_EVIDENCE',
        message: 'No shadow evidence path provided and requireShadowEvidence is true',
      });
    } else if (actualTreeSha) {
      shadowResult = validateShadowEvidence({
        evidencePath: shadowEvidencePath,
        expectedCandidateHead: headSha,
        expectedCandidateTree: actualTreeSha,
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
    candidateTreeSha: actualTreeSha,
    changedFiles,
    ownershipResult,
    shadowResult,
    errors,
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
    else if (arg === '--no-shadow') requireShadowEvidence = false;
  }

  if (!lane || !baseSha || !headSha) {
    stderr.write('Usage: node hex-completion-merge-tree.mjs --lane <lane> --base <baseSha> --head <headSha> [--expected-base <sha>] [--expected-head <sha>] [--expected-tree <sha>] [--shadow-evidence <path>] [--no-shadow]\n');
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
