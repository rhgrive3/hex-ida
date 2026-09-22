/*
 * Opt-in Phase-0/1 harness for the pinned real-game holdout.
 *
 * The labelled fixture is a real upstream ARM64 game release binary (see
 * `scripts/fetch-real-game-holdout.mjs` and the manifest it reads). The bytes
 * are GPL-licensed upstream build output and are therefore never committed;
 * point HEX_SEMANTIC_BOUNDARY_HOLDOUT_ARTIFACT at the fetched artifact. The
 * manifest path can be overridden with
 * HEX_SEMANTIC_BOUNDARY_HOLDOUT_MANIFEST, which is how the historical,
 * locally-built OpenMW compiler fixture is still measured.
 *
 * The deterministic D1..D4 baseline always runs; the referee variants need
 * HEX_SEMANTIC_BOUNDARY_HOLDOUT_LIVE=1 and a real OPENJEV_API_KEY, so a run
 * without the key cannot fabricate a shadow result.
 *
 * Every labelled case in the manifest is evaluated, not just the first one, so
 * a promotion decision can never rest on a single goal. The four variants are
 * the same as the synthetic harness: current D1..D4, shadow choice, shadow
 * parallel noul, and the gated single probe, plus a deterministic oracle that
 * marks the ceiling of the one-probe path for cases whose truth is reachable
 * from the boundary set.
 */
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { openBinary } from './harness.mjs';
import { foldShapes } from '../js/shapes.js';
import { goalFromPreset } from '../js/goals.js';
import { pinpointLocation } from '../js/pinpoint.js';
import {
  normalizeSemanticBoundaryAdmissionPolicy,
  normalizeSemanticBoundaryAmbiguityPolicy,
} from '../js/semantic-boundary-referee.js';
import {
  normalizeOpenJevSemanticRankResponse,
  openJevRequestBody,
} from '../js/ai/provider/worker-semantic-rank.js';
import { evaluateHoldoutLabels } from './fixtures/real-holdout-labels.mjs';

const DEFAULT_MANIFEST = new URL('./fixtures/real-game-boundary-holdout.manifest.json', import.meta.url);
const MANIFEST = JSON.parse(fs.readFileSync(
  process.env.HEX_SEMANTIC_BOUNDARY_HOLDOUT_MANIFEST || DEFAULT_MANIFEST,
  'utf8',
));
const LIVE_URL = 'https://api.openjev.sh/v1/systemone';
const UPSTREAM_TIMEOUT_MS = 2500;
// The ambiguity and admission policies are frozen in the labelled fixture, not
// in this harness, so a promotion decision stays bound to the exact policy
// identity it was measured with.  A malformed fixture policy fails loudly
// instead of silently falling back to a convenient default.
const AMBIGUITY = normalizeSemanticBoundaryAmbiguityPolicy(MANIFEST.policies?.ambiguity);
const ADMISSION = normalizeSemanticBoundaryAdmissionPolicy(MANIFEST.policies?.admission);
if (!AMBIGUITY || !ADMISSION) {
  throw new Error('real-game-holdout: the labelled fixture must freeze a valid ambiguity and admission policy');
}
const CASES = Array.isArray(MANIFEST.cases) ? MANIFEST.cases : [];
if (!CASES.length) throw new Error('real-game-holdout: the labelled fixture has no cases');

const artifact = process.env.HEX_SEMANTIC_BOUNDARY_HOLDOUT_ARTIFACT || process.env.HEX_OPENMW_HOLDOUT_ARTIFACT;
if (!artifact || !fs.existsSync(artifact)) {
  process.stdout.write(`${JSON.stringify({
    schema: 'hex-semantic-boundary-real-game-holdout-evaluation/v1',
    skipped: true,
    reason: 'HEX_SEMANTIC_BOUNDARY_HOLDOUT_ARTIFACT is not set to a fetched arm64 game artifact.',
    fixture: { schema: MANIFEST.schema, kind: MANIFEST.kind, upstream: MANIFEST.upstream ?? null },
    artifactPolicy: MANIFEST.artifactPolicy,
  }, null, 2)}\n`);
  process.exit(0);
}

