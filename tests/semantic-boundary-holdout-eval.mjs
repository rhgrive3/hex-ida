/*
 * Phase-0/1 measurement harness for the checked-in labelled boundary fixture.
 *
 * This file intentionally does not contact OpenJev. Its deterministic mock
 * answers make the accounting/replay contract testable, but its output is
 * explicitly synthetic and must not be used to promote the probe path. A real
 * labelled game-analysis holdout can supply the same four variants and
 * aggregate their records before an ambiguity/admission policy is frozen.
 */
import {
  TRUE_OFFSET,
  acceptedChoice,
  acceptedNoul,
  runSyntheticBoundaryCase,
} from './fixtures/semantic-boundary-holdout.mjs';

function percentile(values, q) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1))];
}

function isTrueTop(run) {
  return run.result.top?.offset === TRUE_OFFSET;
}

function falseLikely(run) {
  return run.result.verdict === 'likely' && !isTrueTop(run);
}

async function measure(name, { mode = 'shadow', answer = null } = {}) {
  let apiCalls = 0;
  const callbackTimes = [];
  const referee = answer == null ? undefined : async () => {
    apiCalls++;
    const start = performance.now();
    const value = answer();
    callbackTimes.push(performance.now() - start);
    return value;
  };
  const run = await runSyntheticBoundaryCase({ mode, referee });
  const targets = run.trace?.verificationTargets || [];
  const challengerIsTruth = run.trace?.referee?.challengerId === 'c1';
  return {
    name,
    trueDeterministicRank: 5,
    candidateCount: run.trace?.candidateCount ?? null,
    d4Score: run.trace?.d4Score ?? null,
    d5Score: run.trace?.d5Score ?? null,
    d4D5Gap: run.trace?.gap ?? null,
    // This is the actual current verification set, not a semantic suggestion.
    verificationHitAt4: targets.includes('d5') ? 1 : 0,
    boundaryRescue: isTrueTop(run) ? 1 : 0,
    shadowChallengerCorrect: challengerIsTruth ? 1 : 0,
    probePrecision: run.trace?.probe?.attempted
      ? (run.trace.probe.success && isTrueTop(run) ? 1 : 0)
      : null,
    finalTop1: isTrueTop(run) ? 1 : 0,
    wrongTop1: isTrueTop(run) ? 0 : 1,
    falseLikely: falseLikely(run) ? 1 : 0,
    analyzeCalls: run.analyzeCalls,
    apiCallRate: apiCalls,
    verificationTargets: targets,
    firstVerifiedCandidate: run.trace?.firstVerifiedCandidate ?? null,
    verdict: run.result.verdict,
    referee: run.trace?.referee ?? null,
    // The mock measures local callback overhead only. No live OpenJev key or
    // labelled game corpus is present here, so real network p50/p95 is unknown.
    mockedCallbackLatencyMs: {
      p50: percentile(callbackTimes, 0.5),
      p95: percentile(callbackTimes, 0.95),
    },
  };
}

const report = {
  schema: 'hex-semantic-boundary-holdout-evaluation/v1',
  fixture: 'synthetic-labelled-d5-boundary-counterexample',
  promotionEligible: false,
  promotionBlocker: 'No real labelled game-analysis holdout or live OpenJev latency sample is checked into this repository.',
  variants: [
    await measure('current-d1-d4'),
    await measure('shadow-choice', { answer: () => acceptedChoice('c1') }),
    await measure('shadow-parallel-noul', { answer: () => acceptedNoul('c1') }),
    await measure('gated-one-probe', { mode: 'probe', answer: () => acceptedChoice('c1') }),
  ],
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
