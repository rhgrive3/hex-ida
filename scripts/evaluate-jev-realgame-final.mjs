#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rerankWithJev } from '../js/pinpoint.js';
import { deterministicLexicalPick } from './run-jev-realgame-eval.mjs';
import { RealGameJevClient } from './jev-realgame-final-client.mjs';
import { ARMS, persistentWrite, verifyCases, structuralMatch, funnel, percentiles, sha256 } from './jev-realgame-final-contract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FINAL = path.join(ROOT, 'reports/investigations/jev-realgame-final');
export const isStrong = verdict => ['confirmed', 'likely'].includes(verdict);

export function summarize(rows, arm) {
  const answerable = rows.filter(r => r.funnel.verified);
  const correct = r => r.arms[arm].correct;
  const n = answerable.length;
  const rescued = answerable.filter(r => !r.hexCorrect && correct(r));
  const regressed = answerable.filter(r => r.hexCorrect && !correct(r));
  const hexCorrect = answerable.filter(r => r.hexCorrect).length;
  const top1 = answerable.filter(correct).length;
  const reachable = answerable.filter(r => r.funnel.recovered);
  const goldInLattice = answerable.filter(r => r.funnel.lattice).length;
  const goldInShortlist = answerable.filter(r => r.funnel.shortlist).length;
  const calls = rows.flatMap(r => r.arms[arm]?.calls ?? []);
  const allAttempts = calls.flatMap(c => c.attempts);
  const failures = calls.filter(c => c.error).length;
  return { answerable: n, top1, accuracy: n ? top1/n : null, hexTop1: hexCorrect,
    rescue: rescued.length, regression: regressed.length, net: rescued.length-regressed.length,
    regressionRescueRatio: rescued.length ? regressed.length/rescued.length : null,
    baselineDestructionRate: hexCorrect ? regressed.length/hexCorrect : null,
    structurallyRecovered: reachable.length, recoveryRate: n ? reachable.length/n : null,
    reachableCorrect: reachable.filter(correct).length,
    reachableAccuracy: reachable.length ? reachable.filter(correct).length/reachable.length : null,
    goldInLattice, latticeRecall: n ? goldInLattice/n : null, goldInShortlist,
    shortlistRetention: goldInLattice ? goldInShortlist/goldInLattice : null,
    unreachableBecauseNotRecovered: answerable.filter(r => r.funnel.unreachableBecauseNotRecovered).length,
    recoveredButNotPublished: answerable.filter(r => r.funnel.recoveredButNotPublished).length,
    publishedButOutsideShortlist: answerable.filter(r => r.funnel.publishedButOutsideShortlist).length,
    rerankingFailure: answerable.filter(r => r.funnel.shortlist && !correct(r)).length,
    falseStrong: answerable.filter(r => isStrong(r.verdict) && !correct(r)).length,
    unsafeConfident: rows.filter(r => isStrong(r.verdict) && (r.status === 'control' || r.status === 'verified' && !correct(r))).length,
    controlCount: rows.filter(r => r.status === 'control').length,
    controlStrong: rows.filter(r => r.status === 'control' && isStrong(r.verdict)).length,
    controlPreferenceSelected: rows.filter(r => r.status === 'control' && r.arms[arm].key != null).length,
    unverifiedCount: rows.filter(r => r.status === 'unverified').length,
    apiCalls: calls.length, apiAttempts: allAttempts.length, apiFailures: failures,
    apiErrorRate: calls.length ? failures/calls.length : null,
    attemptErrors: allAttempts.filter(a => a.error).length,
    timeouts: allAttempts.filter(a => a.error === 'timeout').length,
    retries: allAttempts.filter(a => a.number > 1).length,
    apiAddedLatency: percentiles(calls.map(c => c.addedLatencyMs)),
    hexLatency: percentiles(rows.map(r => r.hexLatencyMs)),
    endToEndLatency: percentiles(rows.flatMap(r => (r.arms[arm].calls?.length ? r.arms[arm].calls.map(c => r.hexLatencyMs + c.addedLatencyMs) : [r.hexLatencyMs]))),
    unstableCases: rows.filter(r => new Set(r.arms[arm].repeatedKeys ?? []).size > 1).map(r => r.id),
    destructiveUnstableCases: answerable.filter(r => r.hexCorrect && (r.arms[arm].repeatedCorrect ?? []).includes(false)).map(r => r.id),
    regressions: regressed.map(r => ({ id: r.id, cause: r.failureCauses, hexKey: r.topKey, selectedKey: r.arms[arm].key,
      gold: r.gold, repeatedKeys: r.arms[arm].repeatedKeys })),
  };
}

