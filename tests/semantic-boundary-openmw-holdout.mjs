/*
 * Opt-in Phase-0/1 harness for the real, source-grounded OpenMW holdout.
 *
 * The artifact is compiled from pinned OpenMW source (GPL-3.0-only) and is
 * therefore never committed to this repository. Point HEX_OPENMW_HOLDOUT_ARTIFACT
 * at the locally built arm64 Mach-O. The deterministic D1..D4 baseline always
 * runs; the referee variants need HEX_OPENMW_HOLDOUT_LIVE=1 and a real
 * OPENJEV_API_KEY, so a run without the key cannot fabricate a shadow result.
 *
 * Every labelled case in the manifest is evaluated, not just the first one, so
 * a promotion decision can never rest on a single goal. The four variants are
 * the same as the synthetic harness: current D1..D4, shadow choice, shadow
 * parallel noul, and the gated single probe, plus a deterministic oracle that
 * marks the ceiling of the one-probe path for cases whose truth is reachable
 * from the boundary set.
 */
import fs from 'node:fs';
import { openBinary } from './harness.mjs';
import { foldShapes } from '../js/shapes.js';
import { goalFromPreset } from '../js/goals.js';
import { pinpointLocation } from '../js/pinpoint.js';
import {
  SEMANTIC_BOUNDARY_ADMISSION_SCHEMA,
  SEMANTIC_BOUNDARY_AMBIGUITY_SCHEMA,
} from '../js/semantic-boundary-referee.js';
import {
  normalizeOpenJevSemanticRankResponse,
  openJevRequestBody,
} from '../js/ai/provider/worker-semantic-rank.js';

const MANIFEST = JSON.parse(fs.readFileSync(
  new URL('./fixtures/openmw-boundary-holdout.manifest.json', import.meta.url),
  'utf8',
));
const LIVE_URL = 'https://api.openjev.sh/v1/systemone';
const UPSTREAM_TIMEOUT_MS = 2500;
// Ambiguity/admission policies are the holdout-frozen values; promotion stays
// off until this harness shows a rescue on a real labelled holdout.
const AMBIGUITY = Object.freeze({ schema: SEMANTIC_BOUNDARY_AMBIGUITY_SCHEMA, maxD4D5Gap: 0.02, minD4Score: 0 });
const ADMISSION = Object.freeze({ schema: SEMANTIC_BOUNDARY_ADMISSION_SCHEMA, minProbability: 0.8, minMargin: 0.2 });
const CASES = Array.isArray(MANIFEST.cases) ? MANIFEST.cases : [];

const artifact = process.env.HEX_OPENMW_HOLDOUT_ARTIFACT;
if (!artifact || !fs.existsSync(artifact)) {
  process.stdout.write(`${JSON.stringify({
    schema: 'hex-openmw-boundary-holdout-evaluation/v1',
    skipped: true,
    reason: 'HEX_OPENMW_HOLDOUT_ARTIFACT is not set to a locally built arm64 artifact.',
    artifactPolicy: MANIFEST.artifactPolicy,
  }, null, 2)}\n`);
  process.exit(0);
}

const key = typeof process.env.OPENJEV_API_KEY === 'string' ? process.env.OPENJEV_API_KEY : '';
const live = process.env.HEX_OPENMW_HOLDOUT_LIVE === '1' && key.length > 0;
const upstreamLatency = { choice: [], noul: [] };

function percentile(values, q) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1))];
}

/** A live callback returns the normalized preference, or null to fail open. */
function liveReferee(method) {
  return async ({ goal, candidates }) => {
    const request = { goal, candidates, method };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort('timeout'), UPSTREAM_TIMEOUT_MS);
    const started = performance.now();
    try {
      const response = await fetch(LIVE_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify(openJevRequestBody(request)),
        signal: controller.signal,
      });
      if (!response.ok) return null;
      return normalizeOpenJevSemanticRankResponse(await response.json(), request);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
      upstreamLatency[method].push(Number((performance.now() - started).toFixed(1)));
    }
  };
}

