#!/usr/bin/env node
/**
 * Prospective evaluation runner for the final Jev decision (2026-09-24).
 * 
 * Arms:
 * - Arm A: Hex baseline (deterministic local pinpoint)
 * - Arm B: Hex + frozen router (rerankWithJev with client calling OpenJev)
 * 
 * Collects raw responses, HTTP errors, latency, scores, rescues, regressions,
 * false strong, unsafe confident, API error count.
 * Saves raw evidence to persistent evidence directory and committed report directory.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPORT_DIR = path.resolve(process.env.HEX_JEV_HOLDOUT_DIR
  ?? path.join(ROOT, 'reports/investigations/jev-final-decision-20260924'));
const EVIDENCE_DIR = path.resolve(process.env.HEX_JEV_EVIDENCE_DIR
  ?? '/mnt/workspace/.dev-state/agent-work/evidence/hex-completion-20260924/jev');
const FIXTURES_DIR = '/mnt/workspace/.dev-state/agent-work/cache/pinpoint-jev-probe-audit-20260923/tests';
const ENDPOINT = 'https://api.openjev.sh/v1/systemone';
const MODEL = 'openjev';
const TIMEOUT_MS = 15000;
const MAX_ATTEMPTS = 2;

const sha256 = (x) => createHash('sha256').update(x).digest('hex');

function requestBody(query, candidates) {
  const criteria = Object.fromEntries(
    candidates.map((c, i) => [`c${i}`, String(c.fieldName || c.name || c.key || 'unnamed field')])
  );
  return {
    model: MODEL,
    state: {
      userPhrase: query,
      queryKind: 'partial',
      candidateDescriptionsAreBinaryDerived: true,
    },
    questions: {
      pick: {
        type: 'choice',
        instructions: 'Pick the existing field most likely to be the remembered target of the user phrase. This is a forced ranking preference, not proof. Use only listed candidate IDs.',
        criteria,
      },
      unique: {
        type: 'noul',
        instructions: 'Does the user phrase uniquely identify one of these candidates without additional context?',
        criteria: { true: 'The phrase distinguishes one field', false: 'Several fields plausibly fit' },
      },
    },
  };
}

function validateResponse(response, count) {
  if (response?.model !== MODEL) return 'model-mismatch';
  const pick = response?.answers?.pick;
  const unique = response?.answers?.unique;
  if (pick?.type !== 'choice' || !/^c\d+$/.test(pick.choice || '')) return 'malformed-choice';
  const index = Number(pick.choice.slice(1));
  if (!Number.isInteger(index) || index < 0 || index >= count) return 'invalid-candidate';
  if (!pick.probabilities || !Number.isFinite(pick.probabilities[pick.choice]) || !Number.isFinite(pick.confidence)) return 'missing-probability';
  if (unique?.type !== 'noul' || !Number.isFinite(unique.noul) || unique.noul < 0 || unique.noul > 1) return 'malformed-unique';
  return null;
}

class LiveJevClient {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.callCount = 0;
    this.httpErrors = 0;
    this.latencies = [];
    this.rawCalls = [];
  }

  async call({ query, mode, candidates }) {
    this.callCount++;
    const body = requestBody(query, candidates);
    const bodyHash = sha256(JSON.stringify(body));
    const attempts = [];

    for (let number = 1; number <= MAX_ATTEMPTS; number++) {
      const started = performance.now();
      let status = null, payload = null, error = null;
      try {
        const response = await fetch(ENDPOINT, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        status = response.status;
        if (!response.ok) {
          error = `http-${status}`;
          this.httpErrors++;
        } else {
          try { payload = await response.json(); }
          catch { error = 'invalid-json'; }
          if (!error) error = validateResponse(payload, candidates.length);
        }
      } catch (e) {
        error = e?.name === 'TimeoutError' ? 'timeout' : 'network';
        this.httpErrors++;
      }

      const latencyMs = Math.round((performance.now() - started) * 100) / 100;
      attempts.push({ number, status, error, latencyMs });
      this.latencies.push(latencyMs);

      if (!error) {
        const choice = Number(payload.answers.pick.choice.slice(1));
        const res = {
          bodyHash,
          attempts,
          error: null,
          choiceIndex: choice,
          selectedKey: candidates[choice]?.key ?? candidates[choice]?.id ?? null,
          confidence: payload.answers.pick.confidence,
          preference: payload.answers.pick.probabilities[payload.answers.pick.choice],
          unique: payload.answers.unique.noul,
          usage: payload.usage ?? null,
          model: payload.model,
        };
        this.rawCalls.push({ query, attempts, success: true, choiceIndex: choice });
        return res;
      }

      const retryable = error === 'timeout' || error === 'network' || status === 429 || (status >= 500 && status <= 599);
      if (!retryable) break;
    }

    const failureRes = {
      bodyHash,
      attempts,
      error: attempts.at(-1)?.error ?? 'unknown-error',
      choiceIndex: null,
      selectedKey: null,
      confidence: null,
      preference: null,
      unique: null,
      usage: null,
      model: null,
    };
    this.rawCalls.push({ query, attempts, success: false, error: failureRes.error });
    return failureRes;
  }
}

async function main() {
  if (!process.env.OPENJEV_API_KEY) {
    throw new Error('OPENJEV_API_KEY is not set in environment');
  }

  const casesFile = path.join(REPORT_DIR, 'holdout-cases.json');
  const manifestFile = path.join(REPORT_DIR, 'holdout-manifest.json');
  const casesBytes = fs.readFileSync(casesFile);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));

  if (sha256(casesBytes) !== manifest.caseSha256) {
    throw new Error('Holdout cases hash mismatch against manifest!');
  }

  const cases = JSON.parse(casesBytes);
  console.log(`Loaded ${cases.length} hash-verified prospective cases.`);

  if (manifest.routerFrozenSha256
      && sha256(fs.readFileSync(path.join(ROOT, 'js/pinpoint.js'))) !== manifest.routerFrozenSha256) {
    throw new Error('Jev router changed after holdout freeze');
  }

  const { openBinary } = await import(path.join(ROOT, 'tests/harness.mjs'));
  const { pinpointField, rerankWithJev } = await import(path.join(ROOT, 'js/pinpoint.js'));
  const { parseGoal } = await import(path.join(ROOT, 'js/goals.js'));

  const worlds = new Map();
  async function getWorld(binary) {
    if (!worlds.has(binary)) {
      let p;
      if (manifest.binary && manifest.binary.localPath && (binary === manifest.binary.name.toLowerCase() || binary === manifest.binary.name || binary === 'sparkle' || binary === 'openemu')) {
        p = process.env.HEX_JEV_HOLDOUT_BINARY ?? manifest.binary.localPath;
        if (manifest.binary.sha256 && sha256(fs.readFileSync(p)) !== manifest.binary.sha256) {
          throw new Error('holdout-binary-hash-mismatch');
        }
      } else {
        p = path.join(FIXTURES_DIR, binary);
      }
      worlds.set(binary, await openBinary(p, { log: () => {} }));
    }
    return worlds.get(binary);
  }

  const client = new LiveJevClient(process.env.OPENJEV_API_KEY);
  const results = [];

  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    console.log(`[${i + 1}/${cases.length}] Evaluating ${c.id} (${c.binary})...`);

    const w = await getWorld(c.binary);
    const goal = parseGoal(c.query);

    const startedHex = performance.now();
    const hexRes = await pinpointField({
      goal,
      fields: w.fields,
      program: w.program,
      symbols: w.symbols,
      strings: w.strings,
      analyze: w.analyze,
      scanAccess: w.scanAccess,
      limit: 400,
    });
    const hexLatencyMs = Math.round((performance.now() - startedHex) * 100) / 100;

    // Arm A: Hex baseline
    const armA_top = hexRes?.top ?? null;
    const armA_verdict = hexRes?.verdict ?? 'none';
    const armA_candidates = hexRes?.candidates ?? [];

    // Arm B: Hex + frozen router (Jev enabled)
    const callCountBefore = client.callCount;
    const startedB = performance.now();
    const armB_rerank = await rerankWithJev(c.query, hexRes, {
      enabled: true,
      client,
      mode: c.mode,
      maxChoices: 255,
    });
    const bLatencyMs = Math.round((performance.now() - startedB) * 100) / 100;

    const armB_top = armB_rerank.top1;
    const armB_source = armB_rerank.source;
    const jevCall = client.callCount > callCountBefore ? client.rawCalls.at(-1) : null;

    // Evaluate correctness against gold label
    const isGold = !!c.gold;
    const isMatch = (cand) => {
      if (!cand || !c.gold) return false;
      const cClass = cand.className ?? cand.key?.split('#')?.[0];
      const cField = cand.fieldName ?? cand.field?.name ?? cand.key?.split('#')?.[2];
      return cClass === c.gold.class && cField === c.gold.field;
    };

    const armA_correct = isGold ? isMatch(armA_top) : null;
    const armB_correct = isGold ? isMatch(armB_top) : null;

    const isStrongA = armA_verdict === 'confirmed' || armA_verdict === 'likely';
    const armA_abstain = !armA_top || !isStrongA;
    // Arm B never raises strength to strong; verdict policy is preserved
    const armB_abstain = armA_abstain;

    const armA_falseStrong = isGold && isStrongA && !armA_correct;
    const armB_falseStrong = isGold && isStrongA && !armB_correct;

    const armA_unsafeConfident = isStrongA && (isGold ? !armA_correct : true);
    const armB_unsafeConfident = isStrongA && (isGold ? !armB_correct : true);
    const errorFailClosed = jevCall?.success === false
      ? armB_source === 'hex' && armB_top === armA_top
      : true;

    const row = {
      id: c.id,
      binary: c.binary,
      mode: c.mode,
      family: c.family,
      difficulty: c.difficulty,
      query: c.query,
      gold: c.gold,
      abstainReason: c.abstainReason ?? null,
      verdict: armA_verdict,
      candidateCount: armA_candidates.length,
      jevCall,
      errorFailClosed,
      armA: {
        topKey: armA_top?.key ?? null,
        topClass: armA_top?.className ?? null,
        topField: armA_top?.field?.name ?? null,
        correct: armA_correct,
        abstain: armA_abstain,
        falseStrong: armA_falseStrong,
        unsafeConfident: armA_unsafeConfident,
        latencyMs: hexLatencyMs,
      },
      armB: {
        topKey: armB_top?.key ?? null,
        topClass: armB_top?.className ?? null,
        topField: armB_top?.field?.name ?? null,
        source: armB_source,
        advisory: armB_rerank.advisory,
        correct: armB_correct,
        abstain: armB_abstain,
        falseStrong: armB_falseStrong,
        unsafeConfident: armB_unsafeConfident,
        latencyMs: bLatencyMs,
      },
    };

    results.push(row);
  }

  // Calculate aggregates
  const answerable = results.filter((r) => !!r.gold);
  const abstain = results.filter((r) => !r.gold);

  const armA_top1 = answerable.filter((r) => r.armA.correct).length;
  const armB_top1 = answerable.filter((r) => r.armB.correct).length;

  let rescues = 0;
  let regressions = 0;
  const rescueRows = [];
  const regressionRows = [];

  for (const r of answerable) {
    if (!r.armA.correct && r.armB.correct) {
      rescues++;
      rescueRows.push(r.id);
    }
    if (r.armA.correct && !r.armB.correct) {
      regressions++;
      regressionRows.push(r.id);
    }
  }

  const armA_falseStrong = results.filter((r) => r.armA.falseStrong).length;
  const armB_falseStrong = results.filter((r) => r.armB.falseStrong).length;

  const armA_unsafe = results.filter((r) => r.armA.unsafeConfident).length;
  const armB_unsafe = results.filter((r) => r.armB.unsafeConfident).length;
  const failedCalls = results.filter((r) => r.jevCall?.success === false);

  const summary = {
    schema: 'hex-jev-prospective-evaluation/v1',
    evaluatedAtUtc: new Date().toISOString(),
    productHeadAtRun: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
    routerSha256: sha256(fs.readFileSync(path.join(ROOT, 'js/pinpoint.js'))),
    caseSha256: manifest.caseSha256,
    binarySha256: manifest.binary?.sha256 ?? null,
    model: MODEL,
    nodeVersion: process.version,
    totalCases: results.length,
    answerableCases: answerable.length,
    abstainCases: abstain.length,
    apiClientStats: {
      callCount: client.callCount,
      httpErrors: client.httpErrors,
      http400ChoiceLimitErrors: client.rawCalls.reduce((n, call) =>
        n + call.attempts.filter((attempt) => attempt.status === 400).length, 0),
      p50LatencyMs: client.latencies.length ? client.latencies.sort((a,b)=>a-b)[Math.floor(client.latencies.length * 0.5)] : null,
      maxLatencyMs: client.latencies.length ? Math.max(...client.latencies) : null,
    },
    metrics: {
      armA_baseline: {
        answerableTop1: armA_top1,
        answerableN: answerable.length,
        accuracy: armA_top1 / answerable.length,
        falseStrongCount: armA_falseStrong,
        unsafeConfidentCount: armA_unsafe,
      },
      armB_routed_jev: {
        answerableTop1: armB_top1,
        answerableN: answerable.length,
        accuracy: armB_top1 / answerable.length,
        falseStrongCount: armB_falseStrong,
        unsafeConfidentCount: armB_unsafe,
      },
      differential: {
        rescues,
        regressions,
        rescueCaseIds: rescueRows,
        regressionCaseIds: regressionRows,
        regressionRescueRatio: rescues > 0 ? regressions / rescues : null,
        newFalseStrong: armB_falseStrong - armA_falseStrong,
        failedCallsObserved: failedCalls.length,
        failClosedObserved: failedCalls.length ? failedCalls.every((row) => row.errorFailClosed) : null,
      },
    },
  };

  // Write outputs
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  fs.mkdirSync(REPORT_DIR, { recursive: true });

  const rawJsonl = results.map((r) => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'prospective-raw-results.jsonl'), rawJsonl);
  fs.writeFileSync(path.join(REPORT_DIR, 'prospective-raw-results.jsonl'), rawJsonl);

  const summaryJson = JSON.stringify(summary, null, 2) + '\n';
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'prospective-summary.json'), summaryJson);
  fs.writeFileSync(path.join(REPORT_DIR, 'prospective-summary.json'), summaryJson);

  console.log('\n=== Prospective Evaluation Completed ===');
  console.log(`Total Cases: ${results.length} (Answerable: ${answerable.length}, Abstain: ${abstain.length})`);
  console.log(`API Calls: ${client.callCount}, HTTP Errors: ${client.httpErrors}`);
  console.log(`Arm A (Baseline) Top1: ${armA_top1}/${answerable.length} (${(100 * armA_top1 / answerable.length).toFixed(1)}%)`);
  console.log(`Arm B (Jev)      Top1: ${armB_top1}/${answerable.length} (${(100 * armB_top1 / answerable.length).toFixed(1)}%)`);
  console.log(`Rescues: ${rescues}, Regressions: ${regressions}`);
  console.log(`False Strong: A=${armA_falseStrong}, B=${armB_falseStrong}`);
  console.log(`Unsafe Confident: A=${armA_unsafe}, B=${armB_unsafe}`);
}

main().catch((err) => {
  console.error('Fatal in evaluation:', err);
  process.exit(1);
});
