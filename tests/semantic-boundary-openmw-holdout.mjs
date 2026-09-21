/*
 * Opt-in Phase-0/1 harness for the real, source-grounded OpenMW holdout.
 *
 * The artifact is compiled from pinned OpenMW source (GPL-3.0-only) and is
 * therefore never committed to this repository. Point HEX_OPENMW_HOLDOUT_ARTIFACT
 * at the locally built arm64 Mach-O. The deterministic D1..D4 baseline always
 * runs; the three referee variants need HEX_OPENMW_HOLDOUT_LIVE=1 and a real
 * OPENJEV_API_KEY, so a run without the key cannot fabricate a shadow result.
 *
 * The same four variants as the synthetic harness are measured: current
 * D1..D4, shadow choice, shadow parallel noul, and the gated single probe.
 */
import fs from 'node:fs';
import { openBinary } from './harness.mjs';
import { foldShapes, byGoal } from '../js/shapes.js';
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
const truthOffset = BigInt(MANIFEST.truth.offset);
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

async function runVariant(name, options = {}) {
  const analyzeStats = { calls: 0 };
  let semanticCalls = 0;
  const referee = options.referee
    ? async (request) => { semanticCalls++; return options.referee(request); }
    : undefined;
  const traces = [];
  const result = await pinpointLocation({
    goal: goalFromPreset('hp'),
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
  return {
    name,
    candidateCount: trace?.candidateCount ?? null,
    d4Score: trace?.d4Score ?? null,
    d5Score: trace?.d5Score ?? null,
    d4D5Gap: trace?.gap ?? null,
    verificationHitAt4: Array.isArray(trace?.verificationTargets) && trace.verificationTargets.includes('d5') ? 1 : 0,
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

// A deterministic oracle challenger makes the ceiling of the one-probe path
// reproducible without touching the network. It answers c1 (the true D5) with a
// high probability, so a rescue here is the best the mechanism can ever do.
const oracleReferee = async () => ({
  model: 'openjev', method: 'choice', challengerId: 'c1',
  probabilities: { c0: 0.03, c1: 0.95, none: 0.02 }, abstain: false,
});

const current = await runVariant('current-d1-d4');
const variants = [current];
variants.push(await runVariant('gated-one-probe-oracle-ceiling', { mode: 'probe', referee: oracleReferee }));
if (live) {
  variants.push(await runVariant('shadow-choice', { mode: 'shadow', referee: liveReferee('choice') }));
  variants.push(await runVariant('shadow-parallel-noul', { mode: 'shadow', referee: liveReferee('noul') }));
  variants.push(await runVariant('gated-one-probe', { mode: 'probe', referee: liveReferee('choice') }));
}

const gated = variants.find((variant) => variant.name === 'gated-one-probe');
const oracle = variants.find((variant) => variant.name === 'gated-one-probe-oracle-ceiling');
// Promotion requires a real rescue and an oracle that also rescues: if even a
// perfect referee cannot change the final top-1, the probe path is not useful.
const promotionEligible = Boolean(
  gated && oracle && gated.boundaryRescue === 1 && oracle.boundaryRescue === 1 && current.boundaryRescue === 0,
);
const report = {
  schema: 'hex-openmw-boundary-holdout-evaluation/v1',
  fixture: MANIFEST.kind,
  upstream: MANIFEST.upstream,
  artifact: { path: artifact, bytes: fs.statSync(artifact).size },
  truth: MANIFEST.truth,
  live,
  promotionEligible,
  promotionBlocker: promotionEligible
    ? null
    : 'The source-grounded OpenMW holdout does not show a boundary rescue by the gated probe; production stays gated.',
  upstreamLatencyMs: {
    choice: { p50: percentile(upstreamLatency.choice, 0.5), p95: percentile(upstreamLatency.choice, 0.95) },
    noul: { p50: percentile(upstreamLatency.noul, 0.5), p95: percentile(upstreamLatency.noul, 0.95) },
  },
  variants,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
