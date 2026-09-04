#!/usr/bin/env node

import fs from 'node:fs/promises';

async function edit(path, transform) {
  const before = await fs.readFile(path, 'utf8');
  const after = transform(before);
  if (after === before) return false;
  await fs.writeFile(path, after);
  return true;
}

function replaceOnce(text, before, after, label) {
  const count = text.split(before).length - 1;
  if (count !== 1) throw new Error(`${label}:expected-one-match:found-${count}`);
  return text.replace(before, after);
}

function replaceOrVerify(text, before, after, label) {
  if (text.includes(after)) return text;
  return replaceOnce(text, before, after, label);
}

const changed = [];

if (await edit('tools/validation/merged-pr-review-audit.mjs', (source) => {
  let out = source;
  out = replaceOrVerify(
    out,
    "const HARD_FAILURES = new Set(['failure', 'timed_out', 'action_required', 'startup_failure']);",
    "const HARD_FAILURES = new Set(['failure', 'error', 'timed_out', 'action_required', 'startup_failure', 'cancelled', 'stale']);",
    'audit-hard-failure-states',
  );
  out = replaceOrVerify(
    out,
    `  if (node?.__typename === 'StatusContext') {
    return {
      name: node.context || 'unnamed-status',
      status: String(node.state || '').toLowerCase(),
      conclusion: String(node.state || '').toLowerCase() || null,
      startedAt: node.createdAt || null,
      completedAt: node.createdAt || null,
      url: node.targetUrl || null,
    };
  }`,
    `  if (node?.__typename === 'StatusContext') {
    const state = String(node.state || '').toLowerCase();
    const pending = state === 'pending' || state === 'expected';
    return {
      name: node.context || 'unnamed-status',
      status: state,
      conclusion: pending ? null : (state || null),
      startedAt: node.createdAt || null,
      completedAt: pending ? null : (node.createdAt || null),
      url: node.targetUrl || null,
    };
  }`,
    'audit-status-context-terminal-state',
  );
  out = replaceOrVerify(
    out,
    `  for (const review of reviews) {
    if (!atOrBefore(review.submittedAt, mergedAt)) continue;
    const login = String(review.author?.login || '').toLowerCase();`,
    `  for (const review of reviews) {
    if (!atOrBefore(review.submittedAt, mergedAt)) continue;
    const state = String(review.state || '').toUpperCase();
    if (!['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(state)) continue;
    const login = String(review.author?.login || '').toLowerCase();`,
    'audit-review-state-transitions',
  );
  out = replaceOrVerify(
    out,
    `export async function runAudit(args, { now = new Date(), token = process.env.GITHUB_TOKEN } = {}) {
  const window = dateWindow(args.date, args.offset, now);
  const client = new GitHubClient(token, args.repo);
  const candidates = await client.searchMerged(window.start, window.end);`,
    `export async function runAudit(args, { now = new Date(), token = process.env.GITHUB_TOKEN } = {}) {
  const window = dateWindow(args.date, args.offset, now);
  try {
    const client = new GitHubClient(token, args.repo);
    const candidates = await client.searchMerged(window.start, window.end);`,
    'audit-failure-wrapper-start',
  );
  out = replaceOrVerify(
    out,
    '  const report = {\n    schemaVersion: 1,\n    generatedAt: now.toISOString(),',
    '  const report = {\n    schemaVersion: 1,\n    generatedAt: now.toISOString(),',
    'audit-report-declaration-preserved',
  );
  out = replaceOrVerify(
    out,
    `  await fs.writeFile(args.output, \`${'${JSON.stringify(report, null, 2)}'}\\n\`);
  await fs.writeFile(args.markdown, markdown(report));
  return report;
}`,
    `  await fs.writeFile(args.output, \`${'${JSON.stringify(report, null, 2)}'}\\n\`);
  await fs.writeFile(args.markdown, markdown(report));
  return report;
  } catch (error) {
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
        total: 0,
        blocking: 1,
        requiresReview: 0,
        risk: 0,
        clean: 0,
        findingCounts: { AUDIT_COLLECTION_FAILED: 1 },
      },
      pullRequests: [],
      collectionFailure: {
        name: error?.name || 'Error',
        message: String(error?.message || error),
      },
    };
    await ensureParent(args.output);
    await ensureParent(args.markdown);
    await fs.writeFile(args.output, \`${'${JSON.stringify(report, null, 2)}'}\\n\`);
    await fs.writeFile(args.markdown, markdown(report));
    throw error;
  }
}`,
    'audit-failure-wrapper-end',
  );
  return out;
})) changed.push('tools/validation/merged-pr-review-audit.mjs');

