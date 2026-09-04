#!/usr/bin/env node

import fs from 'node:fs/promises';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const API_VERSION = '2022-11-28';
const CODERABBIT_RE = /^coderabbitai(?:\[bot\])?$/i;
const HARD_FAILURES = new Set(['failure', 'timed_out', 'action_required', 'startup_failure']);

function currentDateInZone(timeZone, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function parseArgs(argv) {
  const args = {
    date: null,
    repo: process.env.GITHUB_REPOSITORY || null,
    output: 'artifacts/merged-pr-review-audit.json',
    markdown: 'artifacts/merged-pr-review-audit.md',
    timeZone: 'Asia/Tokyo',
    offset: '+09:00',
    strict: false,
    concurrency: 6,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const value = argv[i + 1];
    switch (token) {
      case '--date': args.date = value; i += 1; break;
      case '--repo': args.repo = value; i += 1; break;
      case '--output': args.output = value; i += 1; break;
      case '--markdown': args.markdown = value; i += 1; break;
      case '--timezone': args.timeZone = value; i += 1; break;
      case '--offset': args.offset = value; i += 1; break;
      case '--concurrency': args.concurrency = Number(value); i += 1; break;
      case '--strict': args.strict = true; break;
      default: throw new Error(`unknown-argument:${token}`);
    }
  }
  args.date ||= currentDateInZone(args.timeZone);
  if (!args.repo || !/^[-\w.]+\/[-\w.]+$/.test(args.repo)) throw new Error('repository-required');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.date)) throw new Error(`invalid-date:${args.date}`);
  if (!/^[+-]\d{2}:\d{2}$/.test(args.offset)) throw new Error(`invalid-offset:${args.offset}`);
  if (!Number.isInteger(args.concurrency) || args.concurrency < 1 || args.concurrency > 12) {
    throw new Error(`invalid-concurrency:${args.concurrency}`);
  }
  return args;
}

function dateWindow(date, offset, now = new Date()) {
  const start = new Date(`${date}T00:00:00${offset}`);
  const next = new Date(start.getTime() + 86_400_000);
  if (Number.isNaN(start.getTime())) throw new Error(`invalid-window:${date}:${offset}`);
  if (now < start) throw new Error(`audit-date-is-in-the-future:${date}`);
  return { start, end: now < next ? now : next };
}

function atOrBefore(value, boundary) {
  if (!value) return false;
  const time = new Date(value).getTime();
  return Number.isFinite(time) && time <= boundary.getTime();
}

function after(value, boundary) {
  if (!value) return false;
  const time = new Date(value).getTime();
  return Number.isFinite(time) && time > boundary.getTime();
}

function isCodeRabbit(login) {
  return CODERABBIT_RE.test(String(login || ''));
}

function normalizeCheck(node) {
  if (node?.__typename === 'CheckRun') {
    return {
      name: node.name || 'unnamed-check',
      status: String(node.status || '').toLowerCase(),
      conclusion: String(node.conclusion || '').toLowerCase() || null,
      startedAt: node.startedAt || null,
      completedAt: node.completedAt || null,
      url: node.detailsUrl || null,
    };
  }
  if (node?.__typename === 'StatusContext') {
    return {
      name: node.context || 'unnamed-status',
      status: String(node.state || '').toLowerCase(),
      conclusion: String(node.state || '').toLowerCase() || null,
      startedAt: node.createdAt || null,
      completedAt: node.createdAt || null,
      url: node.targetUrl || null,
    };
  }
  return null;
}

function latestReviewStateByAuthor(reviews, mergedAt) {
  const latest = new Map();
  for (const review of reviews) {
    if (!atOrBefore(review.submittedAt, mergedAt)) continue;
    const login = String(review.author?.login || '').toLowerCase();
    if (!login) continue;
    const previous = latest.get(login);
    if (!previous || new Date(previous.submittedAt) < new Date(review.submittedAt)) latest.set(login, review);
  }
  return latest;
}

