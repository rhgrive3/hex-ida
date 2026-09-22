#!/usr/bin/env node
/*
 * Exact-head production verdict verification for Plan-A.
 *
 * The current-main collection already did the expensive binary work.  Plan-A
 * changes only field verdict admission, so this verifier reconstructs the
 * recorded top/runner fusions and calls the real field-path verdict helper on
 * every row.  It is intentionally offline: no candidate generation, ranking,
 * scan, decompile, or external inference is repeated.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decide } from '../js/evidence.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const index = args.indexOf('--out');
const DIR = path.resolve(ROOT, index >= 0 && args[index + 1]
  ? args[index + 1] : 'reports/investigations/pinpoint-confidence-plan-a/current-main-p4');
const evidenceIndex = args.indexOf('--evidence-out');
const EVIDENCE_OUT = evidenceIndex >= 0 && args[evidenceIndex + 1]
  ? path.resolve(args[evidenceIndex + 1]) : path.join(DIR, 'production-replay.json');
const sha256File = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const git = (...gitArgs) => execFileSync('git', gitArgs, { cwd: ROOT, encoding: 'utf8' }).trim();

function fusion(candidate) {
  if (!candidate?.fusion || !Array.isArray(candidate.evidence)) return null;
  return {
    ...candidate.fusion,
    items: candidate.evidence.map((item) => ({
      ...item,
      id: item.identifying === true,
    })),
  };
}

const rows = fs.readFileSync(path.join(DIR, 'rows.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse)
  .filter((row) => row.kind === 'field');
const mismatches = [];
for (const row of rows) {
  const top = row.candidates?.find((candidate) => candidate.rank === 1);
  const runner = row.candidates?.find((candidate) => candidate.rank === 2);
  const topFusion = fusion(top);
  if (!topFusion) {
    mismatches.push({ key: `${row.binary}|${row.mode}|${row.label}`, error: 'missing-top-fusion' });
    continue;
  }
  const result = decide([
    { key: top.key, fusion: topFusion },
    ...(runner ? [{ key: runner.key, fusion: fusion(runner) }] : []),
  ], { allowTrustedTwoGroup: true });
  if (result.verdict !== row.policyDPlanAVerdict) {
    mismatches.push({
      key: `${row.binary}|${row.mode}|${row.label}`,
      expected: row.policyDPlanAVerdict, actual: result.verdict,
    });
  }
}

const worktreeClean = git('status', '--porcelain') === '';
const output = {
  schema: 'hex-pinpoint-confidence-plan-a-production-replay/v1',
  complete: mismatches.length === 0 && worktreeClean,
  worktreeClean,
  productCommit: worktreeClean ? git('rev-parse', 'HEAD') : null,
  productTree: worktreeClean ? git('rev-parse', 'HEAD^{tree}') : null,
  sourceMeasurement: JSON.parse(fs.readFileSync(path.join(DIR, 'measurement.json'), 'utf8')),
  productionSources: {
    evidenceSha256: sha256File(path.join(ROOT, 'js/evidence.js')),
    pinpointSha256: sha256File(path.join(ROOT, 'js/pinpoint.js')),
  },
  fieldRows: rows.length,
  matchingRows: rows.length - mismatches.length,
  mismatches,
  noBinaryAnalysisRepeated: true,
  noRankingOrCandidateGenerationReplayed: true,
};
fs.mkdirSync(path.dirname(EVIDENCE_OUT), { recursive: true });
fs.writeFileSync(EVIDENCE_OUT, JSON.stringify(output, null, 2) + '\n');
process.stdout.write(JSON.stringify({ fieldRows: output.fieldRows, matchingRows: output.matchingRows, mismatches: mismatches.length, worktreeClean }, null, 2) + '\n');
if (!output.complete) process.exitCode = 1;
