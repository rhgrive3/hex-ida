import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadManifest, regexFor } from '../../../tools/validation/phase7-ownership.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const C1_01_ALLOWED_PATHS = Object.freeze([
  '.specify/memory/constitution.md',
  'docs/analysis-improvement-finding-ledger.md',
  'specs/001-loaded-pointer-recovery/**',
  'js/analysis/pointsto/local.js',
  'js/analysis/alias/solver.js',
  'js/analysis/index.js',
  'js/semantics/compat/index.js',
  'tests/phase7/pointsto/loaded-pointer-recovery.test.mjs',
  'tests/phase7/ownership/c1-01-inventory.test.mjs',
  'userscript/hex.user.template.js',
  'userscript/release-version.json',
]);

function lines(command, args) {
  return execFileSync(command, args, { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

export function validateC101Inventory(files, manifest = loadManifest()) {
  const allowed = C1_01_ALLOWED_PATHS.map(regexFor);
  const forbidden = manifest.forbiddenPaths.map((pattern) => [pattern, regexFor(pattern)]);
  const violations = [];

  for (const file of Array.from(new Set(files)).sort()) {
    const forbiddenPattern = forbidden.find(([, matcher]) => matcher.test(file))?.[0];
    if (forbiddenPattern) {
      violations.push({ file, category: 'forbidden', pattern: forbiddenPattern });
      continue;
    }
    if (!allowed.some((matcher) => matcher.test(file))) {
      violations.push({ file, category: 'outside-c1-01-allowlist' });
    }
  }

  return violations;
}

function currentC101Inventory() {
  const base = process.env.HEX_C101_BASE_SHA
    ?? lines('git', ['merge-base', 'origin/main', 'HEAD'])[0];
  assert.ok(base, 'C1-01 ownership validation requires a current-main merge base');
  return Array.from(new Set([
    ...lines('git', ['diff', '--name-only', '--diff-filter=ACMRTUXB', base, '--']),
    ...lines('git', ['ls-files', '--others', '--exclude-standard']),
  ])).sort();
}

test('HEX-C1-01 planned inventory is accepted without widening Phase 7 ownership', () => {
  const planned = [
    '.specify/memory/constitution.md',
    'docs/analysis-improvement-finding-ledger.md',
    'specs/001-loaded-pointer-recovery/spec.md',
    'js/analysis/pointsto/local.js',
    'js/analysis/alias/solver.js',
    'js/analysis/index.js',
    'js/semantics/compat/index.js',
    'tests/phase7/pointsto/loaded-pointer-recovery.test.mjs',
    'tests/phase7/ownership/c1-01-inventory.test.mjs',
    'userscript/hex.user.template.js',
    'userscript/release-version.json',
  ];
  assert.deepEqual(validateC101Inventory(planned), []);
});

test('HEX-C1-01 inventory rejects frozen contracts and unrelated paths', () => {
  assert.deepEqual(validateC101Inventory([
    'js/semantics/memoryssa/build.js',
    'tests/issues/unrelated-fix.test.mjs',
  ]), [
    { file: 'js/semantics/memoryssa/build.js', category: 'forbidden', pattern: 'js/semantics/memoryssa/**' },
    { file: 'tests/issues/unrelated-fix.test.mjs', category: 'outside-c1-01-allowlist' },
  ]);
});

test('the actual HEX-C1-01 branch inventory stays inside its exact allowlist', () => {
  assert.deepEqual(validateC101Inventory(currentC101Inventory()), []);
});