export function classifyPullRequest(pr, workflowRuns = []) {
  const mergedAt = new Date(pr.mergedAt);
  if (Number.isNaN(mergedAt.getTime())) throw new Error(`pr-${pr.number}-missing-merged-at`);
  const reviews = Array.isArray(pr.reviews) ? pr.reviews : [];
  const threads = Array.isArray(pr.reviewThreads) ? pr.reviewThreads : [];
  const comments = Array.isArray(pr.comments) ? pr.comments : [];
  const checks = (pr.checkContexts || []).map(normalizeCheck).filter(Boolean);
  const findings = [];

  const unresolvedThreads = threads.filter((thread) => !thread.isResolved);
  const unresolvedAtMerge = unresolvedThreads.filter((thread) =>
    (thread.comments || []).some((comment) => atOrBefore(comment.createdAt, mergedAt)),
  );
  if (unresolvedAtMerge.length) {
    findings.push({
      code: 'UNRESOLVED_REVIEW_THREAD_AT_MERGE',
      severity: 'blocking',
      count: unresolvedAtMerge.length,
      urls: unresolvedAtMerge.flatMap((thread) => (thread.comments || []).map((comment) => comment.url)).filter(Boolean),
    });
  }

  const outstandingChangesRequested = [...latestReviewStateByAuthor(reviews, mergedAt).values()].filter(
    (review) => String(review.state).toUpperCase() === 'CHANGES_REQUESTED',
  );
  if (outstandingChangesRequested.length) {
    findings.push({
      code: 'OUTSTANDING_CHANGES_REQUESTED_AT_MERGE',
      severity: 'blocking',
      reviewers: outstandingChangesRequested.map((review) => review.author?.login).filter(Boolean),
      urls: outstandingChangesRequested.map((review) => review.url).filter(Boolean),
    });
  }

  const reviewRequests = comments.filter((comment) =>
    atOrBefore(comment.createdAt, mergedAt) && /@coderabbitai\s+review\b/i.test(comment.body || ''),
  );
  const latestReviewRequest = reviewRequests.at(-1) || null;
  const codeRabbitReviews = reviews.filter((review) => isCodeRabbit(review.author?.login));
  const freshCodeRabbitReview = codeRabbitReviews.some((review) =>
    atOrBefore(review.submittedAt, mergedAt) && review.commit?.oid === pr.headRefOid,
  );
  const codeRabbitClosedFailure = comments.find((comment) =>
    isCodeRabbit(comment.author?.login) &&
    /review failed/i.test(comment.body || '') &&
    /pull request is closed/i.test(comment.body || ''),
  );
  if (latestReviewRequest && !freshCodeRabbitReview) {
    findings.push({
      code: 'REVIEW_REQUESTED_BUT_NOT_COMPLETED_BEFORE_MERGE',
      severity: 'blocking',
      requestedAt: latestReviewRequest.createdAt,
      requestUrl: latestReviewRequest.url || null,
      failureUrl: codeRabbitClosedFailure?.url || null,
    });
  } else if (codeRabbitClosedFailure && !freshCodeRabbitReview) {
    findings.push({
      code: 'CODERABBIT_REVIEW_ABORTED_BY_MERGE',
      severity: 'high',
      failureUrl: codeRabbitClosedFailure.url || null,
    });
  }

  const completedReviews = reviews.filter((review) => atOrBefore(review.submittedAt, mergedAt));
  const finalHeadReviews = completedReviews.filter((review) => review.commit?.oid === pr.headRefOid);
  if (!completedReviews.length) findings.push({ code: 'NO_COMPLETED_REVIEW_BEFORE_MERGE', severity: 'risk' });
  else if (!finalHeadReviews.length) findings.push({ code: 'NO_REVIEW_ON_FINAL_HEAD', severity: 'high' });

  const contextsBeforeMerge = checks.filter((check) => atOrBefore(check.completedAt, mergedAt));
  const successfulChecksBeforeMerge = contextsBeforeMerge.filter((check) => check.conclusion === 'success');
  const failedChecksBeforeMerge = contextsBeforeMerge.filter((check) => HARD_FAILURES.has(check.conclusion));
  const unfinishedChecksAtMerge = checks.filter((check) =>
    atOrBefore(check.startedAt, mergedAt) && (!check.completedAt || after(check.completedAt, mergedAt)),
  );
  const workflowRunsBeforeMerge = workflowRuns.filter((run) => atOrBefore(run.updated_at || run.created_at, mergedAt));
  const successfulRunsBeforeMerge = workflowRunsBeforeMerge.filter((run) => run.conclusion === 'success');
  const failedRunsBeforeMerge = workflowRunsBeforeMerge.filter((run) => HARD_FAILURES.has(run.conclusion));
  const unfinishedRunsAtMerge = workflowRuns.filter((run) =>
    atOrBefore(run.created_at, mergedAt) && (!run.updated_at || after(run.updated_at, mergedAt) || !run.conclusion),
  );
  if (failedChecksBeforeMerge.length || failedRunsBeforeMerge.length) {
    findings.push({
      code: 'FAILED_EXACT_HEAD_CHECK_AT_MERGE',
      severity: 'blocking',
      checks: [...failedChecksBeforeMerge.map((check) => check.name), ...failedRunsBeforeMerge.map((run) => run.name)],
    });
  }
  if (unfinishedChecksAtMerge.length || unfinishedRunsAtMerge.length) {
    findings.push({
      code: 'CHECKS_STILL_RUNNING_AT_MERGE',
      severity: 'high',
      checks: [...unfinishedChecksAtMerge.map((check) => check.name), ...unfinishedRunsAtMerge.map((run) => run.name)],
    });
  }
  if (!successfulChecksBeforeMerge.length && !successfulRunsBeforeMerge.length) {
    findings.push({ code: 'NO_SUCCESSFUL_EXACT_HEAD_CHECK_BEFORE_MERGE', severity: 'high' });
  }

  const body = String(pr.body || '');
  const explicitGate = /(do not merge|merge only after|no merge until|マージ(?:は|を)?(?:待|禁止)|まだマージ)/i.test(body);
  if (explicitGate && (
    !successfulChecksBeforeMerge.length ||
    unfinishedChecksAtMerge.length ||
    (!freshCodeRabbitReview && /review/i.test(body))
  )) findings.push({ code: 'PR_BODY_MERGE_GATE_NOT_PROVEN', severity: 'high' });

  const changedTestFiles = (pr.files || []).filter((file) => /(^|\/)tests?\//.test(file.filename || file.path || ''));
  if (changedTestFiles.length && !successfulChecksBeforeMerge.length && !successfulRunsBeforeMerge.length) {
    findings.push({
      code: 'TEST_CHANGE_WITHOUT_PREMERGE_SUCCESS',
      severity: 'high',
      files: changedTestFiles.map((file) => file.filename || file.path),
    });
  }

  const blocking = findings.filter((finding) => finding.severity === 'blocking');
  const high = findings.filter((finding) => finding.severity === 'high');
  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    author: pr.author?.login || null,
    mergedAt: pr.mergedAt,
    headRefOid: pr.headRefOid,
    mergeCommitOid: pr.mergeCommit?.oid || null,
    additions: pr.additions ?? null,
    deletions: pr.deletions ?? null,
    changedFiles: pr.changedFiles ?? (pr.files || []).length,
    reviewSummary: {
      completedBeforeMerge: completedReviews.length,
      finalHeadBeforeMerge: finalHeadReviews.length,
      unresolvedAtAudit: unresolvedThreads.length,
      unresolvedAtMerge: unresolvedAtMerge.length,
      codeRabbitRequestedAt: latestReviewRequest?.createdAt || null,
      codeRabbitFreshBeforeMerge: freshCodeRabbitReview,
      codeRabbitClosedFailure: Boolean(codeRabbitClosedFailure),
    },
    checkSummary: {
      contexts: checks.length,
      successfulBeforeMerge: successfulChecksBeforeMerge.length,
      failedBeforeMerge: failedChecksBeforeMerge.length,
      unfinishedAtMerge: unfinishedChecksAtMerge.length,
      workflowRuns: workflowRuns.length,
      successfulRunsBeforeMerge: successfulRunsBeforeMerge.length,
      failedRunsBeforeMerge: failedRunsBeforeMerge.length,
      unfinishedRunsAtMerge: unfinishedRunsAtMerge.length,
    },
    findings,
    verdict: blocking.length ? 'BLOCKING' : high.length ? 'REQUIRES_REVIEW' : findings.length ? 'RISK' : 'CLEAN',
  };
}

