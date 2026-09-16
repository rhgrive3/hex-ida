import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverRootIssueRegressions, ROOT_ISSUE_EXCLUSIONS } from './root-issue-regressions.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('root issue regressions have total canonical membership', () => {
  const inventory = discoverRootIssueRegressions();
  assert.ok(inventory.all.includes('issue-8629-sandbox-source-mode-boundary.test.mjs'));
  assert.ok(inventory.executed.includes('issue-8629-sandbox-source-mode-boundary.test.mjs'));
  assert.equal(inventory.all.length, inventory.executed.length + inventory.excluded.length);
  assert.equal(new Set([...inventory.executed, ...inventory.excluded]).size, inventory.all.length);
  assert.deepEqual(Object.keys(ROOT_ISSUE_EXCLUSIONS), inventory.excluded);
  const packageJson = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));
  for (const name of inventory.excluded) {
    const record = ROOT_ISSUE_EXCLUSIONS[name];
    assert.equal(typeof record.script, 'string');
    assert.equal(typeof packageJson.scripts[record.script], 'string');
    assert.ok(packageJson.scripts[record.script].includes(name), `${name} must be present in ${record.script}`);
  }
});

test('required test script routes through the canonical root issue runner', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));
  assert.match(packageJson.scripts.test, /npm run root-issue-regressions:test/);
  assert.match(packageJson.scripts['root-issue-regressions:test'], /node tests\/root-issue-regressions\.mjs/);
});
