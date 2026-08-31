import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDiscoveryEvidence,
} from '../../../js/analysis/discovery/candidates.js';
import {
  fuseFunctionCandidates,
} from '../../../js/analysis/discovery/fusion.js';
import {
  referenceProducer,
} from '../../../js/analysis/discovery/producers.js';

const at = (candidates, address) =>
  candidates.find((candidate) => BigInt(candidate.start) === BigInt(address));

const ev = (kind, start, extra = {}) => createDiscoveryEvidence({
  kind, start, evidenceIds: [`${kind}:${start}`], ...extra,
});

/**
 * HEX-X-03 phase-1 frozen matrix: overlap / code-data / relocation / reparse
 * cases over the P7-6 discovery fusion contract. The rule under test is the
 * ledger's danger line: a ranked candidate must not become exact truth, and
 * ambiguity is recorded, never resolved by preference.
 */

// ---------- User Story 1: overlap cases stay conflicts ----------

test('X-03 matrix: a region swallowing another start records the conflict and withdraws extent', () => {
  const evidence = [
    ev('loader-function-start', 0x1000, {
      extentRole: 'complete',
      regions: [{ start: 0x1000, end: 0x1100 }],
    }),
    ev('loader-function-start', 0x1080, {
      extentRole: 'complete',
      regions: [{ start: 0x1080, end: 0x1100 }],
    }),
  ];
  const { candidates, status } = fuseFunctionCandidates(evidence, {});
  assert.equal(status.completeness, 'complete');
  const outer = at(candidates, 0x1000);
  const inner = at(candidates, 0x1080);
  // Both candidates survive; the outer one's extent claim is withdrawn.
  assert.ok(outer, 'outer candidate survives');
  assert.ok(inner, 'swallowed start survives as its own candidate');
  assert.equal(inner.startState, 'exact', 'the inner start is not in dispute');
  assert.equal(outer.extentState, 'unknown',
    'a swallowing extent must be withdrawn, not preferred over the inner start');
  assert.ok(outer.conflicts.some((c) => c.detail.includes('contains another function start')));
});

test('X-03 matrix: partial overlap resets both extents symmetrically', () => {
  const evidence = [
    ev('unwind-entry', 0x2000, {
      extentRole: 'complete',
      regions: [{ start: 0x2000, end: 0x2100 }],
    }),
    ev('unwind-entry', 0x2080, {
      extentRole: 'complete',
      regions: [{ start: 0x2080, end: 0x2140 }],
    }),
  ];
  const { candidates } = fuseFunctionCandidates(evidence, {});
  const a = at(candidates, 0x2000);
  const b = at(candidates, 0x2080);
  assert.equal(a.extentState, 'unknown');
  assert.equal(b.extentState, 'unknown');
  // The swallowing candidate carries both conflict shapes; the swallowed one
  // carries the overlap. Both extents are withdrawn — the ambiguity is not
  // resolved by preferring either candidate.
  assert.ok(a.conflicts.some((c) => c.detail.includes('contains another function start')));
  assert.ok(a.conflicts.some((c) => c.detail.includes('overlaps another candidate')));
  assert.ok(b.conflicts.some((c) => c.detail.includes('overlaps another candidate')));
  assert.equal(a.extentState, b.extentState,
    'both sides end at the same conservative extent state');
});

test('X-03 matrix: boundary-adjacent functions do not conflict', () => {
  const evidence = [
    ev('loader-function-start', 0x3000, {
      extentRole: 'complete',
      regions: [{ start: 0x3000, end: 0x3040 }],
    }),
    ev('loader-function-start', 0x3040, {
      extentRole: 'complete',
      regions: [{ start: 0x3040, end: 0x3080 }],
    }),
  ];
  const { candidates } = fuseFunctionCandidates(evidence, {});
  const a = at(candidates, 0x3000);
  const b = at(candidates, 0x3040);
  assert.equal(a.extentState, 'exact', 'touching ranges do not overlap');
  assert.equal(b.extentState, 'exact');
  assert.equal(a.conflicts.length, 0);
  assert.equal(b.conflicts.length, 0);
});

test('X-03 matrix: a shared range stays representable as ambiguous ownership', () => {
  // Two unwind entries both claiming the shared epilogue range as partial
  // evidence must not be resolved into one owner.
  const evidence = [
    ev('unwind-entry', 0x4000, {
      extentRole: 'partial',
      regions: [{ start: 0x4000, end: 0x4038 }, { start: 0x4078, end: 0x4080, ownership: 'shared' }],
    }),
    ev('unwind-entry', 0x4040, {
      extentRole: 'partial',
      regions: [{ start: 0x4040, end: 0x4080, ownership: 'shared' }],
    }),
  ];
  const { candidates } = fuseFunctionCandidates(evidence, {});
  const a = at(candidates, 0x4000);
  const b = at(candidates, 0x4040);
  assert.ok(a && b, 'both candidates survive');
  // No conflict is manufactured for agreeing shared claims; the union is kept.
  const aShared = a.regions.filter((r) => r.ownership === 'shared');
  assert.ok(aShared.length > 0 || a.extentState === 'unknown',
    'shared ownership is either preserved or explicitly unknown, never silently exclusive');
});

