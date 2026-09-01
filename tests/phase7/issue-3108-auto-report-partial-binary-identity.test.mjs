import test from 'node:test';
import assert from 'node:assert/strict';

import { __autoReportIdentityInternalsForTests } from '../../js/analysis/auto-report-identity.js';

const { sameIdentity } = __autoReportIdentityInternalsForTests;

const base = { analysisEpoch: 1, sliceIndex: 0, projectRevision: 1 };

test('issue-3108: one-sided binaryId is stale, never current authority', () => {
  // Bound report knows a binary; live identity lost it (or vice versa). The old
  // truthiness probe skipped the comparison and treated the report as current,
  // letting a different binary's stale report ride along as Results authority.
  assert.equal(sameIdentity({ ...base, binaryId: 'bin-a' }, { ...base, binaryId: null }), false);
  assert.equal(sameIdentity({ ...base, binaryId: null }, { ...base, binaryId: 'bin-a' }), false);
  assert.equal(sameIdentity({ ...base, binaryId: 'bin-a' }, { ...base, binaryId: 'bin-b' }), false, 'different binaries stay stale');
});

test('issue-3108: both-missing binaryId keeps the compatibility behavior', () => {
  assert.equal(sameIdentity({ ...base, binaryId: null }, { ...base, binaryId: null }), true);
});

test('issue-3108: equal known binaryId stays current', () => {
  assert.equal(sameIdentity({ ...base, binaryId: 'bin-a' }, { ...base, binaryId: 'bin-a' }), true);
});
