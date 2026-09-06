import assert from 'node:assert/strict';
import test from 'node:test';

import { ALIAS_QUERIES_V2 } from '../../tools/validation/phase7/scoring.mjs';
import { buildAliasV2SourceEvidence } from '../../tools/validation/competitive/alias-v2-source-evidence.mjs';

const ALIAS_METRIC_IDS = [
  'alias-v2-exact-precision',
  'alias-v2-exact-recall',
  'alias-v2-false-must-alias',
  'alias-v2-false-no-alias',
];

test('alias v2 source evidence binds the frozen corpus and leaves profile promotion unchanged', () => {
  const evidence = buildAliasV2SourceEvidence();

  assert.equal(evidence.schemaVersion, 'hex-competitive-alias-v2-source-evidence/v1');
  assert.equal(evidence.recordType, 'ALIAS_V2_SOURCE_DETERMINISTIC_FIXTURE_EVIDENCE');
  assert.match(evidence.product.gitSha, /^[0-9a-f]{40}$/);
  assert.match(evidence.product.treeSha, /^[0-9a-f]{40}$/);
  assert.equal(evidence.product.cleanWorktree, true);

  assert.deepEqual(evidence.profile.metricIds.slice(0, 4), ALIAS_METRIC_IDS);
  assert.equal(evidence.profile.aliasGroundTruthStatus, 'legacy-unproven');
  assert.equal(evidence.profile.aliasGroundTruthAuthority, 'deterministic-fixture');
  assert.equal(evidence.profile.promotionPerformed, false);
  assert.deepEqual(evidence.groundTruth, {
    kind: 'nonbinary-source-fixture',
    authority: 'deterministic-fixture',
    status: 'legacy-unproven',
    binaryScored: false,
    twinManifest: null,
  });

  assert.equal(evidence.corpus.id, 'phase7-alias-memory-corpus-v2');
  assert.equal(evidence.corpus.version, 2);
  assert.equal(evidence.corpus.queryCount, ALIAS_QUERIES_V2.length);
  assert.equal(evidence.corpus.queryCount, 30);
  assert.match(evidence.corpus.querySetDigestSha256, /^[0-9a-f]{64}$/);
  assert.equal(evidence.sources.querySet.sha256, evidence.sources.fixtureBuilder.sha256);
  assert.equal(evidence.sources.querySet.querySetDigestSha256, evidence.corpus.querySetDigestSha256);
  assert.equal(evidence.sources.scorer.scoringId, 'phase7.scoring.v2');
  assert.equal(evidence.sources.scorer.scoringVersion, '2.0.0');
  assert.equal(evidence.sources.scorer.truthGeneratorId, 'phase7.corpus.declared-truth.v2');
  assert.equal(evidence.sources.scorer.truthGeneratorVersion, '2.0.0');
  for (const source of Object.values(evidence.sources)) assert.match(source.sha256, /^[0-9a-f]{64}$/);

  assert.deepEqual(evidence.metricRows.map((row) => row.metricId), ALIAS_METRIC_IDS);
  assert.deepEqual(evidence.metricRows.map((row) => row.candidateValue), [1, 1, 0, 0]);
  assert.deepEqual(evidence.metricRows.map((row) => row.groundTruth.status), Array(4).fill('legacy-unproven'));
  assert.deepEqual(evidence.metricRows.map((row) => row.evidenceDisposition), Array(4).fill('observed-profile-unchanged'));
  assert.equal(evidence.candidateResult.queryCount, 30);
  assert.equal(evidence.candidateResult.unknownCount, 0);
  assert.equal(evidence.queryResults.length, 30);
  assert.deepEqual(evidence.queryResults.map((query) => query.id), ALIAS_QUERIES_V2.map((query) => query.id));
  assert.deepEqual(evidence.queryResults.map((query) => query.candidateRelation), evidence.candidateResult.perQuery.map((query) => query.relation));
  assert.deepEqual(evidence.queryResults.map((query) => query.baselineRelation), evidence.baselineResult.perQuery.map((query) => query.relation));
  assert.equal(evidence.disposition.profileStatusUnchanged, true);
  assert.equal(evidence.disposition.acceptancePerformed, false);
  assert.equal(evidence.disposition.acceptance, false);
});