class GitHubClient {
  constructor(token, repo) {
    if (!token) throw new Error('GITHUB_TOKEN-required');
    this.token = token;
    this.repo = repo;
    [this.owner, this.name] = repo.split('/');
  }

  async request(url, options = {}, attempt = 0) {
    const response = await fetch(url, {
      ...options,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${this.token}`,
        'x-github-api-version': API_VERSION,
        'user-agent': 'hex-merged-pr-review-audit',
        ...(options.headers || {}),
      },
    });
    if ((response.status === 403 || response.status === 429 || response.status >= 500) && attempt < 4) {
      const retryAfter = Number(response.headers.get('retry-after')) * 1000;
      const resetAt = Number(response.headers.get('x-ratelimit-reset')) * 1000;
      const delay = retryAfter > 0
        ? retryAfter
        : resetAt > Date.now()
          ? Math.min(resetAt - Date.now() + 1000, 60_000)
          : 2 ** attempt * 1000;
      await new Promise((resolve) => setTimeout(resolve, delay));
      return this.request(url, options, attempt + 1);
    }
    const text = await response.text();
    let payload = null;
    if (text) {
      try { payload = JSON.parse(text); } catch { payload = text; }
    }
    if (!response.ok) {
      throw new Error(`github-api:${response.status}:${url}:${JSON.stringify(payload).slice(0, 500)}`);
    }
    return payload;
  }

  async paginate(url, arrayKey = null) {
    const items = [];
    for (let page = 1; ; page += 1) {
      const separator = url.includes('?') ? '&' : '?';
      const payload = await this.request(`${url}${separator}per_page=100&page=${page}`);
      const batch = arrayKey ? payload[arrayKey] : (Array.isArray(payload) ? payload : payload.items);
      if (!Array.isArray(batch)) throw new Error(`pagination-shape:${url}`);
      items.push(...batch);
      if (batch.length < 100) return items;
    }
  }

  async searchMerged(start, end) {
    const from = start.toISOString().slice(0, 10);
    const to = new Date(end.getTime() - 1).toISOString().slice(0, 10);
    const query = encodeURIComponent(`repo:${this.repo} is:pr is:merged merged:${from}..${to}`);
    const items = await this.paginate(`https://api.github.com/search/issues?q=${query}`);
    return items.filter((item) => {
      const mergedAt = item.pull_request?.merged_at;
      if (!mergedAt) return false;
      const timestamp = new Date(mergedAt);
      return timestamp >= start && timestamp < end;
    });
  }

  pullRequest(number) {
    return this.request(`https://api.github.com/repos/${this.repo}/pulls/${number}`);
  }

  pullFiles(number) {
    return this.paginate(`https://api.github.com/repos/${this.repo}/pulls/${number}/files`);
  }

  async workflowRuns(headSha) {
    const params = new URLSearchParams({ head_sha: headSha, event: 'pull_request', per_page: '100' });
    const payload = await this.request(`https://api.github.com/repos/${this.repo}/actions/runs?${params}`);
    return payload.workflow_runs || [];
  }

  async graphQL(query, variables) {
    const payload = await this.request('https://api.github.com/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    if (payload.errors?.length) throw new Error(`github-graphql:${JSON.stringify(payload.errors)}`);
    return payload.data;
  }

  async reviewData(number) {
    const query = `
      query ReviewAudit($owner: String!, $name: String!, $number: Int!) {
        repository(owner: $owner, name: $name) {
          pullRequest(number: $number) {
            reviews(first: 100) {
              nodes { author { login } body state submittedAt url commit { oid } }
              pageInfo { hasNextPage }
            }
            reviewThreads(first: 100) {
              nodes {
                isResolved isOutdated path line
                comments(first: 100) {
                  nodes { author { login } body createdAt updatedAt url commit { oid } }
                  pageInfo { hasNextPage }
                }
              }
              pageInfo { hasNextPage }
            }
            comments(first: 100) {
              nodes { author { login } body createdAt updatedAt url }
              pageInfo { hasNextPage }
            }
            commits(last: 1) {
              nodes {
                commit {
                  statusCheckRollup {
                    contexts(first: 100) {
                      nodes {
                        __typename
                        ... on CheckRun { name status conclusion startedAt completedAt detailsUrl }
                        ... on StatusContext { context state createdAt targetUrl }
                      }
                      pageInfo { hasNextPage }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;
    const data = await this.graphQL(query, { owner: this.owner, name: this.name, number });
    const pr = data.repository?.pullRequest;
    if (!pr) throw new Error(`pr-not-found:${number}`);
    const truncated = [];
    if (pr.reviews.pageInfo.hasNextPage) truncated.push('reviews');
    if (pr.reviewThreads.pageInfo.hasNextPage) truncated.push('reviewThreads');
    if (pr.comments.pageInfo.hasNextPage) truncated.push('comments');
    if (pr.commits.nodes[0]?.commit?.statusCheckRollup?.contexts?.pageInfo?.hasNextPage) truncated.push('checks');
    for (const [index, thread] of pr.reviewThreads.nodes.entries()) {
      if (thread.comments.pageInfo.hasNextPage) truncated.push(`reviewThread-${index}-comments`);
    }
    if (truncated.length) throw new Error(`pr-${number}-pagination-required:${truncated.join(',')}`);
    return {
      reviews: pr.reviews.nodes,
      reviewThreads: pr.reviewThreads.nodes.map((thread) => ({ ...thread, comments: thread.comments.nodes })),
      comments: pr.comments.nodes,
      checkContexts: pr.commits.nodes[0]?.commit?.statusCheckRollup?.contexts?.nodes || [],
    };
  }
}

async function mapConcurrent(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function lane() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, lane));
  return results;
}

function markdown(report) {
  const lines = [
    `# Merged PR review audit — ${report.window.localDate} (${report.window.timeZone})`,
    '',
    `- Repository: \`${report.repository}\``,
    `- UTC window: \`${report.window.start}\` → \`${report.window.end}\``,
    `- Audited merged PRs: **${report.summary.total}**`,
    `- Blocking: **${report.summary.blocking}**`,
    `- Requires review: **${report.summary.requiresReview}**`,
    `- Risk-only: **${report.summary.risk}**`,
    `- Clean: **${report.summary.clean}**`,
    '',
    '## Finding counts',
    '',
    '| Finding | Count |',
    '|---|---:|',
  ];
  for (const [code, count] of Object.entries(report.summary.findingCounts).sort((a, b) => b[1] - a[1])) {
    lines.push(`| \`${code}\` | ${count} |`);
  }
  lines.push('', '## PR verdicts', '', '| PR | Verdict | Merged (UTC) | Findings |', '|---:|---|---|---|');
  for (const pr of report.pullRequests) {
    lines.push(`| [#${pr.number}](${pr.url}) | ${pr.verdict} | ${pr.mergedAt} | ${pr.findings.map((item) => item.code).join(', ') || '—'} |`);
  }
  lines.push('', '## Interpretation', '');
  lines.push('- GitHub review/thread/check identities and timestamps are authoritative for this report.');
  lines.push('- PR prose and bot summaries are not accepted as implementation proof.');
  lines.push('- Historical violations require independent code review, integrated regression proof, and a prevention gate; the merge event itself cannot be undone.');
  return `${lines.join('\n')}\n`;
}

async function ensureParent(file) {
  const slash = file.lastIndexOf('/');
  if (slash > 0) await fs.mkdir(file.slice(0, slash), { recursive: true });
}

export async function runAudit(args, { now = new Date(), token = process.env.GITHUB_TOKEN } = {}) {
  const window = dateWindow(args.date, args.offset, now);
  const client = new GitHubClient(token, args.repo);
  const candidates = await client.searchMerged(window.start, window.end);
  const raw = await mapConcurrent(candidates, args.concurrency, async (candidate) => {
    const details = await client.pullRequest(candidate.number);
    const [reviewData, workflowRuns, files] = await Promise.all([
      client.reviewData(candidate.number),
      client.workflowRuns(details.head.sha),
      client.pullFiles(candidate.number),
    ]);
    return {
      ...reviewData,
      files,
      number: details.number,
      title: details.title,
      url: details.html_url,
      body: details.body || '',
      author: details.user,
      mergedAt: details.merged_at,
      headRefOid: details.head.sha,
      mergeCommit: details.merge_commit_sha ? { oid: details.merge_commit_sha } : null,
      additions: details.additions,
      deletions: details.deletions,
      changedFiles: details.changed_files,
      workflowRuns,
    };
  });
  raw.sort((a, b) => new Date(a.mergedAt) - new Date(b.mergedAt));
  const pullRequests = raw.map((pr) => classifyPullRequest(pr, pr.workflowRuns));
  const findingCounts = {};
  for (const pr of pullRequests) {
    for (const finding of pr.findings) findingCounts[finding.code] = (findingCounts[finding.code] || 0) + 1;
  }
  const report = {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    repository: args.repo,
    window: {
      localDate: args.date,
      timeZone: args.timeZone,
      offset: args.offset,
      start: window.start.toISOString(),
      end: window.end.toISOString(),
    },
    summary: {
      total: pullRequests.length,
      blocking: pullRequests.filter((pr) => pr.verdict === 'BLOCKING').length,
      requiresReview: pullRequests.filter((pr) => pr.verdict === 'REQUIRES_REVIEW').length,
      risk: pullRequests.filter((pr) => pr.verdict === 'RISK').length,
      clean: pullRequests.filter((pr) => pr.verdict === 'CLEAN').length,
      findingCounts,
    },
    pullRequests,
  };
  await ensureParent(args.output);
  await ensureParent(args.markdown);
  await fs.writeFile(args.output, `${JSON.stringify(report, null, 2)}\n`);
  await fs.writeFile(args.markdown, markdown(report));
  return report;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = await runAudit(args);
  console.log(JSON.stringify(report.summary, null, 2));
  if (args.strict && report.summary.blocking > 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
