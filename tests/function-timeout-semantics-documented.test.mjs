import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

test('profile-fresh CLI usage documents best-effort cooperative abort semantics', () => {
  const profileFreshPath = path.join(REPO_ROOT, 'tools/validation/public-benchmark/profile-fresh.mjs');
  const res = spawnSync(process.execPath, [profileFreshPath], { encoding: 'utf8' });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /best-effort/);
  assert.match(res.stderr, /elapsed>limit marked TIMEOUT/);
});

test('docs/FUNCTION_TIMEOUT_SEMANTICS.md explicitly documents cooperative best-effort vs hard watchdog', () => {
  const docPath = path.join(REPO_ROOT, 'docs/FUNCTION_TIMEOUT_SEMANTICS.md');
  const content = fs.readFileSync(docPath, 'utf8');
  assert.match(content, /best-effort \(cooperative\)/);
  assert.match(content, /Tier 2 \(Process boundary hard watchdog\)/);
  assert.match(content, /SIGKILL/);
});

test('API JSDoc for AnalysisQueryAPI.decompile documents cooperative best-effort semantics', () => {
  const apiPath = path.join(REPO_ROOT, 'js/analysis/query/api.js');
  const content = fs.readFileSync(apiPath, 'utf8');
  assert.match(content, /cooperative \(best-effort\)/);
  assert.match(content, /decompilerTimeBudgetMs/);
});
