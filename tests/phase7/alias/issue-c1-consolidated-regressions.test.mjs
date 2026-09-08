import assert from 'node:assert/strict';
import test from 'node:test';

import { createPhase7AliasSolver } from '../../../js/analysis/alias/solver.js';
import { a1RegionAlias } from '../../../js/analysis/alias/a1-region-alias.js';
import { deriveMemoryRegion } from '../../../js/analysis/alias/regions-v2.js';
import { createPointsToSet, createPointsToTarget, exactRange } from '../../../js/analysis/pointsto/lattice.js';
import { pointsToAlias } from '../../../js/analysis/pointsto/alias.js';
import { createEscapeRecord } from '../../../js/analysis/summary/escape.js';
import { createAnalysisStatus } from '../../../js/analysis/status.js';

test('#3041 unknown address spaces cannot mint distinct-address-space NoAlias authority', () => {
  const status = createAnalysisStatus({
    snapshotId: 'snap-3041',
    analyzerId: 'phase7-regression',
    analyzerVersion: '1',
    completeness: 'complete',
  });
  const setFor = (addressSpace, rootIdentity) => createPointsToSet({
    targets: [createPointsToTarget({
      addressSpace,
      rootKind: 'heap',
      rootIdentity,
      offsetRange: exactRange(0n),
    })],
  });

  const malformed = setFor({ structured: 'memory' }, 'malformed-root');
  assert.equal(malformed.targets[0].addressSpace, 'unknown');
  const canonicalRegister = setFor('register', 'register-root');
  const failClosed = pointsToAlias(malformed, canonicalRegister, {
    widthBitsLeft: 32,
    widthBitsRight: 32,
    status,
  });
  assert.notEqual(failClosed.relation, 'no');
  assert.equal(failClosed.reasonCodes.includes('distinct-address-space'), false);

  const canonicalMemory = setFor('memory', 'memory-root');
  const separated = pointsToAlias(canonicalMemory, canonicalRegister, {
    widthBitsLeft: 32,
    widthBitsRight: 32,
    status,
  });
  assert.equal(separated.relation, 'no');
  assert.ok(separated.reasonCodes.includes('distinct-address-space'));
});

test('#4283 query context signal cannot uncancel solver-bound cancellation', () => {
  const solverAbort = new AbortController();
  solverAbort.abort();
  const solver = createPhase7AliasSolver({ options: { signal: solverAbort.signal } });

  const queryLive = new AbortController();
  const regionA = { id: 'regA', kind: 'stack-fixed', offset: 0n, widthBits: 32 };
  const regionB = { id: 'regB', kind: 'stack-fixed', offset: 16n, widthBits: 32 };

  // Pass live signal in context; must still fail closed as cancelled
  const res1 = solver.alias(regionA, regionB, { signal: queryLive.signal });
  assert.equal(res1.relation, 'unknown');
  assert.equal(res1.status.completeness, 'partial');
  assert.equal(res1.status.stopReason, 'cancelled');
  assert.ok(res1.reasonCodes.includes('analysis-cancelled'));

  // Live solver cancelled by query-local signal
  const liveSolver = createPhase7AliasSolver({ options: {} });
  const queryAbort = new AbortController();
  queryAbort.abort();
  const res2 = liveSolver.alias(regionA, regionB, { signal: queryAbort.signal });
  assert.equal(res2.relation, 'unknown');
  assert.equal(res2.status.completeness, 'partial');
  assert.equal(res2.status.stopReason, 'cancelled');
  assert.ok(res2.reasonCodes.includes('analysis-cancelled'));
});

test('#4770 distinct stopReasons are mapped without being corrupted to budget-exhausted', () => {
  const regionA = { id: 'regA', kind: 'stack-fixed', offset: 0n, widthBits: 32 };
  const regionB = { id: 'regB', kind: 'stack-fixed', offset: 16n, widthBits: 32 };

  const cases = [
    { stopReason: 'cancelled', expectedReason: 'analysis-cancelled' },
    { stopReason: 'budget-exhausted', expectedReason: 'budget-exhausted' },
    { stopReason: 'timeout', expectedReason: 'timeout' },
    { stopReason: 'memory-limit', expectedReason: 'memory-limit' },
    { stopReason: 'iteration-limit', expectedReason: 'iteration-limit' },
    { stopReason: 'dependency-missing', expectedReason: 'dependency-missing' },
    { stopReason: 'dependency-mismatch', expectedReason: 'dependency-mismatch' },
    { stopReason: 'evidence-missing', expectedReason: 'evidence-missing' },
    { stopReason: 'unsupported-input', expectedReason: 'analysis-unsupported' },
  ];

  for (const { stopReason, expectedReason } of cases) {
    const status = createAnalysisStatus({
      snapshotId: 'snap_1',
      analyzerId: 'test-analyzer',
      analyzerVersion: '1.0.0',
      completeness: 'partial',
      stopReason,
    });
    const resA1 = a1RegionAlias(regionA, regionB, { status });
    assert.equal(resA1.relation, 'unknown');
    assert.deepEqual(resA1.reasonCodes, [expectedReason]);

    const solver = createPhase7AliasSolver({ options: { status } });
    const resSolver = solver.alias(regionA, regionB);
    assert.equal(resSolver.relation, 'unknown');
    assert.deepEqual(resSolver.reasonCodes, [expectedReason]);
  }
});

