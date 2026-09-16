import assert from 'node:assert/strict';
import test from 'node:test';

import { createFunctionSummary } from '../../js/analysis/summary/contract.js';
import {
  solveInterproceduralSummaries,
  INTERPROCEDURAL_DEFAULT_BUDGET,
  SUMMARY_PAYLOAD_RESOURCES,
} from '../../js/analysis/summary/interprocedural.js';
import { createAnalysisStatus } from '../../js/analysis/status.js';

// #8872: the classic A3 solver bounded memory read/write rows but left the other
// three transitively propagated dimensions — `escapes`, `unknownCallEffects`,
// `registerEffects` — with no fence. An ordinary acyclic call chain therefore
// retained Θ(N²) summary rows while still publishing `complete`. The repair makes
// the aggregate retained/merged payload an explicit budgeted resource and, once a
// distinct fact is dropped, forces the owning summary (and therefore the solve) to
// lose `complete` authority rather than keep a silent prefix.

const completeStatus = () => createAnalysisStatus({
  snapshotId: 'snapshot_8872',
  analyzerId: 'phase7.summary.local',
  analyzerVersion: '1.0.0',
  completeness: 'complete',
});

const escape = (i) => ({ kind: 'return', target: `t${i}`, evidenceIds: [`e${i}`] });
const leaf = (functionId, i) => createFunctionSummary({
  functionId, directCalls: [], status: completeStatus(), escapes: [escape(i)],
});

function escapeChain(n) {
  const locals = new Map();
  for (let i = n - 1; i >= 0; i--) {
    locals.set(`f${i}`, createFunctionSummary({
      functionId: `f${i}`,
      directCalls: i + 1 < n
        ? [{ callSiteId: `c${i}`, targetEntityIds: [`f${i + 1}`], summaryId: null, effectSource: 'proven-summary' }]
        : [],
      status: completeStatus(),
      escapes: [escape(i)],
    }));
  }
  return locals;
}

const residentRows = (solved) => {
  let rows = 0;
  for (const s of solved.summaries.values()) {
    rows += s.escapes.length + s.unknownCallEffects.length + s.registerEffects.length;
  }
  return rows;
};

test('a fan-in root that exceeds its own row fence loses `complete` and reports a stable budget stop', () => {
  const locals = new Map([
    ['fn_root', createFunctionSummary({
      functionId: 'fn_root',
      directCalls: [{
        callSiteId: 'c_root',
        targetEntityIds: ['fn_l0', 'fn_l1', 'fn_l2', 'fn_l3', 'fn_l4'],
        summaryId: null,
        effectSource: 'proven-summary',
      }],
      status: completeStatus(),
    })],
    ...[0, 1, 2, 3, 4].map((i) => [`fn_l${i}`, leaf(`fn_l${i}`, i)]),
  ]);

  // Only the per-summary row fence is configured to bite; the resident/aggregate
  // ledgers are left high so this isolates the "dropped a distinct fact" path.
  const solved = solveInterproceduralSummaries({
    roots: ['fn_root'],
    localSummaries: locals,
    budget: { maxTransitiveRowsPerSummary: 3 },
  });

  const root = solved.summaries.get('fn_root');
  assert.ok(root, 'root summary must still be published');
  assert.equal(root.escapes.length, 3, 'escape dimension must be capped at the configured fence');
  assert.equal(root.status.completeness, 'truncated', 'a dropped distinct escape cannot stay complete');
  assert.equal(root.status.stopReason, 'budget-exhausted');
  // The uncontaminated leaves keep their exact authority.
  assert.equal(solved.summaries.get('fn_l0').status.completeness, 'complete');
  // And the aggregate solve result can never be stronger than its weakest summary.
  assert.equal(solved.status.completeness, 'truncated');
  assert.equal(solved.status.stopReason, 'budget-exhausted');
});

test('a chain under every fence still publishes exact escapes and stays complete', () => {
  const n = 40;
  const solved = solveInterproceduralSummaries({
    roots: ['f0'],
    localSummaries: escapeChain(n),
    snapshotId: 'snapshot_8872',
  });
  assert.equal(solved.status.completeness, 'complete');
  assert.equal(solved.status.stopReason, null);
  const root = solved.summaries.get('f0');
  // Exact union, not last-wins: all n distinct escapes reach f0.
  assert.equal(root.escapes.length, n);
  assert.deepEqual(root.escapes.map((e) => e.target).sort(), Array.from({ length: n }, (_, i) => `t${i}`).sort());
});

test('the Θ(N²) escape chain fails closed to truncated instead of OOMing as `complete`', () => {
  // At this exact base the solver retained ~1.1 M rows across 1,500 summaries
  // while still reporting `complete` (filed repro); the resident-row ledger must
  // now stop it. Before the fence the aggregate is Θ(N²); the cap is the default.
  const n = 1500;
  const unsolvedRows = (n * (n + 1)) / 2;
  assert.ok(unsolvedRows > INTERPROCEDURAL_DEFAULT_BUDGET.maxResidentSummaryRows,
    'fixture must exceed the resident fence to exercise the guard');

  const solved = solveInterproceduralSummaries({
    roots: ['f0'],
    localSummaries: escapeChain(n),
    snapshotId: 'snapshot_8872',
  });
  assert.equal(solved.status.completeness, 'truncated');
  assert.equal(solved.status.stopReason, 'budget-exhausted');
  assert.equal(solved.budgetStop?.resource, SUMMARY_PAYLOAD_RESOURCES.residentRows);
  assert.equal(solved.summaries.size, 0, 'nothing partial may be published under a dropped budget');
  assert.ok(residentRows(solved) <= INTERPROCEDURAL_DEFAULT_BUDGET.maxResidentSummaryRows);
});

test('the row fence cannot be bypassed by a caller-supplied budget', () => {
  assert.throws(
    () => solveInterproceduralSummaries({
      roots: ['f0'],
      localSummaries: escapeChain(2),
      budget: { maxTransitiveRowsPerSummary: 0 },
    }),
    (error) => error instanceof TypeError && error.message === 'interprocedural-invalid-budget-maxTransitiveRowsPerSummary',
  );
  assert.throws(
    () => solveInterproceduralSummaries({
      roots: ['f0'],
      localSummaries: escapeChain(2),
      budget: { maxTransitiveRowsPerSummary: 1.5 },
    }),
    (error) => error.message === 'interprocedural-invalid-budget-maxTransitiveRowsPerSummary',
  );
});
