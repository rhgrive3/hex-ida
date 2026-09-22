import assert from 'node:assert/strict';
import test from 'node:test';

import { deploymentCommit, normalizeCommit } from '../scripts/write-deployment-identity.mjs';

const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

function fakeGit({ status = '', head = HEAD, fail = false } = {}) {
  const calls = [];
  const execFileSyncImpl = (command, args) => {
    calls.push({ command, args: [...args] });
    if (fail) throw new Error('git unavailable');
    if (args[0] === 'status') return status;
    if (args[0] === 'rev-parse') return head + '\n';
    throw new Error('unexpected git call');
  };
  return { calls, execFileSyncImpl };
}

test('#9449 clean checkout accepts matching Workers CI commit', () => {
  const git = fakeGit();
  assert.equal(
    deploymentCommit('/repo', { WORKERS_CI_COMMIT_SHA: HEAD }, git),
    HEAD,
  );
  assert.equal(git.calls.length, 2);
  assert.ok(git.calls[0].args.includes(':(exclude)js/userscript/deployment-identity.generated.js'));
});

test('#9449 dirty tracked or untracked state rejects matching CI commit', () => {
  for (const status of [' M worker-entry.js\n', '?? generated-input.js\n']) {
    const git = fakeGit({ status });
    assert.equal(
      deploymentCommit('/repo', { WORKERS_CI_COMMIT_SHA: HEAD }, git),
      null,
    );
    assert.equal(git.calls.length, 1, 'dirty worktree must fail before HEAD attribution');
  }
});

test('#9449 clean checkout rejects CI commit that differs from HEAD', () => {
  const git = fakeGit({ head: HEAD });
  assert.equal(
    deploymentCommit('/repo', { WORKERS_CI_COMMIT_SHA: OTHER }, git),
    null,
  );
});

test('#9449 absent or invalid CI commit keeps clean HEAD fallback', () => {
  const absent = fakeGit();
  assert.equal(deploymentCommit('/repo', {}, absent), HEAD);

  const git = fakeGit();
  assert.equal(
    deploymentCommit('/repo', { WORKERS_CI_COMMIT_SHA: 'not-a-sha' }, git),
    HEAD,
  );
});

test('#9449 dirty checkout without CI commit remains unavailable', () => {
  const git = fakeGit({ status: ' M worker-entry.js\n' });
  assert.equal(deploymentCommit('/repo', {}, git), null);
});

test('#9449 git provenance failure fails closed even with valid CI commit', () => {
  const git = fakeGit({ fail: true });
  assert.equal(
    deploymentCommit('/repo', { WORKERS_CI_COMMIT_SHA: HEAD }, git),
    null,
  );
});

test('#9449 normalizeCommit remains syntax-only and lowercase-normalized', () => {
  assert.equal(normalizeCommit(HEAD.toUpperCase()), HEAD);
  assert.equal(normalizeCommit('xyz'), null);
});
