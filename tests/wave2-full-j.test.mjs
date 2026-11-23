import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STOP,
  costOf,
  runHeuristic,
  withinBudget,
} from '../scripts/pinpoint-probe-scheduler.mjs';
import { evidenceSummary } from '../scripts/aggregate-pinpoint-confidence-plan-a.mjs';

function makeRow() {
  return {
    queryId: 'testbin|partial|health',
    binary: 'testbin',
    mode: 'partial',
    label: 'health',
    expectedClass: 'Player',
    expectedField: 'health',
    universe: 2,
    priorCandidates: 2,
    candidates: [
      {
        key: 'Player.health',
        className: 'Player',
        fieldName: 'health',
        evidence: [
          { code: 'name-hint', strength: 0.4 },
        ],
      },
      {
        key: 'Player.mana',
        className: 'Player',
        fieldName: 'mana',
        evidence: [
          { code: 'name-hint', strength: 0.3 },
        ],
      },
    ],
  };
}

function makeProbe(probeId, {
  candidateId = 'Player.health',
  estimatedAnalyzeCalls = 1,
  analysisCalls = 1,
  estimatedElapsedMs = 5,
  elapsedMs = 5,
  observations = [],
} = {}) {
  return {
    probeId,
    candidateId,
    family: 'getter-verification',
    estimatedCost: estimatedAnalyzeCalls,
    estimatedAnalyzeCalls,
    analysisCalls,
    estimatedElapsedMs,
    elapsedMs,
    unsupported: false,
    baselineCovered: false,
    observations,
  };
}

test('pinpoint-probe-scheduler: runHeuristic uses actual costOf(sequence).calls and stops with STOP.BUDGET instead of crashing', () => {
  const row = makeRow();
  const budget = { maxProbeCount: 6, maxAnalyzeCalls: 3, maxElapsedMs: 1000 };
  const probes = [
    // Estimated 1 call, actually consumes all 3 calls.
    makeProbe('p1', { estimatedAnalyzeCalls: 1, analysisCalls: 3 }),
    // Estimated 1 call; previously withinEstimatedBudget saw 1 + 1 <= 3 and ran p2,
    // causing evaluateSequence to throw Error('sequence exceeds budget').
    makeProbe('p2', { estimatedAnalyzeCalls: 1, analysisCalls: 1 }),
  ];

  const result = runHeuristic(row, probes, 'H1', {}, budget);
  assert.equal(result.stopReason, STOP.BUDGET);
  assert.deepEqual(result.probeIds, ['p1']);
  assert.equal(costOf(probes.filter((p) => result.probeIds.includes(p.probeId))).calls, 3);
  assert.ok(withinBudget(probes.filter((p) => result.probeIds.includes(p.probeId)), budget));
});

test('pinpoint-probe-scheduler: runHeuristic stops with STOP.BUDGET before pushing a probe whose actual analysisCalls exceeds remaining budget', () => {
  const row = makeRow();
  const budget = { maxProbeCount: 6, maxAnalyzeCalls: 3, maxElapsedMs: 1000 };
  const probes = [
    // Consumes 2 actual calls (remaining = 1).
    makeProbe('p1', { estimatedAnalyzeCalls: 1, analysisCalls: 2 }),
    // Estimated 1 call (2 + 1 <= 3, so selected), but actual analysisCalls = 2 > remaining (1).
    makeProbe('p2', { estimatedAnalyzeCalls: 1, analysisCalls: 2 }),
  ];

  const result = runHeuristic(row, probes, 'H1', {}, budget);
  assert.equal(result.stopReason, STOP.BUDGET);
  assert.deepEqual(result.probeIds, ['p1']);
  assert.equal(result.cost.calls, 2);
});

