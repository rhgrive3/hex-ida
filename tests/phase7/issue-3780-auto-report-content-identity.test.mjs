import test from 'node:test';
import assert from 'node:assert/strict';
import {
  installAutoReportIdentityBoundary,
  __autoReportIdentityInternalsForTests,
} from '../../js/analysis/auto-report-identity.js';

const { liveIdentity, sameIdentity } = __autoReportIdentityInternalsForTests;

function makeApp(backend = {}, values = new Map()) {
  return {
    backend,
    store: { get(key) { return values.get(key) ?? null; } },
  };
}

test('raw contentHash and the same canonical BinaryId share auto-report identity', () => {
  const digest = 'a'.repeat(64);
  const app = makeApp({ contentHash:digest });
  installAutoReportIdentityBoundary(app);
  app.autoReport = { report:{ kind:'analysis' } };

  const bound = app.autoReport;
  assert.ok(bound);
  assert.equal(bound.sourceIdentity.binaryId, `bin_sha256_${digest}`);

  app.backend.binaryId = `bin_sha256_${digest}`;
  assert.ok(app.autoReport);
  assert.equal(app.historicalAutoReport, null);
});

test('different canonical content identity still invalidates the bound report', () => {
  const first = 'a'.repeat(64);
  const second = 'b'.repeat(64);
  const app = makeApp({ contentHash:first });
  installAutoReportIdentityBoundary(app);
  app.autoReport = { report:{ kind:'analysis' } };

  const bound = app.autoReport;
  app.backend.binaryId = `bin_sha256_${second}`;
  assert.equal(app.autoReport, null);
  assert.equal(app.historicalAutoReport, bound);
});

test('malformed contentHash never becomes binary identity authority', () => {
  for (const malformed of [{}, [], true, '', 'not-a-sha256']) {
    assert.equal(liveIdentity(makeApp({ contentHash:malformed })).binaryId, null);
  }
});

test('canonical binaryId and non-binary identity checks remain exact', () => {
  const digest = 'c'.repeat(64);
  const app = makeApp({ binaryId:`bin_sha256_${digest}`, gen:4 });
  const bound = liveIdentity(app);
  assert.equal(bound.binaryId, `bin_sha256_${digest}`);

  app.backend.gen = 5;
  const live = liveIdentity(app);
  assert.equal(sameIdentity(bound, live), false);
});