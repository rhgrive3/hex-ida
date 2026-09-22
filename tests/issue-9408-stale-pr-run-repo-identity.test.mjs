import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const workflow = fs.readFileSync(new URL('../.github/workflows/cancel-stale-pr-runs.yml', import.meta.url), 'utf8');

test('stale PR run fallback is repository-qualified', () => {
  assert.match(workflow, /run\.head_repository\?\.full_name/);
  assert.match(workflow, /keepHeads\.has/);
  assert.doesNotMatch(workflow, /keepBranches\.has\(branch\)/);
});

test('same branch name in a fork does not match a protected same-repository head', () => {
  const sameRepo = 'rhgrive3/hex-ida';
  const key = (repo, branch) => String(repo || '') + '\\0' + String(branch || '');
  const keepHeads = new Set([key(sameRepo, 'main'), key(sameRepo, 'fix/cache')]);
  const preserves = (run, openPrNumbers = new Set()) => {
    const branch = run.head_branch || '';
    const repo = run.head_repository?.full_name || '';
    const linkedOpenPr = (run.pull_requests || []).some((pr) => openPrNumbers.has(pr.number));
    return linkedOpenPr || Boolean(repo && keepHeads.has(key(repo, branch)));
  };

  assert.equal(preserves({
    head_branch: 'fix/cache',
    head_repository: { full_name: 'someone/hex-ida' },
    pull_requests: [{ number: 99 }],
  }, new Set([100])), false);

  assert.equal(preserves({
    head_branch: 'fix/cache',
    head_repository: { full_name: sameRepo },
    pull_requests: [],
  }), true);

  assert.equal(preserves({
    head_branch: 'anything',
    head_repository: { full_name: 'someone/hex-ida' },
    pull_requests: [{ number: 100 }],
  }, new Set([100])), true);
});
