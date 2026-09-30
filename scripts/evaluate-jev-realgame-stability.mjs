#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { rerankWithJev, adviseWithJev, jevShortlist } from '../js/pinpoint.js';
import { RealGameJevClient } from './jev-realgame-final-client.mjs';
import { stablePick, comparisonPool, stabilityRequestBody } from './jev-realgame-stability-contract.mjs';
import { structuralMatch, funnel, persistentWrite, sha256, percentiles } from './jev-realgame-final-contract.mjs';
import { summarize } from './evaluate-jev-realgame-final.mjs';
import { assertStabilityExecution } from './jev-stability-execution-guard.mjs';

export const STABILITY_ARMS = ['A', 'R1', 'current', 'E', 'E2', 'G', 'ADVISORY'];
const root = new URL('../reports/investigations/jev-realgame-final/stability-v2/', import.meta.url);

export function stabilitySummary(rows, snapshots, policyBytes, casesBytes, controls = null) {
  const summaries = Object.fromEntries(STABILITY_ARMS.map(arm => [arm, summarize(rows, arm)]));
  const againstLocal = rows.map(row => ({ ...row, hexCorrect: row.arms.R1.correct }));
  const vsR1 = Object.fromEntries(STABILITY_ARMS.map(arm => [arm, summarize(againstLocal, arm)]));
  const perGame = Object.fromEntries(['openttd', 'openmw'].map(game => [game, Object.fromEntries(STABILITY_ARMS.map(arm => [arm, summarize(rows.filter(row => row.binary === game), arm)]))]));
  const perGameVsR1 = Object.fromEntries(['openttd', 'openmw'].map(game => [game, Object.fromEntries(STABILITY_ARMS.map(arm => [arm, summarize(againstLocal.filter(row => row.binary === game), arm)]))]));
  const noDestruction = arm => againstLocal.every(row => !row.hexCorrect || !row.arms[arm].repeatedCorrect?.includes(false));
  const baseCorrect = rows.filter(row => row.arms.R1.correct).length;
  const preservationDenominator = baseCorrect + (controls?.rows.filter(row => row.baselineCorrect).length ?? 0);
  const safety = arm => vsR1[arm].regression === 0 && noDestruction(arm) && vsR1[arm].unsafeConfident === 0
    && vsR1[arm].falseStrong === 0 && preservationDenominator >= 15 && baseCorrect >= 5
    && vsR1[arm].apiAddedLatency.p95 != null && vsR1[arm].apiAddedLatency.p95 <= 1000
    && vsR1[arm].apiErrorRate != null && vsR1[arm].apiErrorRate <= .05
    && !!controls && controls.rows.every(row => !row.baselineCorrect || row.rawCorrect === row.total);
  let policy = 'NO_GO';
  if (safety('E2') && summaries.E2.latticeRecall >= .5 && ['openttd', 'openmw'].every(game => perGameVsR1[game].E2.net >= 2)) policy = 'DEFAULT_ON';
  else if (safety('G') && ['openttd', 'openmw'].every(game => perGameVsR1[game].G.net >= 1)) policy = 'SELECTIVE_DEFAULT_ON';
  else if (vsR1.E2.rescue >= 1 && summaries.ADVISORY.regression === summaries.R1.regression
    && rows.every(row => row.arms.ADVISORY.repeatedKeys.every(key => key === row.arms.R1.key))
    && controls?.rows.every(row => row.committedCorrect === row.total)) policy = 'OPTIONAL_ADVISORY';
  return { schema: 'hex-jev-stability-results/v2', caseSha256: sha256(casesBytes), policySha256: sha256(policyBytes),
    productSha: snapshots[0].productSha, sourceHashes: snapshots[0].sourceHashes, summaries, vsR1, perGame, perGameVsR1,
    collection: Object.fromEntries(snapshots.map(s => [s.binaryKey, s.collection])),
    localPromotion: ['openttd', 'openmw'].every(game => perGame[game].R1.net > 0) && summaries.R1.regression === 0 && summaries.R1.unsafeConfident === 0,
    preservationDenominator, cxxPreservationDenominator: baseCorrect,
    coldRecoveryLatency: percentiles(rows.map(row => row.recovery.elapsedMs)),
    localPreferenceAddedLatency: percentiles(rows.map(row => row.preferenceLatencyMs)), finalPolicy: policy,
    controlsPresent: controls != null,
    interpretation: 'ADVISORY committed top1 is R1; its raw suggestion is E2. Remote value is measured against R1, never attributed from preserved local choices.' };
}

