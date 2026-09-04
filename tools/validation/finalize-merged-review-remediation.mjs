#!/usr/bin/env node

import fs from 'node:fs/promises';

async function edit(path, transform) {
  const before = await fs.readFile(path, 'utf8');
  const after = transform(before);
  if (after === before) return false;
  await fs.writeFile(path, after);
  return true;
}

function replaceExact(text, before, after, label) {
  if (text.includes(after)) return text;
  const count = text.split(before).length - 1;
  if (count !== 1) throw new Error(`${label}:expected-one-match:found-${count}`);
  return text.replace(before, after);
}

function insertBefore(text, marker, insertion, label) {
  if (text.includes(insertion.trim())) return text;
  const count = text.split(marker).length - 1;
  if (count !== 1) throw new Error(`${label}:expected-one-marker:found-${count}`);
  return text.replace(marker, `${insertion}${marker}`);
}

const changed = [];

if (await edit('tools/validation/merged-pr-review-audit.mjs', (source) => {
  let out = source;
  out = replaceExact(
    out,
    "const HARD_FAILURES = new Set(['failure', 'timed_out', 'action_required', 'startup_failure']);",
    "const HARD_FAILURES = new Set(['failure', 'error', 'timed_out', 'action_required', 'startup_failure', 'cancelled', 'stale']);",
    'audit-hard-failure-states',
  );
  out = replaceExact(
    out,
    [
      "  if (node?.__typename === 'StatusContext') {",
      '    return {',
      "      name: node.context || 'unnamed-status',",
      "      status: String(node.state || '').toLowerCase(),",
      "      conclusion: String(node.state || '').toLowerCase() || null,",
      '      startedAt: node.createdAt || null,',
      '      completedAt: node.createdAt || null,',
      '      url: node.targetUrl || null,',
      '    };',
      '  }',
    ].join('\n'),
    [
      "  if (node?.__typename === 'StatusContext') {",
      "    const state = String(node.state || '').toLowerCase();",
      "    const pending = state === 'pending' || state === 'expected';",
      '    return {',
      "      name: node.context || 'unnamed-status',",
      '      status: state,',
      '      conclusion: pending ? null : (state || null),',
      '      startedAt: node.createdAt || null,',
      '      completedAt: pending ? null : (node.createdAt || null),',
      '      url: node.targetUrl || null,',
      '    };',
      '  }',
    ].join('\n'),
    'audit-status-context',
  );
  out = replaceExact(
    out,
    [
      '  for (const review of reviews) {',
      '    if (!atOrBefore(review.submittedAt, mergedAt)) continue;',
      "    const login = String(review.author?.login || '').toLowerCase();",
    ].join('\n'),
    [
      '  for (const review of reviews) {',
      '    if (!atOrBefore(review.submittedAt, mergedAt)) continue;',
      "    const state = String(review.state || '').toUpperCase();",
      "    if (!['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(state)) continue;",
      "    const login = String(review.author?.login || '').toLowerCase();",
    ].join('\n'),
    'audit-review-state-transitions',
  );
  out = replaceExact(
    out,
    [
      'export async function runAudit(args, { now = new Date(), token = process.env.GITHUB_TOKEN } = {}) {',
      '  const window = dateWindow(args.date, args.offset, now);',
      '  const client = new GitHubClient(token, args.repo);',
      '  const candidates = await client.searchMerged(window.start, window.end);',
    ].join('\n'),
    [
      'export async function runAudit(args, { now = new Date(), token = process.env.GITHUB_TOKEN } = {}) {',
      '  const window = dateWindow(args.date, args.offset, now);',
      '  try {',
      '    const client = new GitHubClient(token, args.repo);',
      '    const candidates = await client.searchMerged(window.start, window.end);',
    ].join('\n'),
    'audit-failure-wrapper-start',
  );
  out = replaceExact(
    out,
    [
      '  await fs.writeFile(args.output, `${JSON.stringify(report, null, 2)}\\n`);',
      '  await fs.writeFile(args.markdown, markdown(report));',
      '  return report;',
      '}',
      '',
      'async function main() {',
    ].join('\n'),
    [
      '  await fs.writeFile(args.output, `${JSON.stringify(report, null, 2)}\\n`);',
      '  await fs.writeFile(args.markdown, markdown(report));',
      '  return report;',
      '  } catch (error) {',
      '    const report = {',
      '      schemaVersion: 1,',
      '      generatedAt: now.toISOString(),',
      '      repository: args.repo,',
      '      window: {',
      '        localDate: args.date,',
      '        timeZone: args.timeZone,',
      '        offset: args.offset,',
      '        start: window.start.toISOString(),',
      '        end: window.end.toISOString(),',
      '      },',
      '      summary: {',
      '        total: 0,',
      '        blocking: 1,',
      '        requiresReview: 0,',
      '        risk: 0,',
      '        clean: 0,',
      '        findingCounts: { AUDIT_COLLECTION_FAILED: 1 },',
      '      },',
      '      pullRequests: [],',
      '      collectionFailure: {',
      "        name: error?.name || 'Error',",
      '        message: String(error?.message || error),',
      '      },',
      '    };',
      '    await ensureParent(args.output);',
      '    await ensureParent(args.markdown);',
      '    await fs.writeFile(args.output, `${JSON.stringify(report, null, 2)}\\n`);',
      '    await fs.writeFile(args.markdown, markdown(report));',
      '    throw error;',
      '  }',
      '}',
      '',
      'async function main() {',
    ].join('\n'),
    'audit-failure-wrapper-end',
  );
  return out;
})) changed.push('tools/validation/merged-pr-review-audit.mjs');

