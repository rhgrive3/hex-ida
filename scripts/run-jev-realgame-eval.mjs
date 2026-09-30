#!/usr/bin/env node
/**
 * Generic evaluation runner for real-game free-form holdout.
 * Evaluates candidate recall, baseline accuracy, candidate representations (Arms A-E),
 * deterministic comparator, fail-closed handling, latency, and reliability.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPORT_DIR = path.resolve(process.env.HEX_JEV_HOLDOUT_DIR
  ?? path.join(ROOT, 'reports/investigations/jev-real-game-freeform-holdout'));

const sha256 = (x) => createHash('sha256').update(x).digest('hex');

const ENDPOINT = 'https://api.openjev.sh/v1/systemone';
const MODEL = 'openjev';
const TIMEOUT_MS = 15000;
const MAX_ATTEMPTS = 2;

// Arm candidate criteria builders
export function buildCriteria(candidates, arm = 'B') {
  return Object.fromEntries(
    candidates.map((c, i) => {
      const cls = c.className ?? c.class ?? c.key?.split('#')?.[0] ?? '';
      const fld = c.fieldName ?? c.field?.name ?? c.name ?? c.key?.split('#')?.[2] ?? 'unnamed';
      const type = c.type ?? c.typeName ?? c.field?.type ?? '';
      const offset = c.offset != null ? `+0x${Number(c.offset).toString(16)}` : '';
      const cat = c.category ?? '';

      let text;
      switch (arm) {
        case 'B': // Current Jev: fieldName only
          text = String(fld);
          break;
        case 'C': // ClassName.fieldName
          text = cls ? `${cls}.${fld}` : String(fld);
          break;
        case 'D': // Structured className + fieldName
          text = cls ? `class: ${cls} | field: ${fld}` : `field: ${fld}`;
          break;
        case 'E': // Structured with type / offset / category
          text = [
            cls ? `class: ${cls}` : null,
            `field: ${fld}`,
            type ? `type: ${type}` : null,
            offset ? `offset: ${offset}` : null,
            cat ? `category: ${cat}` : null,
          ].filter(Boolean).join(' | ');
          break;
        default:
          text = String(fld);
      }
      return [`c${i}`, text];
    })
  );
}

export function requestBody(query, candidates, arm = 'B') {
  const criteria = buildCriteria(candidates, arm);
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
        instructions: 'Pick the existing member most likely to be the target of the user query. This is a forced ranking preference, not proof. Use only listed candidate IDs.',
        criteria,
      },
      unique: {
        type: 'noul',
        instructions: 'Does the user phrase uniquely identify one of these candidates without additional context?',
        criteria: { true: 'The phrase distinguishes one member', false: 'Several members plausibly fit' },
      },
    },
  };
}

export function validateResponse(response, count) {
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

export class LiveJevClient {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.callCount = 0;
    this.httpErrors = 0;
    this.timeouts = 0;
    this.latencies = [];
    this.rawCalls = [];
  }

  async call({ query, mode, candidates, arm = 'B' }) {
    this.callCount++;
    const body = requestBody(query, candidates, arm);
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
        if (error === 'timeout') this.timeouts++;
        else this.httpErrors++;
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

// Frozen 168-point BattleCats lexical grid comparator
const words = (s) => String(s || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2').replace(/[^A-Za-z0-9]+/g, ' ')
  .toLowerCase().trim().split(/\s+/).filter(Boolean);

export function deterministicLexicalPick(query, candidates, params = { exact: 0, extra: 0.5, classMatch: 0, suffix: 2 }) {
  if (!candidates || !candidates.length) return null;
  const q = words(query);
  const scored = candidates.map((c, i) => {
    const f = words(c.fieldName ?? c.name ?? c.key?.split('#')?.[2]);
    const cl = words(c.className ?? c.class ?? c.key?.split('#')?.[0]);
    const match = q.filter((w) => f.includes(w)).length;
    const exact = q.join(' ') === f.join(' ') ? 1 : 0;
    const suffix = f.slice(-q.length).join(' ') === q.join(' ') ? 1 : 0;
    const extra = Math.max(0, f.length - match);
    const classMatch = q.filter((w) => cl.includes(w)).length;
    const score = match * 10 + params.exact * exact + params.extra * extra
      + params.classMatch * classMatch + params.suffix * suffix - i * 1e-5;
    return { i, candidate: c, score };
  }).sort((a, b) => b.score - a.score);
  return scored[0]?.candidate ?? null;
}

export function isGoldMatch(cand, gold) {
  if (!cand || !gold) return false;
  const candClass = cand.className ?? cand.class ?? cand.key?.split('#')?.[0];
  const candField = cand.fieldName ?? cand.field?.name ?? cand.name ?? cand.key?.split('#')?.[2];
  if (candClass === gold.class && candField === gold.field) return true;
  if (Array.isArray(gold.alternatives)) {
    return gold.alternatives.some((alt) => alt.class === candClass && alt.field === candField);
  }
  return false;
}

async function main() {
  const casesFile = path.join(REPORT_DIR, 'holdout-cases.json');
  const manifestFile = path.join(REPORT_DIR, 'holdout-manifest.json');
  const casesBytes = fs.readFileSync(casesFile);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));

  if (sha256(casesBytes) !== manifest.caseSha256) {
    throw new Error('Holdout cases hash mismatch against manifest!');
  }
  const routerSha = sha256(fs.readFileSync(path.join(ROOT, 'js/pinpoint.js')));
  if (manifest.routerFrozenSha256 && routerSha !== manifest.routerFrozenSha256) {
    throw new Error(`Jev router changed after freeze: expected ${manifest.routerFrozenSha256}, got ${routerSha}`);
  }

  const cases = JSON.parse(casesBytes);
  console.log(`Loaded ${cases.length} hash-verified real-game cases.`);

  const { openBinary } = await import(path.join(ROOT, 'tests/harness.mjs'));
  const { pinpointField, jevShortlist } = await import(path.join(ROOT, 'js/pinpoint.js'));
  const { parseGoal } = await import(path.join(ROOT, 'js/goals.js'));

  const worlds = new Map();
  async function getWorld(binaryKey) {
    if (!worlds.has(binaryKey)) {
      const bInfo = manifest.binaries[binaryKey];
      if (!bInfo || !bInfo.localPath) {
        throw new Error(`Unknown binary key ${binaryKey}`);
      }
      const bPath = bInfo.localPath;
      if (sha256(fs.readFileSync(bPath)) !== bInfo.sha256) {
        throw new Error(`Binary hash mismatch for ${binaryKey}`);
      }
      worlds.set(binaryKey, await openBinary(bPath, { log: () => {} }));
    }
    return worlds.get(binaryKey);
  }

  const rows = [];
  let answerableCount = 0;
  let goldInLatticeCount = 0;
  let goldInShortlistCount = 0;

  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const isAnswerable = !!c.gold;
    if (isAnswerable) answerableCount++;

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

    const candidates = hexRes?.candidates ?? [];
    const top1 = hexRes?.top ?? null;
    const verdict = hexRes?.verdict ?? 'none';

    const goldRank = isAnswerable ? candidates.findIndex((cand) => isGoldMatch(cand, c.gold)) : -1;
    const goldInLattice = goldRank >= 0;
    if (goldInLattice) goldInLatticeCount++;

    const shortlist = jevShortlist(candidates, { max: 255 });
    const goldInShortlist = isAnswerable ? shortlist.some((cand) => isGoldMatch(cand, c.gold)) : false;
    if (goldInShortlist) goldInShortlistCount++;

    const isStrong = verdict === 'confirmed' || verdict === 'likely';
    const hexCorrect = isAnswerable ? isGoldMatch(top1, c.gold) : null;
    const routed = candidates.length >= 2 && !isStrong;

    rows.push({
      id: c.id,
      binary: c.binary,
      query: c.query,
      family: c.family,
      answerable: isAnswerable,
      gold: c.gold,
      candidateCount: candidates.length,
      verdict,
      goldRank: goldRank >= 0 ? goldRank + 1 : null,
      goldInLattice,
      goldInShortlist,
      hexTop1: top1 ? { class: top1.className ?? top1.key?.split('#')?.[0], field: top1.fieldName ?? top1.key?.split('#')?.[2] } : null,
      hexCorrect,
      hexLatencyMs,
      routed,
      abstainReason: c.abstainReason ?? null,
    });
  }

  const rawResultsPath = path.join(REPORT_DIR, 'raw-results-current-main.jsonl');
  fs.writeFileSync(rawResultsPath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

  const summary = {
    schema: 'hex-jev-realgame-evaluation-summary/v1',
    evaluatedAtUtc: new Date().toISOString(),
    gitCommit: 'test/jev-real-game-freeform-holdout',
    caseSha256: manifest.caseSha256,
    routerSha256: manifest.routerFrozenSha256,
    totalCases: cases.length,
    answerable: answerableCount,
    abstain: cases.length - answerableCount,
    candidateRecall: {
      goldInLattice: goldInLatticeCount,
      candidateRecallRate: answerableCount > 0 ? goldInLatticeCount / answerableCount : 0,
      goldInShortlist: goldInShortlistCount,
      latticePresentRetention: goldInLatticeCount > 0 ? goldInShortlistCount / goldInLatticeCount : null,
      allAnswerableRetention: answerableCount > 0 ? goldInShortlistCount / answerableCount : 0,
    },
    baseline: {
      top1Correct: rows.filter((r) => r.answerable && r.hexCorrect).length,
      top1Accuracy: answerableCount > 0 ? rows.filter((r) => r.answerable && r.hexCorrect).length / answerableCount : 0,
      routedCases: rows.filter((r) => r.routed).length,
    },
    evaluationStatus: goldInLatticeCount === 0
      ? 'EVALUATION_IMPOSSIBLE_CURRENT_MAIN_CANDIDATE_RECALL_ZERO'
      : 'EVALUATION_SUCCESS',
    note: goldInLatticeCount === 0
      ? 'Current main branch lacks C++ member candidate projection, resulting in candidateCount=0 for all C++ binaries. Jev reranking cannot be executed on current main because candidate recall is 0. Once the parallel C++ candidate publication branch is merged/rebased, rerun this script against the same frozen holdout.'
      : null,
  };

  const summaryPath = path.join(REPORT_DIR, 'summary-current-main.json');
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + '\n');

  console.log('--- Evaluation Result on Current Main ---');
  console.log(JSON.stringify(summary, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
