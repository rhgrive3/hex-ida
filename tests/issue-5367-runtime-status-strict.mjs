// Regression for #5367: runtimeCompleted() coerced r.status/r.state through
// String(...), so arrays and objects (including custom toString()) that
// stringify to 'complete'/'success' promoted malformed runtime results into
// VERIFIED evidence. Completion status is now a marker only when it is a
// primitive string; strict boolean flags and existing fail-closed markers are
// unchanged.
import assert from 'node:assert/strict';
import { runtimeEvidenceItems } from '../js/semantic-evidence.js';

// structured status values must not promote
assert.equal(runtimeEvidenceItems({ status: ['complete'], touchedFields: [{ address: 0x20n }] }).length, 0,
  'array status must not become verified completion');
assert.equal(runtimeEvidenceItems({ status: { toString() { return 'success'; } }, takenBranches: [{ row: 1 }] }).length, 0,
  'custom toString() status must not become verified completion');
assert.equal(runtimeEvidenceItems({ state: ['completed'], takenBranches: [{ row: 1 }] }).length, 0,
  'array state alias must not become verified completion');

// primitive string aliases stay intact (case-insensitive)
{
  const items = runtimeEvidenceItems({ status: 'complete', touchedFields: [{ address: 0x20n }] });
  assert.equal(items.length, 1);
  assert.equal(items[0].code, 'runtime-field-verified');
  assert.equal(items[0].kind, 'verified');
}
{
  const items = runtimeEvidenceItems({ state: 'SUCCESS', takenBranches: [{ row: 1 }] });
  assert.equal(items.length, 1);
  assert.equal(items[0].code, 'runtime-branch-verified');
}

// strict boolean success/failure markers keep their exact semantics
assert.equal(runtimeEvidenceItems({ ok: true, touchedFields: [{ address: 0x20n }] }).length, 1);
assert.equal(runtimeEvidenceItems({ complete: true, takenBranches: [{ row: 1 }] }).length, 1);
assert.equal(runtimeEvidenceItems({ ok: false, touchedFields: [{ address: 0x20n }] }).length, 0);
assert.equal(runtimeEvidenceItems({ status: 'timeout', touchedFields: [{ address: 0x20n }] }).length, 0);
assert.equal(runtimeEvidenceItems({ truncated: true, touchedFields: [{ address: 0x20n }] }).length, 0);

console.log('issue #5367 runtime completion status strictness regression: PASS');
