#!/usr/bin/env node
// Offline replay from actual facts and responses; no API and no oracle input
// to representation. This verifier does not call the live evaluation runner.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { readJevEvidence } from './read-jev-evidence.mjs';
import { stablePick, comparisonPool, stabilityRequestBody } from './jev-realgame-stability-contract.mjs';
import { validateChoice } from './jev-realgame-final-client.mjs';
import { structuralMatch, funnel, sha256 } from './jev-realgame-final-contract.mjs';
import { jevShortlist } from '../js/pinpoint.js';
import { stabilitySummary } from './evaluate-jev-realgame-stability.mjs';

export function verifyStabilityEvidence({ casesBytes, policyBytes, snapshots, rows, summary, controls }) {
  const cases = JSON.parse(casesBytes), policy = JSON.parse(policyBytes);
  const inputs = new Map(snapshots.flatMap(s => s.rows.map(row => [row.id, row])));
  assert.equal(cases.length, 50); assert.equal(inputs.size, cases.length); assert.equal(rows.length, cases.length);
  assert.equal(new Set(cases.map(c => c.id)).size, cases.length); assert.equal(new Set(rows.map(c => c.id)).size, cases.length);
  for (const snapshot of snapshots) {
    assert.match(snapshot.productSha, /^[0-9a-f]{40}$/);
    assert.equal(snapshot.complete, true); assert.equal(snapshot.productSha, summary.productSha);
    assert.equal(snapshot.policySha256, sha256(policyBytes)); assert.equal(snapshot.collection.keyCollisions, 0);
    assert.deepEqual(snapshot.sourceHashes, summary.sourceHashes);
    for (const file of ['scripts/collect-jev-realgame-stability.mjs', 'scripts/jev-realgame-stability-contract.mjs',
      'js/pinpoint.js', 'js/analysis/query/cxx-semantic-preference.js', 'js/analysis/cxx/object-evidence.js'])
      assert.match(snapshot.sourceHashes[file] ?? '', /^[0-9a-f]{64}$/, 'missing source binding');
    for (const [file, hash] of Object.entries(snapshot.sourceHashes)) assert.equal(sha256(fs.readFileSync(new URL('../' + file, import.meta.url))), hash, `current source drift: ${file}`);
  }
  let calls = 0;
  for (const gold of cases) {
    const input = inputs.get(gold.id), row = rows.find(r => r.id === gold.id), verified = gold.status === 'verified';
    assert.equal(input.query, gold.query); assert.equal(row.query, gold.query); assert.equal(input.binary, gold.binary);
    assert.equal(row.verdict, input.verdict); assert.equal(row.hexLatencyMs, input.hexLatencyMs);
    assert.equal(row.preferenceLatencyMs, input.preferenceLatencyMs); assert.deepEqual(row.recovery, input.recovery);
    assert.deepEqual(row.gold, gold); assert.equal(row.status, gold.status);
    assert.ok(input.recovery.attempted.length <= policy.collection.maxFunctionsPerQuery);
    assert.equal(new Set(input.candidates.map(c => c.key)).size, input.candidates.length);
    for (const candidate of [...input.recovered, ...input.published, ...input.candidates]) assert.equal(candidate.binarySha256, input.binarySha256);
    for (const identity of gold.identities) assert.equal(identity.binarySha256, input.binarySha256);
    const correctKey = key => verified ? structuralMatch(input.candidates.find(c => c.key === key), gold) : null;
    assert.equal(row.hexCorrect, correctKey(input.topKey));
    assert.equal(row.arms.A.key, input.topKey);
    const local = input.routed ? stablePick(gold.query, input.candidates) : input.candidates.find(c => c.key === input.topKey);
    assert.equal(row.arms.R1.key, local?.key ?? null); assert.equal(input.stableTopKey, local?.key ?? null);
    assert.deepEqual(row.funnel, funnel({ ...input, candidates: input.published }, gold));
    const expectedShortlist = jevShortlist(input.candidates, { max: 255 });
    assert.deepEqual(input.shortlist.map(c => c.key), expectedShortlist.map(c => c.key));
    assert.ok(input.trustedViews.length === input.candidates.length);
    input.candidates.forEach((c, i) => {
      const trusted = input.trustedViews[i]; assert.equal(trusted.key, c.key); assert.equal(trusted.className, c.className);
      assert.deepEqual(trusted.functionContexts, c.functionContexts.map(ctx => ({ address: ctx.address, name: ctx.name,
        receiverProven: ctx.receiverProven, accessRoles: ctx.accessRoles })));
    });
    for (const arm of ['current', 'E', 'E2', 'G']) {
      const result = row.arms[arm]; assert.equal(result.repeatedKeys.length, policy.repeats);
      assert.equal(result.key, result.repeatedKeys[0]); assert.equal(result.correct, correctKey(result.key));
      assert.deepEqual(result.repeatedCorrect, result.repeatedKeys.map(correctKey));
      const pool = arm === 'G' && input.routed ? comparisonPool(gold.query, input.candidates) : input.candidates;
      const shortlist = jevShortlist(pool, { max: 255 });
      const shouldCall = input.routed && shortlist.length >= 2;
      assert.equal(result.calls.length, shouldCall ? policy.repeats : 0);
      for (const call of result.calls) {
        calls++; assert.equal(call.query, gold.query); assert.equal(call.policyArm, arm);
        const body = stabilityRequestBody(gold.query, shortlist, arm === 'G' ? 'E2' : arm);
        assert.equal(call.bodyHash, sha256(JSON.stringify(body)), 'payload drift or oracle leakage');
        assert.deepEqual(call.criteria, body.questions.pick.criteria);
        if (!call.error) {
          assert.equal(validateChoice(call.response, shortlist.length), null);
          const index = Number(call.response.answers.pick.choice.slice(1));
          assert.equal(call.choiceIndex, index); assert.equal(call.selectedKey, shortlist[index].key);
          assert.equal(result.repeatedKeys[call.repeat], call.selectedKey);
        } else assert.equal(result.repeatedKeys[call.repeat], arm === 'G' ? pool[0]?.key ?? local?.key ?? null : input.topKey);
      }
      if (!shouldCall) assert.ok(result.repeatedKeys.every(key => key === (arm === 'G' ? local?.key ?? null : input.topKey)));
    }
    assert.equal(row.arms.ADVISORY.key, row.arms.R1.key);
    assert.deepEqual(row.arms.ADVISORY.repeatedKeys, Array(policy.repeats).fill(row.arms.R1.key));
    assert.deepEqual(row.arms.ADVISORY.rawSuggestionKeys, row.arms.E2.repeatedKeys);
    for (const result of Object.values(row.arms)) assert.equal(result.correct, correctKey(result.key));
  }
  if (controls) for (const row of controls.rows) {
    assert.equal(row.total, 5); assert.equal(row.committedCorrect, row.calls.filter(c => c.committedCorrect).length);
    assert.equal(row.rawCorrect, row.calls.filter(c => c.rawCorrect).length);
    assert.ok(row.calls.every(c => c.committedKey === row.baselineKey));
  }
  const replay = stabilitySummary(rows, snapshots, policyBytes, casesBytes, controls);
  for (const [key, value] of Object.entries(replay)) assert.deepEqual(summary[key], value, `aggregate drift: ${key}`);
  // Independently recompute promotion, rather than trusting the live runner's
  // decision field or its aggregation function to enforce the safety bars.
  const cxxCorrect = rows.filter(r => r.arms.R1.correct).length;
  const baselineCases = cxxCorrect + (controls?.rows.filter(r => r.baselineCorrect).length ?? 0);
  const preserved = arm => rows.every(r => !r.arms.R1.correct || r.arms[arm].repeatedCorrect.every(Boolean));
  const safe = arm => summary.vsR1[arm].regression === 0 && preserved(arm)
    && summary.vsR1[arm].unsafeConfident === 0 && summary.vsR1[arm].falseStrong === 0
    && baselineCases >= 15 && cxxCorrect >= 5
    && summary.vsR1[arm].apiAddedLatency.p95 != null && summary.vsR1[arm].apiAddedLatency.p95 <= 1000
    && summary.vsR1[arm].apiErrorRate != null && summary.vsR1[arm].apiErrorRate <= .05
    && controls != null && controls.rows.every(r => !r.baselineCorrect || r.rawCorrect === r.total);
  const defaultOn = safe('E2') && summary.summaries.E2.latticeRecall >= .5
    && ['openttd', 'openmw'].every(g => summary.perGameVsR1[g].E2.net >= 2);
  const selective = safe('G') && ['openttd', 'openmw'].every(g => summary.perGameVsR1[g].G.net >= 1);
  const advisory = summary.vsR1.E2.rescue >= 1 && rows.every(r => r.arms.ADVISORY.repeatedKeys.every(k => k === r.arms.R1.key))
    && controls != null && controls.rows.every(r => r.committedCorrect === r.total);
  assert.equal(summary.finalPolicy, defaultOn ? 'DEFAULT_ON' : selective ? 'SELECTIVE_DEFAULT_ON' : advisory ? 'OPTIONAL_ADVISORY' : 'NO_GO');
  return { valid: true, cases: cases.length, verified: cases.filter(c => c.status === 'verified').length, calls, finalPolicy: summary.finalPolicy };
}