// ---------- User Story 2: code-data ambiguity ----------

test('X-03 matrix: a vtable entry into a function body never mints an exact start', () => {
  const image = { vtableEntries: [{ address: 0x5020 }] };
  const produced = referenceProducer.produce({ image });
  assert.equal(produced.length, 1);
  assert.equal(produced[0].authority, 'corroborating');

  const evidence = [
    ev('loader-function-start', 0x5000, {
      extentRole: 'complete',
      regions: [{ start: 0x5000, end: 0x5040 }],
    }),
    ...produced,
  ];
  const { candidates } = fuseFunctionCandidates(evidence, {});
  const mid = at(candidates, 0x5020);
  if (mid) {
    assert.equal(mid.startState, 'heuristic',
      'one data reference into a body is not a function start');
  }
  const real = at(candidates, 0x5000);
  assert.ok(real, 'the real function is untouched');
  assert.equal(real.startState, 'exact');
});

test('X-03 matrix: a relocation target mid-function stays corroborating-only', () => {
  const image = { relocationTargets: [{ address: 0x6030 }] };
  const produced = referenceProducer.produce({ image });
  assert.equal(produced[0].kind, 'relocation-target');
  assert.equal(produced[0].authority, 'corroborating');

  const { candidates } = fuseFunctionCandidates(produced, {});
  const candidate = at(candidates, 0x6030);
  assert.ok(candidate, 'the reference is still raised as a candidate');
  assert.equal(candidate.startState, 'heuristic',
    'a single corroborator cannot reach probable without a second producer');
});

// ---------- User Story 3: authority ladder + reparse determinism ----------

test('X-03 matrix: heuristic-only evidence never upgrades', () => {
  const evidence = [
    ev('prologue-candidate', 0x7000),
    ev('alignment-heuristic', 0x7000),
  ];
  const { candidates } = fuseFunctionCandidates(evidence, {});
  assert.equal(at(candidates, 0x7000).startState, 'heuristic',
    'two heuristics agreeing still do not outrank their authority');
});

test('X-03 matrix: two corroborators reach probable, never exact', () => {
  // Corroboration counts independent producers: evidence without an explicit
  // producerId is the same 'unknown' producer, so the two kinds below agree
  // but do not corroborate. Distinct producer ids are what make it probable.
  const same = [
    ev('symbol-table', 0x8000),
    ev('direct-call-target', 0x8000),
  ];
  assert.equal(at(fuseFunctionCandidates(same, {}).candidates, 0x8000).startState, 'heuristic',
    'one producer naming two kinds is still one voice');

  const distinct = [
    createDiscoveryEvidence({ kind: 'symbol-table', start: 0x8000, evidenceIds: ['sym:0x8000'], producerId: 'p.symbols' }),
    createDiscoveryEvidence({ kind: 'direct-call-target', start: 0x8000, evidenceIds: ['call:0x8000'], producerId: 'p.calls' }),
  ];
  assert.equal(at(fuseFunctionCandidates(distinct, {}).candidates, 0x8000).startState, 'probable',
    'two independent corroborating producers reach probable');
});

test('X-03 matrix: one authoritative producer mints exact', () => {
  const evidence = [
    ev('export', 0x9000),
    ev('symbol-table', 0x9000),
  ];
  const { candidates } = fuseFunctionCandidates(evidence, {});
  assert.equal(at(candidates, 0x9000).startState, 'exact');
});

test('X-03 matrix: reparse in reverse order yields identical states and digests', () => {
  const forward = [
    ev('loader-function-start', 0xa000, {
      extentRole: 'complete',
      regions: [{ start: 0xa000, end: 0xa040 }],
    }),
    ev('unwind-entry', 0xa000, {
      extentRole: 'partial',
      regions: [{ start: 0xa000, end: 0xa020 }],
    }),
    ev('prologue-candidate', 0xa040),
    ev('loader-function-start', 0xa040, {
      extentRole: 'complete',
      regions: [{ start: 0xa040, end: 0xa080 }],
    }),
  ];
  const first = fuseFunctionCandidates(forward, {});
  const second = fuseFunctionCandidates([...forward].reverse(), {});
  assert.deepEqual(
    first.candidates.map((c) => [c.start, c.startState, c.extentState, c.digest]),
    second.candidates.map((c) => [c.start, c.startState, c.extentState, c.digest]),
    'evidence order must not change the published answer',
  );
});