test('#3960 structured addressValueId is rejected and does not alias canonical points-to value', () => {
  const regionA = { id: 'regA', kind: 'heap', widthBits: 32 };
  const regionB = { id: 'regB', kind: 'heap', widthBits: 32 };

  const solver = createPhase7AliasSolver({
    ir: { functions: [] },
    options: { enableA2: true },
  });

  const structuredCases = [
    ['v1'],
    { toString: () => 'v1' },
    1,
    true,
    null,
    '',
    '   ',
  ];

  for (const badId of structuredCases) {
    const res = solver.alias(regionA, regionB, {
      leftAccess: { addressValueId: badId, widthBits: 32 },
      rightAccess: { addressValueId: 'v2', widthBits: 32 },
    });
    // With badId, A2 points-to lookup returns null and falls back to conservative A1
    assert.ok(res.relation === 'unknown' || res.relation === 'may');
    assert.equal(res.proof?.layer, undefined, 'A2 layer proof must not be minted from malformed ID');
  }
});

test('#3967 deriveMemoryRegion rejects structured offset and requires primitive integer', () => {
  const base = {
    functionId: 'fn_1',
    widthBits: 64,
    origin: { instructionIds: ['inst_1'] },
  };

  const canonical = deriveMemoryRegion({
    ...base,
    regionEvidence: {
      kind: 'stack-fixed',
      offset: 16n,
    },
  });
  assert.equal(canonical.kind, 'stack-fixed');
  assert.equal(canonical.offset, '16');

  const structuredOffsets = [
    ['16'],
    ['0x10'],
    { toString: () => '16' },
    true,
    false,
    {},
  ];

  for (const offset of structuredOffsets) {
    const malformed = deriveMemoryRegion({
      ...base,
      regionEvidence: {
        kind: 'stack-fixed',
        offset,
      },
    });
    // With malformed offset, must fail closed to non-precise kind or unknown offset
    assert.notEqual(malformed.id, canonical.id);
    assert.notEqual(malformed.kind, 'stack-fixed');
  }
});

test('#3996 createEscapeRecord strictly validates rootKey, siteId, and evidenceIds', () => {
  const valid = createEscapeRecord({
    rootKey: 'root-A',
    rootOrigin: 'local-allocation',
    reason: 'returned',
    boundary: 'return',
    siteId: 'call-A',
    evidenceIds: ['ev1', 'ev2'],
  });
  assert.equal(valid.rootKey, 'root-A');
  assert.equal(valid.siteId, 'call-A');
  assert.deepEqual(valid.evidenceIds, ['ev1', 'ev2']);

  // rootKey must be primitive non-empty string
  assert.throws(() => createEscapeRecord({ rootKey: ['root-A'], reason: 'returned', boundary: 'return' }), /invalid-root-key/);
  assert.throws(() => createEscapeRecord({ rootKey: 123, reason: 'returned', boundary: 'return' }), /invalid-root-key/);
  assert.throws(() => createEscapeRecord({ rootKey: '', reason: 'returned', boundary: 'return' }), /invalid-root-key/);

  // siteId must be nullish or primitive non-empty string
  assert.throws(() => createEscapeRecord({ rootKey: 'r', reason: 'returned', boundary: 'return', siteId: ['call-A'] }), /invalid-site-id/);
  assert.throws(() => createEscapeRecord({ rootKey: 'r', reason: 'returned', boundary: 'return', siteId: 42 }), /invalid-site-id/);

  // evidenceIds must be array of primitive non-empty strings
  assert.throws(() => createEscapeRecord({ rootKey: 'r', reason: 'returned', boundary: 'return', evidenceIds: [['ev1']] }), /invalid-evidence-ids/);
  assert.throws(() => createEscapeRecord({ rootKey: 'r', reason: 'returned', boundary: 'return', evidenceIds: [1] }), /invalid-evidence-ids/);
  assert.throws(() => createEscapeRecord({ rootKey: 'r', reason: 'returned', boundary: 'return', evidenceIds: 'ev1' }), /invalid-evidence-ids/);
});
