import assert from 'node:assert/strict';
import { classifyPullRequest } from '../../tools/validation/merged-pr-review-audit.mjs';

function basePr(overrides = {}) {
  return {
    number: 6522,
    title: 'ci: bootstrap CircleCI static split',
    url: 'https://github.com/rhgrive3/hex-ida/pull/6522',
    body: '',
    author: { login: 'rhgrive3' },
    mergedAt: '2026-09-04T13:03:53Z',
    headRefOid: '14fe9cdee5adcb9a068a661409bc80c1547ba288',
    mergeCommit: { oid: '5349f58dc3a6a97d77d616d1a3bed7085ca94a01' },
    reviews: [],
    reviewThreads: [],
    comments: [],
    checkContexts: [],
    files: [],
    ...overrides,
  };
}

{
  const result = classifyPullRequest(basePr({
    comments: [
      {
        author: { login: 'rhgrive3' },
        body: '@coderabbitai review',
        createdAt: '2026-09-04T13:02:52Z',
        url: 'https://example.test/request',
      },
      {
        author: { login: 'coderabbitai[bot]' },
        body: '## Review failed\nThe pull request is closed.',
        createdAt: '2026-09-04T12:58:15Z',
        updatedAt: '2026-09-04T13:05:39Z',
        url: 'https://example.test/failure',
      },
    ],
  }), []);
  assert.equal(result.verdict, 'BLOCKING');
  assert(result.findings.some((item) => item.code === 'REVIEW_REQUESTED_BUT_NOT_COMPLETED_BEFORE_MERGE'));
}

{
  const result = classifyPullRequest(basePr({
    reviews: [{
      author: { login: 'coderabbitai[bot]' },
      state: 'COMMENTED',
      submittedAt: '2026-09-04T13:02:50Z',
      commit: { oid: '14fe9cdee5adcb9a068a661409bc80c1547ba288' },
      url: 'https://example.test/review',
    }],
    reviewThreads: [{
      isResolved: false,
      comments: [{ createdAt: '2026-09-04T13:01:00Z', url: 'https://example.test/thread' }],
    }],
  }), []);
  assert(result.findings.some((item) => item.code === 'UNRESOLVED_REVIEW_THREAD_AT_MERGE'));
}

{
  const result = classifyPullRequest(basePr({
    reviews: [{
      author: { login: 'reviewer' },
      state: 'APPROVED',
      submittedAt: '2026-09-04T13:02:00Z',
      commit: { oid: '14fe9cdee5adcb9a068a661409bc80c1547ba288' },
      url: 'https://example.test/review',
    }],
    checkContexts: [{
      __typename: 'CheckRun',
      name: 'focused-regression',
      status: 'COMPLETED',
      conclusion: 'SUCCESS',
      startedAt: '2026-09-04T13:00:00Z',
      completedAt: '2026-09-04T13:02:30Z',
    }],
  }), []);
  assert.equal(result.verdict, 'CLEAN');
  assert.equal(result.findings.length, 0);
}

{
  const result = classifyPullRequest(basePr({
    reviews: [{
      author: { login: 'reviewer' },
      state: 'CHANGES_REQUESTED',
      submittedAt: '2026-09-04T13:02:00Z',
      commit: { oid: '14fe9cdee5adcb9a068a661409bc80c1547ba288' },
      url: 'https://example.test/review',
    }],
    checkContexts: [{
      __typename: 'CheckRun',
      name: 'focused-regression',
      status: 'COMPLETED',
      conclusion: 'FAILURE',
      startedAt: '2026-09-04T13:00:00Z',
      completedAt: '2026-09-04T13:02:30Z',
    }],
  }), []);
  assert(result.findings.some((item) => item.code === 'OUTSTANDING_CHANGES_REQUESTED_AT_MERGE'));
  assert(result.findings.some((item) => item.code === 'FAILED_EXACT_HEAD_CHECK_AT_MERGE'));
}

console.log('merged PR review audit regression: PASS');
