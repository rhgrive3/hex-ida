import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const CONFIG_PATH = '.circleci/config.yml';
const config = readFileSync(CONFIG_PATH, 'utf8');
const lines = config.split('\n');
const CHECKOUT_JOBS = [
  'migration-guardrails',
  'agent-loop-resilience',
  'issue-2528-canonical-claims',
  'ai-eval-contract',
  'phase7-ownership',
  'phase8-ownership',
];
const CHECKOUT_COMMAND = 'configure-public-repository-checkout';
const EXPECTED_REWRITE = 'git config --global url."https://github.com/rhgrive3/hex-ida.git".insteadOf "git@github.com:rhgrive3/hex-ida.git"';

function jobBlock(name) {
  const start = lines.indexOf(`  ${name}:`);
  assert.notEqual(start, -1, `CircleCI job exists: ${name}`);
  const end = lines.findIndex((line, index) => index > start && (/^  [^ ]/.test(line) || line === 'workflows:'));
  return lines.slice(start, end === -1 ? lines.length : end);
}

function jobNames() {
  const jobsStart = lines.indexOf('jobs:');
  const workflowsStart = lines.indexOf('workflows:');
  return lines
    .slice(jobsStart + 1, workflowsStart === -1 ? lines.length : workflowsStart)
    .flatMap((line) => line.match(/^  ([^ ][^:]*):$/)?.[1] ?? []);
}

test('every CircleCI checkout uses the public HTTPS pre-checkout command', () => {
  const actualCheckoutJobs = jobNames().filter((job) => jobBlock(job).some((line) => line.trim() === '- checkout'));
  assert.deepEqual(actualCheckoutJobs, CHECKOUT_JOBS, 'the checkout-job inventory remains explicit');
  for (const job of CHECKOUT_JOBS) {
    const block = jobBlock(job);
    const checkoutIndex = block.findIndex((line) => line.trim() === '- checkout');
    assert.notEqual(checkoutIndex, -1, `${job} retains CircleCI built-in checkout`);
    assert.equal(
      block[checkoutIndex - 1]?.trim(),
      `- ${CHECKOUT_COMMAND}`,
      `${job} configures the transport immediately before checkout`,
    );
  }
});

test('checkout transport mapping is exact and narrowly scoped to this public repository', () => {
  const commandLines = lines
    .map((line) => line.trim())
    .filter((line) => line.startsWith('git config --global url.'));
  assert.deepEqual(commandLines, [EXPECTED_REWRITE]);
  assert.match(config, /configure-public-repository-checkout:\n/);
  assert.match(config, /set -euo pipefail/);
  assert.doesNotMatch(config, /insteadOf\s+["']git@github\.com["']/);
  assert.doesNotMatch(config, /insteadOf\s+["']ssh:\/\/git@github\.com["']/);

  const tempHome = mkdtempSync(join(tmpdir(), 'hex-circleci-checkout-policy-'));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: join(tempHome, 'gitconfig') };
  try {
    const setup = spawnSync('bash', ['-euo', 'pipefail', '-c', commandLines[0]], { env, encoding: 'utf8' });
    assert.equal(setup.status, 0, setup.stderr);
    const target = spawnSync('git', ['ls-remote', '--get-url', 'git@github.com:rhgrive3/hex-ida.git'], { env, encoding: 'utf8' });
    assert.equal(target.status, 0, target.stderr);
    assert.equal(target.stdout.trim(), 'https://github.com/rhgrive3/hex-ida.git');
    const unrelated = spawnSync('git', ['ls-remote', '--get-url', 'git@github.com:other/repository.git'], { env, encoding: 'utf8' });
    assert.equal(unrelated.status, 0, unrelated.stderr);
    assert.equal(unrelated.stdout.trim(), 'git@github.com:other/repository.git');
  } finally {
    rmSync(tempHome, { recursive: true, force: true });
  }
});

console.log('CircleCI public checkout policy: PASS');
