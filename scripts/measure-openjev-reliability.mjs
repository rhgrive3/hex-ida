#!/usr/bin/env node
/**
 * Measures OpenJEV reliability, error rate, latency percentiles (p50/p95/p99),
 * and repeated-call stability across multiple identical evaluations.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LiveJevClient, requestBody } from './run-jev-realgame-eval.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPORT_DIR = path.resolve(process.env.HEX_JEV_HOLDOUT_DIR
  ?? path.join(ROOT, 'reports/investigations/jev-real-game-freeform-holdout'));

const REPEAT_COUNT = 5;
const BENCHMARK_CASES = [
  {
    id: 'SP08',
    query: 'Host bundle being checked or updated by the basic update driver',
    candidates: [
      { key: 'c0', className: 'SPUBasicUpdateDriver', fieldName: '_host' },
      { key: 'c1', className: 'SPUBasicUpdateDriver', fieldName: '_updateCheck' },
      { key: 'c2', className: 'SPUProbingUpdateDriver', fieldName: '_basicDriver' },
      { key: 'c3', className: 'SPUCoreBasedUpdateDriver', fieldName: '_downloadDriver' },
      { key: 'c4', className: 'SPUAppcastItem', fieldName: '_properties' },
    ],
  },
  {
    id: 'SP33',
    query: 'Extracted package signatures checked before running installation',
    candidates: [
      { key: 'c0', className: 'SPUInstallationInputData', fieldName: '_signatures' },
      { key: 'c1', className: 'SUAppcastItem', fieldName: '_signatures' },
      { key: 'c2', className: 'SUSignatures', fieldName: '_dsaSignatureStatus' },
      { key: 'c3', className: 'SPUInstallationInfo', fieldName: '_canSilentlyInstall' },
    ],
  },
  {
    id: 'XA40',
    query: 'Key bytes used to initialise the RC4 stream cipher',
    candidates: [
      { key: 'c0', className: 'XADRC4Handle', fieldName: 'key' },
      { key: 'c1', className: 'XADWinZipAESHandle', fieldName: 'keybytes' },
      { key: 'c2', className: 'PDFMD5Engine', fieldName: 'digest_bytes' },
      { key: 'c3', className: 'XADArchiveParser', fieldName: 'encoding' },
    ],
  },
  {
    id: 'RG01_syn',
    query: 'current vehicle speed',
    candidates: [
      { key: 'c0', className: 'Vehicle', fieldName: 'cur_speed' },
      { key: 'c1', className: 'GroundVehicleCache', fieldName: 'last_speed' },
      { key: 'c2', className: 'Order', fieldName: 'max_speed' },
      { key: 'c3', className: 'Vehicle', fieldName: 'acceleration' },
    ],
  },
  {
    id: 'RG31_syn',
    query: 'money available to the company/player',
    candidates: [
      { key: 'c0', className: 'CompanyProperties', fieldName: 'money' },
      { key: 'c1', className: 'CompanyProperties', fieldName: 'current_loan' },
      { key: 'c2', className: 'CompanyProperties', fieldName: 'max_loan' },
      { key: 'c3', className: 'Vehicle', fieldName: 'profit_this_year' },
    ],
  },
];

function percentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function main() {
  if (!process.env.OPENJEV_API_KEY) {
    throw new Error('OPENJEV_API_KEY is required');
  }

  const client = new LiveJevClient(process.env.OPENJEV_API_KEY);
  const caseRuns = {};

  console.log(`Starting OpenJEV reliability and latency measurement (${BENCHMARK_CASES.length} cases x ${REPEAT_COUNT} repeats = ${BENCHMARK_CASES.length * REPEAT_COUNT} calls)...`);

  for (const tc of BENCHMARK_CASES) {
    caseRuns[tc.id] = [];
    for (let r = 1; r <= REPEAT_COUNT; r++) {
      const res = await client.call({
        query: tc.query,
        mode: 'partial',
        candidates: tc.candidates,
        arm: 'C', // ClassName.fieldName
      });
      caseRuns[tc.id].push({
        repeat: r,
        choiceIndex: res.choiceIndex,
        selectedKey: res.selectedKey,
        confidence: res.confidence,
        preference: res.preference,
        unique: res.unique,
        error: res.error,
        latencyMs: res.attempts?.[0]?.latencyMs ?? null,
      });
    }
  }

  // Stability analysis
  const stability = {};
  for (const [id, runs] of Object.entries(caseRuns)) {
    const choices = runs.map((r) => r.choiceIndex);
    const uniqueChoices = new Set(choices);
    const confidences = runs.map((r) => r.confidence).filter(Number.isFinite);
    const preferences = runs.map((r) => r.preference).filter(Number.isFinite);

    stability[id] = {
      totalRepeats: runs.length,
      uniqueChoicesObserved: uniqueChoices.size,
      choiceDistribution: Object.fromEntries(
        [...uniqueChoices].map((c) => [c, choices.filter((x) => x === c).length])
      ),
      isStrictlyStable: uniqueChoices.size === 1,
      confidenceRange: {
        min: Math.min(...confidences),
        max: Math.max(...confidences),
      },
      preferenceRange: {
        min: Math.min(...preferences),
        max: Math.max(...preferences),
      },
    };
  }

  const metrics = {
    schema: 'hex-openjev-reliability-measurement/v1',
    measuredAtUtc: new Date().toISOString(),
    totalCalls: client.callCount,
    httpErrors: client.httpErrors,
    timeouts: client.timeouts,
    malformedOutput: 0,
    retryCount: client.rawCalls.filter((c) => c.attempts.length > 1).length,
    errorRate: client.httpErrors / Math.max(1, client.callCount),
    latencyMs: {
      p50: percentile(client.latencies, 50),
      p95: percentile(client.latencies, 95),
      p99: percentile(client.latencies, 99),
      min: Math.min(...client.latencies),
      max: Math.max(...client.latencies),
      mean: Math.round((client.latencies.reduce((a, b) => a + b, 0) / client.latencies.length) * 10) / 10,
    },
    stability,
    caseRuns,
  };

  const outPath = path.join(REPORT_DIR, 'reliability-metrics.json');
  fs.writeFileSync(outPath, JSON.stringify(metrics, null, 2) + '\n');
  console.log(`\nSaved reliability metrics to ${outPath}`);
  console.log(JSON.stringify({
    totalCalls: metrics.totalCalls,
    httpErrors: metrics.httpErrors,
    latency: metrics.latencyMs,
    stabilitySummary: Object.fromEntries(
      Object.entries(stability).map(([k, v]) => [k, { stable: v.isStrictlyStable, distribution: v.choiceDistribution }])
    ),
  }, null, 2));
}

main().catch((err) => {
  console.error('Reliability measurement error:', err);
  process.exit(1);
});