test('pinpoint-probe-scheduler: runHeuristic stops with STOP.BUDGET instead of crashing when a probe exceeds both elapsedMs and analysisCalls', () => {
  const row = makeRow();
  const budget = { maxProbeCount: 6, maxAnalyzeCalls: 3, maxElapsedMs: 100 };
  const probes = [
    // Consumes 2 calls and 60ms (remaining: 1 call, 40ms).
    makeProbe('p1', { estimatedAnalyzeCalls: 1, analysisCalls: 2, estimatedElapsedMs: 10, elapsedMs: 60 }),
    // Within estimated budget (2 + 1 <= 3 calls, 60 + 10 <= 100ms),
    // but actual analysisCalls (2 > 1) and elapsedMs (80 > 40) both exceed remaining budget.
    makeProbe('p2', { estimatedAnalyzeCalls: 1, analysisCalls: 2, estimatedElapsedMs: 10, elapsedMs: 80 }),
  ];

  const result = runHeuristic(row, probes, 'H1', {}, budget);
  assert.equal(result.stopReason, STOP.BUDGET);
  assert.deepEqual(result.probeIds, ['p1']);
  assert.equal(result.cost.calls, 2);
  assert.equal(result.cost.elapsedMs, 60);
  assert.ok(withinBudget(probes.filter((p) => result.probeIds.includes(p.probeId)), budget));
});

test('pinpoint-probe-scheduler: runHeuristic still stops with STOP.TIMEOUT when only elapsedMs exceeds remaining budget', () => {
  const row = makeRow();
  const budget = { maxProbeCount: 6, maxAnalyzeCalls: 3, maxElapsedMs: 100 };
  const probes = [
    makeProbe('p1', { estimatedAnalyzeCalls: 1, analysisCalls: 1, estimatedElapsedMs: 10, elapsedMs: 60 }),
    makeProbe('p2', { estimatedAnalyzeCalls: 1, analysisCalls: 1, estimatedElapsedMs: 10, elapsedMs: 80 }),
  ];

  const result = runHeuristic(row, probes, 'H1', {}, budget);
  assert.equal(result.stopReason, STOP.TIMEOUT);
  assert.deepEqual(result.probeIds, ['p1', 'p2']);
  assert.equal(result.cost.calls, 2);
  assert.equal(result.cost.elapsedMs, 100);
});

test('pinpoint-probe-scheduler: runHeuristic still runs all probes within budget when actual calls match estimates', () => {
  const row = makeRow();
  const budget = { maxProbeCount: 2, maxAnalyzeCalls: 4, maxElapsedMs: 1000 };
  const probes = [
    makeProbe('p1', { estimatedAnalyzeCalls: 1, analysisCalls: 1 }),
    makeProbe('p2', { estimatedAnalyzeCalls: 1, analysisCalls: 1 }),
    makeProbe('p3', { estimatedAnalyzeCalls: 1, analysisCalls: 1 }),
  ];

  const result = runHeuristic(row, probes, 'H1', {}, budget);
  assert.equal(result.stopReason, STOP.BUDGET);
  assert.equal(result.probeIds.length, 2);
  assert.equal(result.cost.calls, 2);
});

test('aggregate-pinpoint-confidence-plan-a: evidenceSummary handles null/missing evidence.group without TypeError during topEvidenceCodes sort', () => {
  const rows = [
    {
      groups: ['metadata'],
      topCorrect: true,
      evidence: [
        { code: 'code-null-a', group: null },
        { code: 'code-undef-b' },
        { code: 'code-str-c', group: 'structural' },
      ],
    },
    {
      groups: ['structural'],
      topCorrect: false,
      evidence: [
        { code: 'code-str-d', group: 'dataflow' },
      ],
    },
  ];

  const summary = evidenceSummary(rows);
  assert.deepEqual(Object.keys(summary.topEvidenceCodes), [
    'code-null-a',
    'code-undef-b',
    'code-str-d',
    'code-str-c',
  ]);
  assert.equal(summary.topEvidenceCodes['code-null-a'].group, null);
  assert.equal(summary.topEvidenceCodes['code-undef-b'].group, null);
  assert.equal(summary.topEvidenceCodes['code-str-c'].group, 'structural');
  assert.equal(summary.topEvidenceCodes['code-str-d'].group, 'dataflow');
});
