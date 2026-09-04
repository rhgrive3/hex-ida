#!/usr/bin/env node

import { execFileSync } from 'node:child_process';

export const X03_BASE_SHA = '60980a3c9312b1dda7619d5e88b4a97df1016276';

const ALLOWED = Object.freeze([
  /^js\/analysis\/discovery\//,
  /^js\/analysis\/index\.js$/,
  /^js\/ai\/tools\/registry-base\.js$/,
  /^js\/rebuild\/format-safe\.js$/,
  /^js\/rebuild\/transaction-v2\.js$/,
  /^tests\/phase7\/discovery\//,
  /^tests\/stage2\/rebuild-transaction\.test\.mjs$/,
  /^tools\/validation\/discovery\//,
  /^specs\/004-discovery-ambiguity-matrix\//,
  /^docs\/analysis-improvement-finding-ledger\.md$/,
]);

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}
function changedFiles(base = X03_BASE_SHA) {
  const tracked = git(['diff', '--name-only', `${base}...HEAD`]).split('\n').filter(Boolean);
  const working = git(['diff', '--name-only']).split('\n').filter(Boolean);
  const staged = git(['diff', '--cached', '--name-only']).split('\n').filter(Boolean);
  const untracked = git(['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean);
  return [...new Set([...tracked, ...working, ...staged, ...untracked])].sort();
}

function ledgerIsOwnerClean(base) {
  const path = 'docs/analysis-improvement-finding-ledger.md';
  const before = execFileSync('git', ['show', `${base}:${path}`], { encoding: 'utf8' });
  const after = execFileSync('git', ['show', `HEAD:${path}`], { encoding: 'utf8' });
  const withoutX03 = (text) => text.split('\n').filter((line) => !line.startsWith('| HEX-X-03 |')).join('\n');
  return withoutX03(before) === withoutX03(after);
}

export function verifyX03Ownership(base = X03_BASE_SHA) {
  const files = changedFiles(base);
  const outside = files.filter((file) => !ALLOWED.some((pattern) => pattern.test(file)));
  const ledgerChanged = files.includes('docs/analysis-improvement-finding-ledger.md');
  const ledgerClean = !ledgerChanged || ledgerIsOwnerClean(base);
  return Object.freeze({ base, files, outside, ledgerClean, ok: outside.length === 0 && ledgerClean });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = verifyX03Ownership(process.argv[2] || X03_BASE_SHA);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}