const world = await openBinary(artifact, { objc: false, strings: false, texts: false });
const shapes = foldShapes(await world.backend.valueShapes(world.region.id));
const program = {
  functionRange(addr) {
    const start = world.symbols.functionStartAt(BigInt(addr));
    return start == null ? null : { start, end: world.symbols.functionWindowBound(start) };
  },
};

// A deterministic oracle challenger makes the ceiling of the one-probe path
// reproducible without touching the network. It answers the labelled boundary
// id (the boundary set is ranks 4..N, so `c1` is the true D5) with a high
// probability, so a rescue here is the best the mechanism can ever do.
function oracleReferee(challengerId) {
  return async () => ({
    model: 'openjev', method: 'choice', challengerId,
    probabilities: challengerId === 'c0'
      ? { c0: 0.95, c1: 0.03, none: 0.02 }
      : { c0: 0.03, c1: 0.95, none: 0.02 },
    abstain: false,
  });
}

async function runVariant(caseDef, name, options = {}) {
  const truthOffset = BigInt(caseDef.offset);
  const analyzeStats = { calls: 0 };
  let semanticCalls = 0;
  const referee = options.referee
    ? async (request) => { semanticCalls++; return options.referee(request); }
    : undefined;
  const traces = [];
  const result = await pinpointLocation({
    goal: goalFromPreset(caseDef.goal),
    ranked: [],
    shapes,
    program,
    analyze: async (...args) => { analyzeStats.calls++; return world.analyze(...args); },
    scanAccess: world.scanAccess,
    budget: { left: 48 },
    limit: 12,
    semanticBoundaryInteractive: true,
    semanticBoundaryMode: options.mode || 'shadow',
    semanticBoundaryAmbiguityPolicy: AMBIGUITY,
    semanticBoundaryAdmissionPolicy: ADMISSION,
    semanticBoundaryReferee: referee,
    semanticBoundaryInstrumentation: (event) => traces.push(event),
    semanticBoundaryAnalysisStats: { get calls() { return analyzeStats.calls; } },
  });
  const trace = traces.at(-1) || null;
  const topOffset = result.top?.offset == null ? null : BigInt(result.top.offset);
  // The labelled truth is ranked N; the boundary set is ranks 4.., so the rank
  // is what maps the truth onto a boundary id.
  const truthId = `d${caseDef.expectedDeterministicRank}`;
  return {
    name,
    candidateCount: trace?.candidateCount ?? null,
    d4Score: trace?.d4Score ?? null,
    d5Score: trace?.d5Score ?? null,
    d4D5Gap: trace?.gap ?? null,
    rankedShapeScores: trace?.rankedShapeScores ?? null,
    truthHitAtBoundary: Array.isArray(trace?.verificationTargets) && trace.verificationTargets.includes(truthId) ? 1 : 0,
    boundaryRescue: topOffset != null && topOffset === truthOffset ? 1 : 0,
    finalTopOffset: topOffset == null ? null : topOffset.toString(),
    wrongTop1: topOffset != null && topOffset !== truthOffset ? 1 : 0,
    falseLikely: result.verdict === 'likely' && topOffset !== truthOffset ? 1 : 0,
    verdict: result.verdict,
    analyzeCalls: analyzeStats.calls,
    semanticCalls,
    referee: trace?.referee ?? null,
    probe: trace?.probe ?? null,
    verificationTargets: trace?.verificationTargets ?? null,
  };
}