if (await edit('tests/process/merged-pr-review-audit.test.mjs', (source) => {
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
  return insertBefore(source, "console.log('merged PR review audit regression: PASS');", insertion, 'audit-regressions');
})) changed.push('tests/process/merged-pr-review-audit.test.mjs');

if (await edit('tests/process/review-6372-unresolved-findings.test.mjs', (source) => {
  let out = source;
  out = replaceExact(
    out,
    "  storage.setItem(`${prefix}.delta.01-invalid-delete`, JSON.stringify({ kind:'names', key:'1', deleted:'false', value:'poison' }));",
    "  const invalidSchema = `${prefix}.delta.01-invalid-delete`;\n  storage.setItem(invalidSchema, JSON.stringify({ kind:'names', key:'1', deleted:'false', value:'poison' }));",
    'review-6372-invalid-schema-key',
  );
  out = replaceExact(
    out,
    "  assert.equal(storage.getItem(unreadable), null, 'mock read remains unavailable');",
    "  assert.throws(() => storage.getItem(unreadable), /storage fault/);",
    'review-6372-storage-throw',
  );
  out = replaceExact(
    out,
    [
      '  storage.throwKey = null;',
      '  notes._loadDeltas();',
      '  assert.equal(notes._deltaLoadComplete, true);',
      '  assert.equal(notes.save(), true);',
      '  assert.equal(storage.map.has(unreadable), false);',
    ].join('\n'),
    [
      '  storage.throwKey = null;',
      '  notes._loadDeltas();',
      "  assert.equal(notes._deltaLoadComplete, false, 'malformed stored deltas keep compaction blocked');",
      '  assert.equal(notes.save(), false);',
      "  assert.equal(notes.lastSaveError?.code, 'DELTA_LOAD_INCOMPLETE');",
      '  storage.removeItem(unreadable);',
      '  storage.removeItem(invalidSchema);',
      '  notes._loadDeltas();',
      '  assert.equal(notes._deltaLoadComplete, true);',
      '  assert.equal(notes.save(), true);',
    ].join('\n'),
    'review-6372-malformed-rescan',
  );
  return out;
})) changed.push('tests/process/review-6372-unresolved-findings.test.mjs');

if (await edit('js/binary/macho-dyld.js', (source) => {
  let out = source;
  out = replaceExact(
    out,
    "if(!budget.take({objects:2,operations:1,estimatedHeapBytes:320},'classic-bind-output')){fail('shared metadata budget exhausted while recording bind');return;}",
    "if(!budget.take({objects:2,operations:1,stringBytes:template.name.length*2,estimatedHeapBytes:320+template.name.length*2},'classic-bind-output')){fail('shared metadata budget exhausted while recording threaded bind');return;}",
    'threaded-output-budget',
  );
  out = replaceExact(out,
    "if (!symbol) { fail('bind encountered before a symbol was set'); return; }",
    "if (!symbol) { fail('bind encountered before a symbol was set'); return false; }",
    'bind-missing-symbol');
  out = replaceExact(out,
    "if (threadedTable.length < threadedTableLimit) { threadedTable.push(snapshotImport()); return; }",
    [
      'if (threadedTable.length < threadedTableLimit) {',
      '        const template = snapshotImport();',
      "        if(!budget.take({objects:2,operations:1,stringBytes:template.name.length*2,estimatedHeapBytes:320+template.name.length*2},'classic-bind-template')){fail('shared metadata budget exhausted while recording threaded ordinal template');return false;}",
      '        threadedTable.push(template); return true;',
      '      }',
    ].join('\n'),
    'threaded-template-budget');
  out = replaceExact(out,
    "fail(`threaded ordinal table exceeds declared ${threadedTableLimit} entries`);\n      return;",
    "fail(`threaded ordinal table exceeds declared ${threadedTableLimit} entries`);\n      return false;",
    'threaded-template-overflow');
  out = replaceExact(out,
    "if (!validLocation()) { fail(`bind location is outside segment ${segIndex} at +0x${segOffset.toString(16)}`); return; }",
    "if (!validLocation()) { fail(`bind location is outside segment ${segIndex} at +0x${segOffset.toString(16)}`); return false; }",
    'bind-location');
  out = replaceExact(out,
    "if(!budget.take({objects:2,operations:1,stringBytes:symbol.length*2,estimatedHeapBytes:320+symbol.length*2},'classic-bind-output')){fail('shared metadata budget exhausted while recording bind');return;}\n    image.imports.push(imp); status.decodedBinds++;",
    "if(!budget.take({objects:2,operations:1,stringBytes:symbol.length*2,estimatedHeapBytes:320+symbol.length*2},'classic-bind-output')){fail('shared metadata budget exhausted while recording bind');return false;}\n    image.imports.push(imp); status.decodedBinds++; return true;",
    'ordinary-bind-budget-result');
  out = replaceExact(out,
    "else if (op === 0x90) { bind(); segOffset += ptrSize; }\n    else if (op === 0xa0) { bind(); const x = r.uleb(p, 10, end); p = x.next; segOffset += ptrSize + x.value; }\n    else if (op === 0xb0) { bind(); segOffset += ptrSize + BigInt(imm) * ptrSize; }",
    "else if (op === 0x90) { if (!bind()) break; segOffset += ptrSize; }\n    else if (op === 0xa0) { if (!bind()) break; const x = r.uleb(p, 10, end); p = x.next; segOffset += ptrSize + x.value; }\n    else if (op === 0xb0) { if (!bind()) break; segOffset += ptrSize + BigInt(imm) * ptrSize; }",
    'direct-bind-failure-propagation');
  out = replaceExact(out,
    "const maxByBudget=Math.min(budget.remaining('operations'),Math.floor(budget.remaining('objects')/2));\n      const allowed=Math.max(0,Math.min(repeat,maxBySegment,maxByBudget));\n      for(let i=0;i<allowed;i++){bind();segOffset+=step;}",
    "const retainedNameBytes=Math.max(1,symbol.length*2);\n      const maxByBudget=Math.min(budget.remaining('operations'),Math.floor(budget.remaining('objects')/2),Math.floor(budget.remaining('stringBytes')/retainedNameBytes));\n      const allowed=Math.max(0,Math.min(repeat,maxBySegment,maxByBudget));\n      let completed=0;\n      for(;completed<allowed;completed++){if(!bind())break;segOffset+=step;}\n      if(completed<allowed) break;",
    'repeat-bind-failure-propagation');
  return out;
})) changed.push('js/binary/macho-dyld.js');