// The labelled fixture is only evidence when the measured artifact is the pinned
// one.  A different (or patched) binary is a different product, so the identity
// is checked against the manifest instead of trusting the path it was given.
const artifactBytes = fs.readFileSync(artifact);
const artifactIdentity = {
  bytes: artifactBytes.length,
  sha256: createHash('sha256').update(artifactBytes).digest('hex'),
};
const pinned = (MANIFEST.artifacts || []).find((entry) => entry.binary?.sha256 === artifactIdentity.sha256)?.binary || null;
if (MANIFEST.artifacts && !pinned) {
  throw new Error(`real-game-holdout: the artifact does not match any pinned identity in the fixture (bytes=${artifactIdentity.bytes} sha256=${artifactIdentity.sha256})`);
}
if (pinned && pinned.bytes !== artifactIdentity.bytes) {
  throw new Error(`real-game-holdout: pinned size ${pinned.bytes} != measured ${artifactIdentity.bytes}`);
}

const key = typeof process.env.OPENJEV_API_KEY === 'string' ? process.env.OPENJEV_API_KEY : '';
const live = process.env.HEX_SEMANTIC_BOUNDARY_HOLDOUT_LIVE === '1' && key.length > 0;
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
// id (the boundary set is ranks 4..N, so `c<rank - 4>` is the labelled rank)
// with a high probability, so a rescue here is the best the mechanism can ever
// do.  Every id the request actually carries gets an explicit probability: the
// contract rejects a partial distribution, and the boundary set is as wide as
// the candidate list, not always two entries wide.
function oracleReferee(challengerId) {
  return async ({ candidates }) => {
    const ids = (candidates || []).map((candidate) => candidate?.id).filter(Boolean);
    const probabilities = { none: 0.02 };
    for (const id of ids) probabilities[id] = id === challengerId ? 0.95 : 0.01;
    return { model: 'openjev', method: 'choice', challengerId, probabilities, abstain: false };
  };
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
    rankedCandidateOffsets: trace?.rankedCandidateOffsets ?? null,
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
  const rankedShapeScores = current.rankedShapeScores;
  // The label checks live in a fixture module so the failure mode they exist
  // for — a rank label that can never be contradicted — is itself regression
  // tested without the pinned artifact.
  const { rank, truthReachableByRank, labelChecks, labelsConsistent } = evaluateHoldoutLabels({
    caseDef,
    measurement: {
      rankedShapeScores,
      rankedCandidateOffsets: current.rankedCandidateOffsets,
      finalTopOffset: current.finalTopOffset,
      oracle: oracle
        ? {
          refereeStatus: oracle.referee?.status ?? null,
          probeCandidateId: oracle.probe?.candidateId ?? null,
          probeAttempted: oracle.probe?.attempted === true,
        }
        : null,
    },
  });
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
    rankedCandidateOffsets: current.rankedCandidateOffsets,
    labelChecks,
    labelsConsistent,
    // The one-probe ceiling: what the mechanism can do when the challenger is
    // known to be the labelled truth.  `oracleCeilingRescues: false` on a case
    // whose oracle probed the labelled rank is a product finding, not a label
    // failure, and it must never be reported as an unmeasured null.
    oracleCeilingRescues: oracle ? oracle.boundaryRescue === 1 : null,
    ceilingMeasured: oracle ? oracle.probe?.attempted === true : null,
    promotionEligible,
    variants,
  };
}

const cases = [];
for (const caseDef of CASES) cases.push(await evaluateCase(caseDef));

const report = {
  schema: 'hex-semantic-boundary-real-game-holdout-evaluation/v1',
  fixture: {
    schema: MANIFEST.schema ?? null,
    kind: MANIFEST.kind ?? null,
    upstream: MANIFEST.upstream ?? null,
  },
  artifact: { path: artifact, bytes: artifactIdentity.bytes, sha256: artifactIdentity.sha256, pinned: Boolean(pinned) },
  frozenPolicies: { ambiguity: AMBIGUITY, admission: ADMISSION },
  live,
  // Promotion needs a case that both misses deterministically and is rescued by
  // the gated probe, and every case's manifest labels must agree with the
  // measurement. A single labelled case is not enough to enable it.
  labelsConsistent: cases.every((entry) => entry.labelsConsistent),
  promotionEligible: cases.some((entry) => entry.promotionEligible),
  promotionBlocker: !cases.every((entry) => entry.labelsConsistent)
    ? 'At least one labelled holdout case disagrees with the measured fixture, so no case can be used as evidence.'
    : (cases.some((entry) => entry.promotionEligible)
      ? null
      : 'No labelled real-game holdout case shows a boundary rescue by the gated probe, so production stays gated.'),
  upstreamLatencyMs: {
    choice: { p50: percentile(upstreamLatency.choice, 0.5), p95: percentile(upstreamLatency.choice, 0.95) },
    noul: { p50: percentile(upstreamLatency.noul, 0.5), p95: percentile(upstreamLatency.noul, 0.95) },
  },
  cases,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