function main() {
  const [snapshotsDir, resultsDir, controlsFile] = process.argv.slice(2);
  const root = new URL('../reports/investigations/jev-realgame-final/stability-v2/', import.meta.url);
  const summary = JSON.parse(fs.readFileSync(path.join(resultsDir, 'summary.json')));
  const snapshots = ['openttd', 'openmw'].map(game => {
    const bytes = readJevEvidence(path.join(snapshotsDir, `${game}.json`)); assert.equal(sha256(bytes), summary.snapshotHashes[game]); return JSON.parse(bytes);
  });
  const casesBytes = fs.readFileSync(new URL('structural-cases.json', root)), policyBytes = fs.readFileSync(new URL('policy-freeze.json', root));
  assert.equal(sha256(casesBytes), summary.caseSha256); assert.equal(sha256(policyBytes), summary.policySha256);
  const controls = controlsFile ? JSON.parse(fs.readFileSync(controlsFile)) : null;
  assert.equal(summary.controlsSha256, controlsFile ? sha256(fs.readFileSync(controlsFile)) : null);
  const rows = readJevEvidence(path.join(resultsDir, 'raw-results.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  console.log(JSON.stringify(verifyStabilityEvidence({ casesBytes, policyBytes, snapshots, rows, summary, controls })));
}
if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) main();