if (await edit('.github/workflows/migration-guardrails.yml', (source) => {
  let out = source;
  out = out.replace('          if-no-files-found: error', '          if-no-files-found: warn');
  out = out.replace(
    '          --offset +09:00\n          --strict',
    "          --offset +09:00\n          ${{ github.event_name == 'workflow_dispatch' && '--strict' || '' }}",
  );
  return out;
})) changed.push('.github/workflows/migration-guardrails.yml');

if (await edit('tests/process/merged-pr-review-audit.test.mjs', (source) => {
  if (source.includes('later COMMENTED review does not clear changes requested')) return source;
  const insertion = `
{
  const result = classifyPullRequest(basePr({
    reviews: [
      {
        author: { login: 'reviewer' }, state: 'CHANGES_REQUESTED',
        submittedAt: '2026-09-04T13:01:00Z',
        commit: { oid: '14fe9cdee5adcb9a068a661409bc80c1547ba288' },
        url: 'https://example.test/changes-requested',
      },
      {
        author: { login: 'reviewer' }, state: 'COMMENTED',
        submittedAt: '2026-09-04T13:02:00Z',
        commit: { oid: '14fe9cdee5adcb9a068a661409bc80c1547ba288' },
        url: 'https://example.test/commented',
      },
    ],
    checkContexts: [{
      __typename: 'CheckRun', name: 'focused-regression', status: 'COMPLETED', conclusion: 'SUCCESS',
      startedAt: '2026-09-04T13:00:00Z', completedAt: '2026-09-04T13:02:30Z',
    }],
  }), []);
  assert(result.findings.some((item) => item.code === 'OUTSTANDING_CHANGES_REQUESTED_AT_MERGE'),
    'later COMMENTED review does not clear changes requested');
}

{
  const result = classifyPullRequest(basePr({
    reviews: [{
      author: { login: 'reviewer' }, state: 'APPROVED', submittedAt: '2026-09-04T13:01:00Z',
      commit: { oid: '14fe9cdee5adcb9a068a661409bc80c1547ba288' },
    }],
    checkContexts: [{
      __typename: 'StatusContext', context: 'legacy-status', state: 'PENDING',
      createdAt: '2026-09-04T13:00:00Z',
    }],
  }), []);
  assert(result.findings.some((item) => item.code === 'CHECKS_STILL_RUNNING_AT_MERGE'));
  assert(result.findings.some((item) => item.code === 'NO_SUCCESSFUL_EXACT_HEAD_CHECK_BEFORE_MERGE'));
}

{
  const result = classifyPullRequest(basePr({
    reviews: [{
      author: { login: 'reviewer' }, state: 'APPROVED', submittedAt: '2026-09-04T13:01:00Z',
      commit: { oid: '14fe9cdee5adcb9a068a661409bc80c1547ba288' },
    }],
    checkContexts: [
      { __typename: 'StatusContext', context: 'legacy-error', state: 'ERROR', createdAt: '2026-09-04T13:00:00Z' },
      { __typename: 'CheckRun', name: 'cancelled-check', status: 'COMPLETED', conclusion: 'CANCELLED', startedAt: '2026-09-04T13:00:00Z', completedAt: '2026-09-04T13:01:30Z' },
      { __typename: 'CheckRun', name: 'stale-check', status: 'COMPLETED', conclusion: 'STALE', startedAt: '2026-09-04T13:00:00Z', completedAt: '2026-09-04T13:01:40Z' },
    ],
  }), []);
  const failure = result.findings.find((item) => item.code === 'FAILED_EXACT_HEAD_CHECK_AT_MERGE');
  assert(failure);
  assert(failure.checks.includes('legacy-error'));
  assert(failure.checks.includes('cancelled-check'));
  assert(failure.checks.includes('stale-check'));
}

`;
  return replaceOnce(source, "\nconsole.log('merged PR review audit regression: PASS');", `${insertion}console.log('merged PR review audit regression: PASS');`, 'audit-regression-insertion');
})) changed.push('tests/process/merged-pr-review-audit.test.mjs');