async function evaluateCase(caseDef) {
  const variants = [];
  const current = await runVariant(caseDef, 'current-d1-d4');
  variants.push(current);
  const oracle = caseDef.oracleChallengerId
    ? await runVariant(caseDef, 'gated-one-probe-oracle-ceiling', { mode: 'probe', referee: oracleReferee(caseDef.oracleChallengerId) })
    : null;
  if (oracle) variants.push(oracle);
  if (live) {
    variants.push(await runVariant(caseDef, 'shadow-choice', { mode: 'shadow', referee: liveReferee('choice') }));
    variants.push(await runVariant(caseDef, 'shadow-parallel-noul', { mode: 'shadow', referee: liveReferee('noul') }));
    variants.push(await runVariant(caseDef, 'gated-one-probe', { mode: 'probe', referee: liveReferee('choice') }));
  }
  const gated = variants.find((variant) => variant.name === 'gated-one-probe') || null;
  const rank = Number(caseDef.expectedDeterministicRank);
  // The boundary set is ranks 4..N, so only a truth ranked 4 or later can be
  // reached by the referee at all.  This is derived, not trusted: a manifest
  // claim that contradicts the rank is reported as a label failure below.
  const truthReachableByRank = Number.isFinite(rank) && rank >= 4;
  const rankedShapeScores = current.rankedShapeScores;
  const labelChecks = {
    candidateCountMatches: Array.isArray(rankedShapeScores) && rankedShapeScores.length === caseDef.expectedCandidateCount,
    rankWithinCandidates: Array.isArray(rankedShapeScores) && rank >= 1 && rank <= rankedShapeScores.length,
    reachabilityClaimMatchesRank: (caseDef.boundaryTruthReachable === true) === truthReachableByRank,
    deterministicTopClaimMatchesMeasurement: (caseDef.deterministicTopIsTruth === true)
      === (current.finalTopOffset === String(caseDef.offset)),
    deterministicTopReproduced: current.finalTopOffset === String(caseDef.deterministicTopOffset),
    // When the oracle runs it names the boundary id it forced; that id must be
    // the rank the manifest labelled, which proves the rank label is real.
    oracleProbeTargetsLabelledRank: oracle ? oracle.probe?.candidateId === `d${rank}` : true,
  };
  const labelsConsistent = Object.values(labelChecks).every(Boolean);
  // A case is promotional only when the deterministic baseline misses the
  // truth and the gated probe rescues it. When the truth is not reachable from
  // the boundary set, the case reports that limitation instead of a rescue.
  const promotionEligible = Boolean(
    labelsConsistent && truthReachableByRank
    && gated && current.boundaryRescue === 0 && gated.boundaryRescue === 1,
  );
  return {
    goal: caseDef.goal,
    field: caseDef.field,
    truthOffset: String(caseDef.offset),
    expectedDeterministicRank: caseDef.expectedDeterministicRank,
    boundaryTruthReachable: caseDef.boundaryTruthReachable === true,
    truthReachableByRank,
    rankedShapeScores,
    labelChecks,
    labelsConsistent,
    oracleCeilingRescues: oracle ? oracle.boundaryRescue === 1 : null,
    promotionEligible,
    variants,
  };
}

const cases = [];
for (const caseDef of CASES) cases.push(await evaluateCase(caseDef));

const report = {
  schema: 'hex-openmw-boundary-holdout-evaluation/v1',
  fixture: MANIFEST.kind,
  artifact: { path: artifact, bytes: fs.statSync(artifact).size },
  live,
  // Promotion needs a case that both misses deterministically and is rescued by
  // the gated probe, and every case's manifest labels must agree with the
  // measurement. A single labelled case is not enough to enable it.
  labelsConsistent: cases.every((entry) => entry.labelsConsistent),
  promotionEligible: cases.some((entry) => entry.promotionEligible),
  promotionBlocker: !cases.every((entry) => entry.labelsConsistent)
    ? 'At least one labelled OpenMW case disagrees with the measured fixture, so no case can be used as evidence.'
    : (cases.some((entry) => entry.promotionEligible)
      ? null
      : 'No labelled OpenMW case shows a boundary rescue by the gated probe, so production stays gated.'),
  upstreamLatencyMs: {
    choice: { p50: percentile(upstreamLatency.choice, 0.5), p95: percentile(upstreamLatency.choice, 0.95) },
    noul: { p50: percentile(upstreamLatency.noul, 0.5), p95: percentile(upstreamLatency.noul, 0.95) },
  },
  cases,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