async function main() {
  const [snapshotsDir, destination] = process.argv.slice(2);
  if (!snapshotsDir || !destination || !process.env.OPENJEV_API_KEY) throw new Error('usage: SNAPSHOTS_DIR OUTPUT_DIR; OPENJEV_API_KEY required');
  const policyBytes = fs.readFileSync(path.join(FINAL, 'policy-freeze.json'));
  const policy = JSON.parse(policyBytes);
  const caseBytes = fs.readFileSync(path.join(ROOT, 'reports/investigations/jev-real-game-freeform-holdout/holdout-cases.json'));
  const cases = verifyCases(caseBytes);
  const goldBytes = fs.readFileSync(path.join(FINAL, 'structural-gold.json'));
  const goldManifest = JSON.parse(goldBytes);
  const golds = new Map(goldManifest.cases.map(g => [g.id, g]));
  if (goldManifest.caseSha256 !== sha256(caseBytes) || golds.size !== cases.length) throw new Error('gold manifest binding failure');
  const snapshots = ['openttd','openmw'].map(k => JSON.parse(fs.readFileSync(path.join(snapshotsDir, `${k}.json`))));
  const productShas = new Set(snapshots.map(s => s.productSha));
  if (productShas.size !== 1) throw new Error('mixed product snapshots');
  for (const s of snapshots) {
    if (s.caseSha256 !== sha256(caseBytes) || s.policySha256 !== sha256(policyBytes)
      || s.contractSha256 !== sha256(fs.readFileSync(path.join(ROOT, 'scripts/jev-realgame-final-contract.mjs')))
      || s.collectorSha256 !== sha256(fs.readFileSync(path.join(ROOT, 'scripts/collect-jev-realgame-final.mjs')))) throw new Error('snapshot manifest binding failure');
  }
  const inputs = new Map(snapshots.flatMap(s => s.rows.map(r => [r.id,r])));
  if (inputs.size !== cases.length) throw new Error('missing case snapshot');
  const rows = [];
  const clients = Object.fromEntries(ARMS.map(arm => [arm, new RealGameJevClient({ apiKey: process.env.OPENJEV_API_KEY, arm,
    timeoutMs: policy.retries.timeoutMs, maxAttempts: policy.retries.maxAttempts })]));
  for (const c of cases) {
    const input = inputs.get(c.id);
    if (input.query !== c.query) throw new Error('query drift');
    const g = golds.get(c.id);
    const f = funnel(input, g);
    const hex = input.candidates.find(candidate => candidate.key === input.topKey) ?? null;
    const base = { top: hex, candidates: input.candidates, verdict: input.verdict };
    const hexCorrect = f.verified ? structuralMatch(hex, g) : null;
    const det = input.routed ? deterministicLexicalPick(c.query, input.candidates, policy.comparatorParameters) : hex;
    const row = { id: c.id, binary: c.binary, query: c.query, status: g.status, gold: g,
      verdict: input.verdict, topKey: input.topKey, candidateCount: input.candidates.length,
      hexLatencyMs: input.hexLatencyMs, hexCorrect, funnel: f,
      semanticContext: input.shortlist.some(s => s.fieldName || s.functionContexts.some(ctx => ctx.name)) ? 'binary symbols present; semantic sufficiency not inferred' : 'insufficient binary context',
      failureCauses: [], arms: { A: { key: input.topKey, correct: hexCorrect }, DET: { key: det?.key ?? null,
        correct: f.verified ? structuralMatch(det, g) : null } } };
    // Sequential cases preserve repeat identities; four independent arms in
    // parallel bound remote fanout. No majority voting changes primary top1.
    await Promise.all(ARMS.map(async arm => {
      const keys = [], correct = [], calls = [];
      for (let repeat = 0; repeat < policy.repeats; repeat++) {
        const client = clients[arm];
        const beforeCalls = client.calls.length;
        const result = await rerankWithJev(c.query, base, { enabled: true, mode: c.mode, client, maxChoices: 255 });
        keys.push(result.top1?.key ?? null);
        correct.push(f.verified ? structuralMatch(result.top1, g) : null);
        if (client.calls.length > beforeCalls) calls.push({ ...client.calls.at(-1), repeat });
      }
      row.arms[arm] = { key: keys[0], correct: correct[0], repeatedKeys: keys, repeatedCorrect: correct, calls };
    }));
    if (f.unreachableBecauseNotRecovered) row.failureCauses.push('candidate recovery failure');
    if (row.semanticContext === 'insufficient binary context') row.failureCauses.push('insufficient binary context');
    if (ARMS.some(arm => new Set(row.arms[arm].repeatedKeys).size > 1)) row.failureCauses.push('stochastic instability');
    rows.push(row);
    persistentWrite(path.join(destination, 'raw-results.jsonl'), rows.map(r => JSON.stringify(r)).join('\n')+'\n');
    if (rows.length % 10 === 0) console.log(`evaluated ${rows.length}/70`);
  }
  const perGame = Object.fromEntries(['openttd','openmw'].map(game => [game, Object.fromEntries(['A','DET',...ARMS].map(arm => [arm,summarize(rows.filter(r => r.binary === game),arm)]))]));
  const summaries = Object.fromEntries(['A','DET',...ARMS].map(arm => [arm,summarize(rows,arm)]));
  const primary = summaries[policy.primaryArm];
  // The pre-frozen first rule applies before considering any default routing.
  const finalPolicy = primary.net <= 0 || primary.recoveryRate === 0 || primary.falseStrong > summaries.A.falseStrong
    || primary.apiErrorRate > .05 ? 'NO_GO' : 'OPTIONAL_ADVISORY';
  const report = { schema: 'hex-jev-realgame-final-results/v1', evaluatedAtUtc: new Date().toISOString(),
    productSha: [...productShas][0], caseSha256: sha256(caseBytes), goldSha256: sha256(goldBytes),
    policySha256: sha256(policyBytes), totalCases: rows.length, originallyAnswerable: 55,
    verified: rows.filter(r => r.status === 'verified').length,
    unverified: rows.filter(r => r.status === 'unverified').length, controls: rows.filter(r => r.status === 'control').length,
    snapshotHashes: Object.fromEntries(['openttd','openmw'].map(k => [k,sha256(fs.readFileSync(path.join(snapshotsDir,`${k}.json`)))])),
    collection: Object.fromEntries(snapshots.map(s => [s.binaryKey,s.collection])),
    summaries, perGame, finalPolicy,
    reason: finalPolicy === 'NO_GO' ? 'No demonstrated independent real-game net gain or safety/API bar failure; no production default promotion.' : 'Gain requires independent default bars and routing validation before any default promotion.' };
  persistentWrite(path.join(destination,'summary.json'),report);
  console.log(JSON.stringify({ finalPolicy, verified: report.verified, primary }));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