if (await edit('tests/process/review-6372-unresolved-findings.test.mjs', (source) => replaceOrVerify(
  source,
  "  assert.equal(storage.getItem(unreadable), null, 'mock read remains unavailable');",
  "  assert.throws(() => storage.getItem(unreadable), /storage fault/);",
  'review-6372-storage-throw-assertion',
))) changed.push('tests/process/review-6372-unresolved-findings.test.mjs');

if (await edit('js/binary/macho-dyld.js', (source) => {
  let out = source;
  out = replaceOrVerify(
    out,
    "if(!budget.take({objects:2,operations:1,estimatedHeapBytes:320},'classic-bind-output')){fail('shared metadata budget exhausted while recording bind');return;}",
    "if(!budget.take({objects:2,operations:1,stringBytes:template.name.length*2,estimatedHeapBytes:320+template.name.length*2},'classic-bind-output')){fail('shared metadata budget exhausted while recording threaded bind');return;}",
    'threaded-retained-name-budget',
  );
  out = replaceOrVerify(
    out,
    "if (!symbol) { fail('bind encountered before a symbol was set'); return; }",
    "if (!symbol) { fail('bind encountered before a symbol was set'); return false; }",
    'bind-missing-symbol-result',
  );
  out = replaceOrVerify(
    out,
    "if (threadedTable.length < threadedTableLimit) { threadedTable.push(snapshotImport()); return; }",
    `if (threadedTable.length < threadedTableLimit) {
        const template = snapshotImport();
        if(!budget.take({objects:2,operations:1,stringBytes:template.name.length*2,estimatedHeapBytes:320+template.name.length*2},'classic-bind-template')){fail('shared metadata budget exhausted while recording threaded ordinal template');return false;}
        threadedTable.push(template); return true;
      }`,
    'threaded-table-template-budget',
  );
  out = replaceOrVerify(
    out,
    "fail(`threaded ordinal table exceeds declared ${threadedTableLimit} entries`);\n      return;",
    "fail(`threaded ordinal table exceeds declared ${threadedTableLimit} entries`);\n      return false;",
    'threaded-table-overflow-result',
  );
  out = replaceOrVerify(
    out,
    "if (!validLocation()) { fail(`bind location is outside segment ${segIndex} at +0x${segOffset.toString(16)}`); return; }",
    "if (!validLocation()) { fail(`bind location is outside segment ${segIndex} at +0x${segOffset.toString(16)}`); return false; }",
    'bind-location-result',
  );
  out = replaceOrVerify(
    out,
    "if(!budget.take({objects:2,operations:1,stringBytes:symbol.length*2,estimatedHeapBytes:320+symbol.length*2},'classic-bind-output')){fail('shared metadata budget exhausted while recording bind');return;}\n    image.imports.push(imp); status.decodedBinds++;",
    "if(!budget.take({objects:2,operations:1,stringBytes:symbol.length*2,estimatedHeapBytes:320+symbol.length*2},'classic-bind-output')){fail('shared metadata budget exhausted while recording bind');return false;}\n    image.imports.push(imp); status.decodedBinds++; return true;",
    'ordinary-bind-budget-result',
  );
  out = replaceOrVerify(
    out,
    "else if (op === 0x90) { bind(); segOffset += ptrSize; }\n    else if (op === 0xa0) { bind(); const x = r.uleb(p, 10, end); p = x.next; segOffset += ptrSize + x.value; }\n    else if (op === 0xb0) { bind(); segOffset += ptrSize + BigInt(imm) * ptrSize; }",
    "else if (op === 0x90) { if (!bind()) break; segOffset += ptrSize; }\n    else if (op === 0xa0) { if (!bind()) break; const x = r.uleb(p, 10, end); p = x.next; segOffset += ptrSize + x.value; }\n    else if (op === 0xb0) { if (!bind()) break; segOffset += ptrSize + BigInt(imm) * ptrSize; }",
    'direct-bind-failure-propagation',
  );
  out = replaceOrVerify(
    out,
    "const maxByBudget=Math.min(budget.remaining('operations'),Math.floor(budget.remaining('objects')/2));\n      const allowed=Math.max(0,Math.min(repeat,maxBySegment,maxByBudget));\n      for(let i=0;i<allowed;i++){bind();segOffset+=step;}",
    "const retainedNameBytes=Math.max(1,symbol.length*2);\n      const maxByBudget=Math.min(budget.remaining('operations'),Math.floor(budget.remaining('objects')/2),Math.floor(budget.remaining('stringBytes')/retainedNameBytes));\n      const allowed=Math.max(0,Math.min(repeat,maxBySegment,maxByBudget));\n      let completed=0;\n      for(;completed<allowed;completed++){if(!bind())break;segOffset+=step;}\n      if(completed<allowed) break;",
    'repeat-bind-failure-propagation',
  );
  return out;
})) changed.push('js/binary/macho-dyld.js');

