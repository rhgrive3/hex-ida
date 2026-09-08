import assert from 'node:assert/strict';
import test from 'node:test';

import { createFunctionSummary, functionSummaryDigest } from '../../../js/analysis/summary/contract.js';

// #5710 — canonicalReturnProvenance() sorted its canonical array with
// String.prototype.localeCompare(), whose collation depends on the host
// locale. `functionSummaryDigest()` feeds caller/callee dependency identity
// and recursive fixed-point convergence, so the same semantic provenance set
// produced different digests per host (e.g. en-US vs sv-SE rank 'ä' vs 'z'
// differently). The canonical order is now defined over UTF-16 code units.

const status = { snapshotId: 'snap', analyzerId: 'summary', analyzerVersion: '1', completeness: 'complete' };

const summaryWithProvenance = (returnProvenance) => createFunctionSummary({
  functionId: 'f',
  status,
  returnProvenance,
});

test('#5710 canonical return provenance order follows UTF-16 code units, not the host collation', () => {
  const summary = summaryWithProvenance([
    { kind: 'root', rootEntityId: 'ä' },
    { kind: 'root', rootEntityId: 'z' },
  ]);
  // Code-unit order: 'z' (U+007A) < 'ä' (U+00E4). ICU collations (en-US, sv-SE)
  // disagree on this pair, so localeCompare cannot produce this order.
  assert.deepEqual(summary.returnProvenance.map((x) => x.rootEntityId), ['z', 'ä']);
});

test('#5710 the canonical order is stable and the digest is locale-independent', () => {
  const provenance = [
    { kind: 'root', rootEntityId: 'Ä' },
    { kind: 'root', rootEntityId: 'a' },
    { kind: 'root', rootEntityId: 'Z' },
    { kind: 'root', rootEntityId: 'z' },
  ];
  const first = summaryWithProvenance([...provenance].reverse());
  const second = summaryWithProvenance(provenance);
  assert.deepEqual(first.returnProvenance.map((x) => x.rootEntityId), second.returnProvenance.map((x) => x.rootEntityId));
  const expected = ['Z', 'a', 'z', 'Ä'].sort((l, r) => (l < r ? -1 : l > r ? 1 : 0));
  assert.deepEqual(first.returnProvenance.map((x) => x.rootEntityId), expected);
  assert.equal(functionSummaryDigest(first), functionSummaryDigest(second));
});

test('#5710 equal provenance entries still deduplicate and tie-breaking is unchanged', () => {
  const summary = summaryWithProvenance([
    { kind: 'root', rootEntityId: 'r1', returnIndex: 1 },
    { kind: 'root', rootEntityId: 'r1', returnIndex: 1 },
    { kind: 'arg', argIndex: 2, rootEntityId: 'r2' },
    { kind: 'arg', argIndex: 1, rootEntityId: 'r2' },
  ]);
  assert.equal(summary.returnProvenance.length, 3);
  assert.deepEqual(
    summary.returnProvenance.map((x) => [x.kind, x.argIndex ?? null, x.returnIndex ?? null, x.rootEntityId]),
    [
      ['arg', 1, null, 'r2'],
      ['arg', 2, null, 'r2'],
      ['root', null, 1, 'r1'],
    ],
  );
});
