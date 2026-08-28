import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  assertReleaseReady,
  validateOracleReport,
} from './oracle-report.mjs';

const DEFAULT_ALLOWED_PREFIXES = Object.freeze([
  'tools/validation/machine-effects/',
  'tests/machine-effects/',
  'specs/004-independent-machine-effects-oracle/',
]);

function fail(code, detail = null) {
  throw new Error(detail == null ? code : `${code}:${detail}`);
}

function sha(value, code) {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/i.test(value)) fail(code);
  return value.toLowerCase();
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) fail('release-git-command-failed', `${args.join(' ')}:${String(result.stderr || '').trim()}`);
  return String(result.stdout || '').trim();
}

export function changedFilesWithinAllowlist(paths, allowedPrefixes = DEFAULT_ALLOWED_PREFIXES) {
  if (!Array.isArray(paths)) fail('release-changed-files-invalid');
  const violations = paths.filter((file) => !allowedPrefixes.some((prefix) => file.startsWith(prefix)));
  return Object.freeze({
    valid: violations.length === 0,
    paths: Object.freeze([...paths]),
    violations: Object.freeze(violations),
  });
}

export function inspectExactHead({ cwd = process.cwd(), baseSha = null } = {}) {
  const headSha = sha(git(cwd, ['rev-parse', 'HEAD']), 'release-head-sha-invalid');
  const status = git(cwd, ['status', '--porcelain', '--untracked-files=all']);
  const changed = baseSha == null ? [] : git(cwd, ['diff', '--name-only', `${sha(baseSha, 'release-base-sha-invalid')}..HEAD`]).split('\n').filter(Boolean);
  return Object.freeze({
    headSha,
    baseSha: baseSha == null ? null : sha(baseSha, 'release-base-sha-invalid'),
    clean: status === '',
    status,
    changedFiles: Object.freeze(changed),
    allowlist: changedFilesWithinAllowlist(changed),
  });
}

export function verifyExactHead({
  cwd = process.cwd(),
  report,
  expectedHead,
  expectedBase,
  expectedCandidateTree = null,
  requireClean = true,
  requireCandidateTree = false,
} = {}) {
  const head = sha(expectedHead, 'release-expected-head-invalid');
  const base = sha(expectedBase, 'release-expected-base-invalid');
  const inspection = inspectExactHead({ cwd, baseSha: base });
  if (inspection.headSha !== head) fail('release-exact-head-mismatch', `${inspection.headSha}:${head}`);
  if (requireClean && !inspection.clean) fail('release-working-tree-dirty');
  if (!inspection.allowlist.valid) fail('release-changed-file-outside-allowlist', inspection.allowlist.violations.join(','));
  const normalizedReport = validateOracleReport(report);
  assertReleaseReady(normalizedReport, {
    expectedProductSha: head,
    expectedBaseSha: base,
    expectedCandidateTreeSha: expectedCandidateTree,
    requireCandidateTree,
  });
  return Object.freeze({
    valid: true,
    headSha: head,
    baseSha: base,
    candidateTreeSha: normalizedReport.candidateTreeSha,
    clean: inspection.clean,
    changedFiles: inspection.changedFiles,
  });
}

export function verifyCandidateMergeTree({
  report,
  candidateTreeSha,
  expectedBase,
  expectedProductSha = null,
} = {}) {
  const tree = sha(candidateTreeSha, 'candidate-tree-sha-invalid');
  const base = sha(expectedBase, 'candidate-base-sha-invalid');
  const product = expectedProductSha == null ? null : sha(expectedProductSha, 'candidate-product-sha-invalid');
  const normalizedReport = validateOracleReport(report);
  if (normalizedReport.candidateTreeSha !== tree) fail('candidate-tree-report-identity-mismatch');
  if (normalizedReport.baseSha !== base) fail('candidate-tree-report-base-mismatch');
  if (product != null && normalizedReport.productSha !== product) fail('candidate-tree-report-product-mismatch');
  assertReleaseReady(normalizedReport, {
    expectedBaseSha: base,
    expectedCandidateTreeSha: tree,
    requireCandidateTree: true,
  });
  return Object.freeze({ valid: true, candidateTreeSha: tree, baseSha: base });
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    args[key] = argv[index + 1]?.startsWith('--') ? true : argv[++index];
  }
  return args;
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === self) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (!args.report || !args.expectedHead || !args.expectedBase) fail('release-report-head-base-required');
    const report = JSON.parse(fs.readFileSync(path.resolve(args.report), 'utf8'));
    const result = verifyExactHead({
      cwd: args.cwd ? path.resolve(args.cwd) : process.cwd(),
      report,
      expectedHead: args.expectedHead,
      expectedBase: args.expectedBase,
      expectedCandidateTree: args.candidateTree || null,
      requireCandidateTree: Boolean(args.requireCandidateTree),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error?.message || error}\n`);
    process.exitCode = 1;
  }
}