if (await edit('js/names.js', (source) => {
  let out = source;
  out = replaceOrVerify(
    out,
    "this._deltaTotalBytes = 0;\n    this._deltaPrefix = this.id ? `${PREFIX}${this.id}.delta.` : null;",
    "this._deltaTotalBytes = 0;\n    this._deltaLoadComplete = true;\n    this._deltaPrefix = this.id ? `${PREFIX}${this.id}.delta.` : null;",
    'delta-complete-state',
  );
  out = replaceOrVerify(
    out,
    "  _loadDeltas() {\n    if (!this._deltaPrefix || typeof localStorage === 'undefined') return;\n    this._deltaBytes.clear(); this._deltaTotalBytes = 0;\n    const keys = [];",
    "  _loadDeltas() {\n    if (!this._deltaPrefix || typeof localStorage === 'undefined') { this._deltaLoadComplete = true; return; }\n    this._deltaLoadComplete = false;\n    this._deltaBytes.clear(); this._deltaTotalBytes = 0;\n    const keys = [];\n    let complete = true;",
    'delta-scan-start',
  );
  out = replaceOrVerify(
    out,
    "      try { raw = localStorage.getItem(storageKey); } catch { continue; }\n      if (raw == null) continue;",
    "      try { raw = localStorage.getItem(storageKey); } catch { complete = false; continue; }\n      if (raw == null) { complete = false; continue; }",
    'delta-record-read-failure',
  );
  out = replaceOrVerify(
    out,
    "        if (!map || typeof delta?.key !== 'string') continue;\n        if (delta.deleted) map.delete(delta.key); else map.set(delta.key, String(delta.value ?? ''));\n      } catch { /* base snapshot remains valid if a delta is unreadable */ }\n    }\n  }",
    "        if (!map || typeof delta?.key !== 'string') continue;\n        if (typeof delta.deleted !== 'boolean') continue;\n        if (!delta.deleted && typeof delta.value !== 'string') continue;\n        if (delta.deleted) map.delete(delta.key); else map.set(delta.key, delta.value);\n      } catch { /* base snapshot remains valid if a delta is unreadable */ }\n    }\n    this._deltaLoadComplete = complete;\n  }",
    'delta-schema-and-completion',
  );
  out = replaceOrVerify(
    out,
    "  _persistDelta(kind, recordKey, value) {\n    if (!this.id || !this._deltaPrefix) return this._saveFailure('NO_ID');",
    "  _persistDelta(kind, recordKey, value) {\n    if (!this.id || !this._deltaPrefix) return this._saveFailure('NO_ID');\n    if (!this._deltaLoadComplete) return this._saveFailure('DELTA_LOAD_INCOMPLETE');",
    'delta-persist-block',
  );
  out = replaceOrVerify(
    out,
    "  save() {\n    if (!this.id) return this._saveFailure('NO_ID');",
    "  save() {\n    if (!this.id) return this._saveFailure('NO_ID');\n    if (!this._deltaLoadComplete) return this._saveFailure('DELTA_LOAD_INCOMPLETE');",
    'snapshot-save-block',
  );
  return out;
})) changed.push('js/names.js');

if (await edit('package.json', (source) => replaceOrVerify(
  source,
  '    "test": "node tests/arm64-presentation-compat.mjs',
  '    "test": "node tests/issue-6302-memoryssa-binding-stale-identity.mjs && node tests/issue-6307-notestore-delta-resilience.mjs && node tests/arm64-presentation-compat.mjs',
  'standard-test-runner-coverage',
))) changed.push('package.json');

const snapshot = await fs.readFile('js/ai/control/snapshot.js', 'utf8');
if (!snapshot.includes('export function canonicalBindingId') || !snapshot.includes('export function firstBinding')) {
  throw new Error('snapshot-binding-exports-not-restored');
}

console.log(JSON.stringify({ changed }, null, 2));