if (await edit('js/names.js', (source) => {
  let out = source;
  out = replaceExact(out,
    "this._deltaTotalBytes = 0;\n    this._deltaPrefix = this.id ? `${PREFIX}${this.id}.delta.` : null;",
    "this._deltaTotalBytes = 0;\n    this._deltaLoadComplete = true;\n    this._deltaPrefix = this.id ? `${PREFIX}${this.id}.delta.` : null;",
    'delta-complete-state');
  out = replaceExact(out,
    "  _loadDeltas() {\n    if (!this._deltaPrefix || typeof localStorage === 'undefined') return;\n    this._deltaBytes.clear(); this._deltaTotalBytes = 0;\n    const keys = [];",
    "  _loadDeltas() {\n    if (!this._deltaPrefix || typeof localStorage === 'undefined') { this._deltaLoadComplete = true; return; }\n    this._deltaLoadComplete = false;\n    this._deltaBytes.clear(); this._deltaTotalBytes = 0;\n    const keys = [];\n    let complete = true;",
    'delta-scan-start');
  out = replaceExact(out,
    "      try { raw = localStorage.getItem(storageKey); } catch { continue; }\n      if (raw == null) continue;",
    "      try { raw = localStorage.getItem(storageKey); } catch { complete = false; continue; }\n      if (raw == null) { complete = false; continue; }",
    'delta-read-failure');
  out = replaceExact(out,
    [
      "        if (!map || typeof delta?.key !== 'string') continue;",
      "        if (delta.deleted) map.delete(delta.key); else map.set(delta.key, String(delta.value ?? ''));",
      '      } catch { /* base snapshot remains valid if a delta is unreadable */ }',
      '    }',
      '  }',
    ].join('\n'),
    [
      "        if (!map || typeof delta?.key !== 'string') { complete = false; continue; }",
      "        if (typeof delta.deleted !== 'boolean') { complete = false; continue; }",
      "        if (!delta.deleted && typeof delta.value !== 'string') { complete = false; continue; }",
      '        if (delta.deleted) map.delete(delta.key); else map.set(delta.key, delta.value);',
      '      } catch { complete = false; /* base snapshot remains valid if a delta is unreadable */ }',
      '    }',
      '    this._deltaLoadComplete = complete;',
      '  }',
    ].join('\n'),
    'delta-schema-completion');
  out = replaceExact(out,
    "  _persistDelta(kind, recordKey, value) {\n    if (!this.id || !this._deltaPrefix) return this._saveFailure('NO_ID');",
    "  _persistDelta(kind, recordKey, value) {\n    if (!this.id || !this._deltaPrefix) return this._saveFailure('NO_ID');\n    if (!this._deltaLoadComplete) return this._saveFailure('DELTA_LOAD_INCOMPLETE');",
    'delta-persist-block');
  out = replaceExact(out,
    "  save() {\n    if (!this.id) return this._saveFailure('NO_ID');",
    "  save() {\n    if (!this.id) return this._saveFailure('NO_ID');\n    if (!this._deltaLoadComplete) return this._saveFailure('DELTA_LOAD_INCOMPLETE');",
    'delta-save-block');
  return out;
})) changed.push('js/names.js');

if (await edit('package.json', (source) => replaceExact(
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
