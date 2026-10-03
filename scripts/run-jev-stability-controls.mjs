#!/usr/bin/env node
import fs from 'node:fs';
import { rerankWithJev, adviseWithJev } from '../js/pinpoint.js';
import { RealGameJevClient } from './jev-realgame-final-client.mjs';
import { stabilityRequestBody } from './jev-realgame-stability-contract.mjs';
import { persistentWrite, sha256, percentiles } from './jev-realgame-final-contract.mjs';
import { assertStabilityExecution } from './jev-stability-execution-guard.mjs';

const [inputFile, outputFile] = process.argv.slice(2);
if (!outputFile || !process.env.OPENJEV_API_KEY) throw new Error('usage: CONTROLS OUTPUT; API key required');
const execution = assertStabilityExecution();
const rows = [];
for (const c of JSON.parse(fs.readFileSync(inputFile)).controls) {
  for (const [file, expected] of [[c.binary.path, c.binary.sha256], [c.retainedSnapshot.path, c.retainedSnapshot.sha256], [c.corpus.caseFile, c.corpus.caseSha256]])
    if (sha256(fs.readFileSync(file)) !== expected) throw new Error('real control provenance mismatch');
  const candidates = c.shortlist.candidates.map(s => ({ key: s.key, className: s.className, fieldName: s.fieldName,
    offset: s.offset, size: s.type?.bytes ?? null, type: s.type, recoveredType: null, functionContexts: [],
    score: s.fusionLogOdds, fusion: { logOdds: s.fusionLogOdds }, source: 'objc', anonymous: false }));
  const base = { candidates, top: candidates[0], verdict: c.candidateLattice.verdict ?? 'ambiguous' };
  const correct = chosen => chosen?.className === c.target.className && chosen?.fieldName === c.target.fieldName;
  const client = new RealGameJevClient({ apiKey: process.env.OPENJEV_API_KEY, arm: 'E2', requestBuilder: stabilityRequestBody,
    maxAttempts: execution.maxAttempts, timeoutMs: execution.totalTimeoutMs });
  const calls = [];
  for (let repeat = 0; repeat < 5; repeat++) {
    const raw = await rerankWithJev(c.query, base, { enabled: true, client, maxChoices: 255 });
    const committed = await adviseWithJev(c.query, base, { enabled: true, maxChoices: 255,
      client: { call: async () => raw.source === 'jev' ? { selectedKey: raw.top1.key } : null } });
    calls.push({ repeat, rawKey: raw.top1?.key, rawCorrect: correct(raw.top1), committedKey: committed.top1?.key,
      committedCorrect: correct(committed.top1), call: client.calls.at(-1) });
  }
  rows.push({ id: c.caseId, query: c.query, target: c.target, baselineKey: base.top.key, baselineCorrect: correct(base.top),
    total: calls.length, rawCorrect: calls.filter(c => c.rawCorrect).length, committedCorrect: calls.filter(c => c.committedCorrect).length,
    rawUnstable: new Set(calls.map(c => c.rawKey)).size > 1, committedUnstable: new Set(calls.map(c => c.committedKey)).size > 1, calls });
  persistentWrite(outputFile, { schema: 'hex-jev-stability-controls/v2', inputSha256: sha256(fs.readFileSync(inputFile)),
    executionFreezeSha256: sha256(fs.readFileSync(new URL('../reports/investigations/jev-realgame-final/stability-v2/execution-freeze.json', import.meta.url))),
    policySha256: sha256(fs.readFileSync(new URL('../reports/investigations/jev-realgame-final/stability-v2/policy-freeze.json', import.meta.url))),
    rows, rawApiLatency: percentiles(rows.flatMap(row => row.calls.map(c => c.call.addedLatencyMs))) });
  console.log(`${c.caseId}: measured raw and committed controls`);
}
