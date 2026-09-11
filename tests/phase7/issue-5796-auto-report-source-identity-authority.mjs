// Regression for #5796: auto-report identity boundary must treat an existing
// sourceIdentity as producer-time authority — never relabel it with the
// setter-time live identity, and never bind a foreign-provenance report as
// current.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  installAutoReportIdentityBoundary,
  __autoReportIdentityInternalsForTests as internals,
} from '../../js/analysis/auto-report-identity.js';

function fakeApp(binaryId, gen, { sliceIndex = 0, projectRevision = 0 } = {}) {
  return {
    backend: { binaryId, gen },
    store: {
      get(key) {
        if (key === 'sliceIndex') return sliceIndex;
        if (key === 'project') return { revision: projectRevision };
        return null;
      },
    },
  };
}

const identityA = Object.freeze({
  binaryId: 'binary-A',
  sliceIndex: 0,
  analysisEpoch: 1,
  projectRevision: 0,
  snapshotId: null,
});

test('#5796 bindValue preserves a matching producer-time sourceIdentity verbatim', () => {
  const app = fakeApp('binary-A', 1);
  const value = {
    report: { findings: ['ok'] },
    sourceIdentity: { ...identityA },
  };
  const bound = internals.bindValue(app, value, null);
  assert.equal(bound.identity, value.sourceIdentity);
  assert.equal(bound.value.sourceIdentity.binaryId, 'binary-A');
  assert.equal(bound.value.sourceIdentity.analysisEpoch, 1);
});

test('#5796 bindValue refuses to relabel a binary-A report onto binary B', () => {
  const appB = fakeApp('binary-B', 2);
  const stale = {
    report: { findings: ['from-A'] },
    sourceIdentity: { ...identityA },
  };
  const bound = internals.bindValue(appB, stale, null);
  assert.equal(bound.identity, null);
  // Provenance must survive untouched: no relabelling in place.
  assert.equal(stale.sourceIdentity.binaryId, 'binary-A');
  assert.equal(stale.sourceIdentity.analysisEpoch, 1);
});

test('#5796 bindValue refuses relabelling across slice/epoch/revision drift', () => {
  const drifted = [
    fakeApp('binary-A', 1, { sliceIndex: 1 }),
    fakeApp('binary-A', 2),
    fakeApp('binary-A', 1, { projectRevision: 5 }),
  ];
  for (const app of drifted) {
    const bound = internals.bindValue(app, { report: {}, sourceIdentity: { ...identityA } }, null);
    assert.equal(bound.identity, null);
  }
});

test('#5796 setter keeps a stale provenance report out of app.autoReport', async () => {
  const app = fakeApp('binary-B', 2);
  app.analysisQueries = {
    snapshot: async () => ({ snapshotId: 'snap-B' }),
  };
  installAutoReportIdentityBoundary(app);
  app.autoReport = {
    report: { findings: ['late-arrival-from-A'] },
    sourceIdentity: { ...identityA },
  };
  // Even if the binary-B snapshot arrives and the getter re-evaluates, the
  // A-provenance report must never surface as B's current report.
  await app.analysisQueries.snapshot();
  assert.equal(app.autoReport, null);
  assert.equal(app.historicalAutoReport, null);
});

test('#5796 a report-level sourceIdentity is honoured as authority too', () => {
  const appB = fakeApp('binary-B', 2);
  const stale = {
    report: { findings: ['from-A'], sourceIdentity: { ...identityA } },
  };
  const bound = internals.bindValue(appB, stale, null);
  assert.equal(bound.identity, null);
  assert.equal(stale.report.sourceIdentity.binaryId, 'binary-A');
});

test('#5796 a malformed sourceIdentity never becomes authority', () => {
  const app = fakeApp('binary-A', 1);
  const malformed = [
    'binary-A',
    42,
    { binaryId: 'binary-A' },
    { ...identityA, analysisEpoch: -1 },
    { ...identityA, sliceIndex: '0' },
  ];
  for (const bad of malformed) {
    const bound = internals.bindValue(app, { report: {}, sourceIdentity: bad }, null);
    assert.equal(bound.identity, null, `expected rejection for ${JSON.stringify(bad)}`);
  }
});

test('#5796 snapshot mismatch between source identity and wrapper is rejected at bind time', () => {
  const app = fakeApp('binary-A', 1);
  const value = {
    report: { findings: [], snapshotId: 'snap-9' },
    sourceIdentity: { ...identityA, snapshotId: 'snap-1' },
  };
  const bound = internals.bindValue(app, value, null);
  assert.equal(bound.identity, null);
});

test('#5796 legacy reports without sourceIdentity keep setter-time binding', () => {
  const app = fakeApp('binary-A', 1);
  const bound = internals.bindValue(app, { report: { findings: [] } }, null);
  assert.equal(bound.identity.binaryId, 'binary-A');
  assert.equal(bound.identity.analysisEpoch, 1);
  assert.equal(bound.value.report.sourceIdentity.binaryId, 'binary-A');
});