async function main() {
  const [snapshotsDir, outputDir, controlsFile] = process.argv.slice(2);
  if (!outputDir || !process.env.OPENJEV_API_KEY) throw new Error('usage: SNAPSHOTS OUTPUT CONTROLS; API key required');
  const casesBytes = fs.readFileSync(new URL('structural-cases.json', root));
  const cases = JSON.parse(casesBytes), policyBytes = fs.readFileSync(new URL('policy-freeze.json', root)), policy = JSON.parse(policyBytes);
  if (policy.holdoutSha256 !== sha256(fs.readFileSync(new URL('holdout.json', root)))
    || policy.contractSha256 !== sha256(fs.readFileSync(new URL('./jev-realgame-stability-contract.mjs', import.meta.url)))
    || policy.rankingSourceSha256 !== sha256(fs.readFileSync(new URL('../js/analysis/query/cxx-semantic-preference.js', import.meta.url)))
    || policy.routerSourceSha256 !== sha256(fs.readFileSync(new URL('../js/pinpoint.js', import.meta.url)))) throw new Error('frozen V2 implementation binding');
  const snapshots = ['openttd', 'openmw'].map(game => JSON.parse(fs.readFileSync(path.join(snapshotsDir, `${game}.json`))));
  const execution = assertStabilityExecution({ snapshots });
  if (new Set(snapshots.map(s => s.productSha)).size !== 1) throw new Error('mixed product');
  for (const s of snapshots) {
    if (!s.complete || s.policySha256 !== sha256(policyBytes)) throw new Error('collection binding');
    for (const [file, hash] of Object.entries(s.sourceHashes)) if (sha256(fs.readFileSync(new URL('../' + file, import.meta.url))) !== hash) throw new Error(`source drift: ${file}`);
  }
  const inputs = new Map(snapshots.flatMap(s => s.rows.map(row => [row.id, row])));
  if (inputs.size !== cases.length) throw new Error('incomplete case inventory');
  const clients = Object.fromEntries(['current', 'E', 'E2', 'G'].map(arm => [arm, new RealGameJevClient({ apiKey: process.env.OPENJEV_API_KEY,
    arm: arm === 'G' ? 'E2' : arm, requestBuilder: stabilityRequestBody, maxAttempts: execution.maxAttempts,
    timeoutMs: execution.totalTimeoutMs })]));
  const rows = [];
  for (const gold of cases) {
    const input = inputs.get(gold.id);
    if (input.query !== gold.query || input.binary !== gold.binary || gold.identities.some(g => g.binarySha256 !== input.binarySha256)) throw new Error('query/gold binary binding');
    const hex = input.candidates.find(c => c.key === input.topKey) ?? null;
    const local = input.candidates.find(c => c.key === input.stableTopKey) ?? null;
    if ((input.routed ? stablePick(gold.query, input.candidates) : hex)?.key !== local?.key) throw new Error('production ranking parity');
    const correct = candidate => gold.status === 'verified' ? structuralMatch(candidate, gold) : null;
    const row = { id: gold.id, binary: gold.binary, query: gold.query, status: gold.status, gold, verdict: input.verdict,
      topKey: input.topKey, hexCorrect: correct(hex), hexLatencyMs: input.hexLatencyMs, preferenceLatencyMs: input.preferenceLatencyMs,
      recovery: input.recovery, funnel: funnel({ ...input, candidates: input.published }, gold), failureCauses: [], armShortlistGold: {},
      arms: { A: { key: hex?.key ?? null, correct: correct(hex) }, R1: { key: local?.key ?? null, correct: correct(local) } } };
    await Promise.all(['current', 'E', 'E2', 'G'].map(async arm => {
      const pool = arm === 'G' && input.routed ? comparisonPool(gold.query, input.candidates) : input.candidates;
      row.armShortlistGold[arm] = gold.status === 'verified' ? jevShortlist(pool, { max: 255 }).some(c => structuralMatch(c, gold)) : null;
      const base = { top: arm === 'G' ? pool[0] ?? local : hex, candidates: pool, verdict: input.verdict };
      const keys = [], repeatedCorrect = [], calls = [];
      for (let repeat = 0; repeat < policy.repeats; repeat++) {
        const client = clients[arm], before = client.calls.length;
        const result = await rerankWithJev(gold.query, base, { enabled: input.routed, mode: gold.mode, client, maxChoices: 255 });
        const candidate = arm === 'G' && !pool.length ? local : result.top1;
        keys.push(candidate?.key ?? null); repeatedCorrect.push(correct(candidate));
        if (client.calls.length !== before) calls.push({ ...client.calls.at(-1), repeat, policyArm: arm });
      }
      row.arms[arm] = { key: keys[0], correct: repeatedCorrect[0], repeatedKeys: keys, repeatedCorrect, calls };
    }));
    const advisoryKeys = [];
    for (const key of row.arms.E2.repeatedKeys) {
      const result = await adviseWithJev(gold.query, { top: local, candidates: input.candidates, verdict: input.verdict }, {
        enabled: input.routed, client: { call: async () => key == null ? null : { selectedKey: key } }, maxChoices: 255 });
      advisoryKeys.push(result.top1?.key ?? null);
    }
    row.arms.ADVISORY = { key: advisoryKeys[0], correct: correct(local), repeatedKeys: advisoryKeys,
      repeatedCorrect: advisoryKeys.map(() => correct(local)), calls: [], rawSuggestionKeys: row.arms.E2.repeatedKeys };
    if (row.funnel.unreachableBecauseNotRecovered) row.failureCauses.push('candidate recovery failure');
    if (new Set(row.arms.E2.repeatedKeys).size > 1) row.failureCauses.push('stochastic instability');
    if (row.funnel.shortlist && !row.arms.E2.correct) row.failureCauses.push('insufficient member semantics or reranking failure');
    rows.push(row);
    persistentWrite(path.join(outputDir, 'raw-results.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
    if (rows.length % 10 === 0) console.log(`V2 prospective evaluated ${rows.length}/${cases.length}`);
  }
  const controls = controlsFile ? JSON.parse(fs.readFileSync(controlsFile)) : null;
  const summary = stabilitySummary(rows, snapshots, policyBytes, casesBytes, controls);
  summary.executionFreezeSha256 = sha256(fs.readFileSync(new URL('execution-freeze.json', root)));
  summary.snapshotHashes = Object.fromEntries(['openttd', 'openmw'].map(game => [game, sha256(fs.readFileSync(path.join(snapshotsDir, `${game}.json`)))]));
  summary.controlsSha256 = controlsFile ? sha256(fs.readFileSync(controlsFile)) : null;
  persistentWrite(path.join(outputDir, 'summary.json'), summary);
  console.log(JSON.stringify({ finalPolicy: summary.finalPolicy, localPromotion: summary.localPromotion, top1: Object.fromEntries(Object.entries(summary.summaries).map(([arm, s]) => [arm, s.top1])) }));
}
if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
