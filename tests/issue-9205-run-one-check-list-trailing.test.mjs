import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scriptPath = path.join(root, 'scripts/run-one-check.mjs');

function runCLI(...args) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

test('#9205 run-one-check --list succeeds when invoked alone', () => {
  const result = runCLI('--list');
  assert.equal(result.status, 0);
  assert.match(result.stdout, /check\s+/);
  assert.equal(result.stderr, '');
});

test('#9205 run-one-check --list rejects trailing arguments with exit 2', () => {
  // Flag option after --list
  const typoResult = runCLI('--list', '--typo');
  assert.equal(typoResult.status, 2);
  assert.match(typoResult.stderr, /usage: node scripts\/run-one-check\.mjs/);

  // Positional token after --list
  const checkResult = runCLI('--list', 'check');
  assert.equal(checkResult.status, 2);
  assert.match(checkResult.stderr, /usage: node scripts\/run-one-check\.mjs/);

  // Multiple trailing tokens after --list
  const multiResult = runCLI('--list', 'extra1', 'extra2');
  assert.equal(multiResult.status, 2);
  assert.match(multiResult.stderr, /usage: node scripts\/run-one-check\.mjs/);
});

test('#9205 run-one-check preserves existing validation for unknown scripts and help', () => {
  // No args
  const noArgs = runCLI();
  assert.equal(noArgs.status, 2);

  // --help
  const helpResult = runCLI('--help');
  assert.equal(helpResult.status, 2);

  // Unknown script
  const unknownResult = runCLI('definitely-not-an-npm-script');
  assert.equal(unknownResult.status, 2);
  assert.match(unknownResult.stderr, /unknown npm script: definitely-not-an-npm-script/);
});
