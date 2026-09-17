import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const cli = resolve(root, 'scripts/fetch-real-fixtures.mjs');

function run(...args) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env },
  });
}

test('#9143 all + unknown fixture fails on the unknown selector before checking every fixture', () => {
  const unknown = '__issue_9143_unknown_fixture__';
  const result = run('--check', 'all', unknown);
  assert.equal(result.status, 1);
  assert.match(result.stderr, new RegExp(`^unknown fixture: ${unknown.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}`, 'm'));
  assert.doesNotMatch(result.stderr, /fixture is missing at .*tests[\\/]+\.real-fixtures/,
    'the typo must be rejected before the all-fixture check widens the operation');
});

test('#9143 unknown fixture remains fail-closed without all', () => {
  const unknown = '__issue_9143_unknown_fixture_alone__';
  const result = run('--check', unknown);
  assert.equal(result.status, 1);
  assert.match(result.stderr, new RegExp(`^unknown fixture: ${unknown.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}`, 'm'));
});
