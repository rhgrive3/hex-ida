import assert from 'node:assert/strict';
import test from 'node:test';

import profileJson from '../../tools/validation/competitive/profile.json' with { type: 'json' };
import {
  verifyCompetitiveProfile,
  verifyCompetitiveScorecard,
} from '../../tools/validation/competitive/verify.mjs';
import { createTwinManifest, generateTwinManifest } from '../../tools/validation/competitive/twin-manifest.mjs';
import { buildTwinFixture, removeTwinFixture } from './twin-fixture.mjs';

const profile = profileJson;
const TEST_HEAD = 'a'.repeat(40);
const TEST_TREE = 'b'.repeat(40);

test('competitive profile names same-binary truth and keeps competitor output outside authority', () => {
  assert.equal(profile.schemaVersion, 'hex-competitive-profile/v2');
  assert.equal(profile.groundTruthContract?.schemaVersion, 'hex-competitive-ground-truth/v1');
  assert.equal(profile.groundTruthContract?.binaryRowsRequireSameBinaryTwin, true);
  assert.equal(profile.groundTruthContract?.competitorOutputIsNeverAuthority, true);
  assert.ok(Array.isArray(profile.groundTruthContract?.legacyStatuses));
  assert.ok(profile.groundTruthContract.legacyStatuses.includes('UNMEASURED'));
  assert.ok(profile.groundTruthContract.legacyStatuses.includes('legacy-unproven'));
  assert.doesNotThrow(() => verifyCompetitiveProfile(profile));
});

test('legacy binary corpus rows remain explicitly UNMEASURED or legacy-unproven', () => {
  const allowed = new Set(profile.groundTruthContract.legacyStatuses);
  const metrics = Object.entries(profile.metrics);
  assert.ok(metrics.length > 0, 'profile must declare a non-empty denominator');
  for (const [metricId, metric] of metrics) {
    const truth = metric.groundTruth;
    assert.ok(truth && typeof truth === 'object', `${metricId}: groundTruth metadata is required`);
    if (truth.binaryScored === true || truth.twinManifest == null) {
      assert.ok(allowed.has(truth.status), `${metricId}: legacy status must be explicit`);
      assert.notEqual(truth.status, 'EXACT', `${metricId}: legacy row was silently promoted`);
      assert.notEqual(truth.status, 'PROVEN', `${metricId}: legacy row was silently promoted`);
    }
  }
});

function fullScorecard() {
  const entries = Object.keys(profile.metrics).sort().map((metricId) => ({
    ...(() => {
      const groundTruth = profile.metrics[metricId].groundTruth;
      return {
        groundTruth,
        groundTruthAuthority: groundTruth.authority,
        groundTruthStatus: groundTruth.status,
        twinManifest: groundTruth.twinManifest,
      };
    })(),
    metricId,
    corpusId: profile.metrics[metricId].corpusWorkloadIds[0],
    inputIdentity: `unmeasured-${metricId}`,
    functionIdentity: null,
    hexVersion: TEST_HEAD,
    referenceTool: 'none',
    referenceVersion: 'none',
    configuration: 'unmeasured',
    runtimeClass: profile.runtimeHardwareClass,
    runPolicy: 'exact',
    hexValue: null,
    referenceValue: null,
    comparison: 'UNMEASURED',
    historical: null,
    evidenceRefs: [],
  }));
  return {
    schemaVersion: 'hex-competitive-scorecard/v2',
    profileId: profile.profileId,
    gitSha: TEST_HEAD,
    treeSha: TEST_TREE,
    generatedAt: '2026-01-01T00:00:00.000Z',
    runtimeHardwareClass: profile.runtimeHardwareClass,
    entries,
    summary: {
      totalMetrics: entries.length,
      wins: 0,
      ties: 0,
      losses: 0,
      unmeasured: entries.length,
    },
  };
}

test('scorecard verification rejects a denominator that shrinks below the profile', () => {
  const complete = fullScorecard();
  assert.doesNotThrow(() => verifyCompetitiveScorecard(complete, profile, { expectedGitSha: TEST_HEAD, expectedTreeSha: TEST_TREE }));

  const shrunk = structuredClone(complete);
  shrunk.entries.pop();
  shrunk.summary.totalMetrics -= 1;
  assert.throws(() => verifyCompetitiveScorecard(shrunk, profile, { expectedGitSha: TEST_HEAD, expectedTreeSha: TEST_TREE }),
    /denominator|metric|entry|profile|missing|shrink/i,
    'dropping a metric must be a hard failure, not a smaller denominator');
});

test('profile denominator rejects deleting a canonical metric', () => {
  const mutated = structuredClone(profile);
  delete mutated.metrics['alias-v2-exact-precision'];
  assert.throws(() => verifyCompetitiveProfile(mutated), /denominator|metric.*(order|mismatch|missing)/i);
});

test('UNMEASURED active values cannot retain historical numbers', () => {
  const mutated = fullScorecard();
  mutated.entries[0].hexValue = 1;
  assert.throws(() => verifyCompetitiveScorecard(mutated, profile, { expectedGitSha: TEST_HEAD, expectedTreeSha: TEST_TREE }), /unmeasured-value-nonnull/);
});

test('scorecard identity and entry identity are exact, not arbitrary strings', () => {
  const mutated = fullScorecard();
  mutated.gitSha = 'c'.repeat(40);
  assert.throws(() => verifyCompetitiveScorecard(mutated, profile, { expectedGitSha: TEST_HEAD, expectedTreeSha: TEST_TREE }), /identity/);
  const stale = fullScorecard();
  stale.entries[0].hexVersion = 'd'.repeat(40);
  assert.throws(() => verifyCompetitiveScorecard(stale, profile, { expectedGitSha: TEST_HEAD, expectedTreeSha: TEST_TREE }), /entry-identity/);
});

function syntheticTwinManifest() {
  return createTwinManifest({
    corpusId: 'mutation-corpus',
    corpusVersion: 1,
    sourceIdentity: { id: 'mutation-source', sha256: 'a'.repeat(64) },
    compiler: { id: 'clang', version: '18.1.0' },
    targetTriple: 'x86_64-unknown-linux-gnu',
    architecture: { id: 'x86_64', profile: 'long-64' },
    profile: 'mutation-profile',
    compileArgs: ['-g', '-O0'],
    compileOptions: { optimization: 'O0' },
    linker: { id: 'ld', version: '2.42', options: { buildId: 'none' } },
    buildIdentity: 'mutation-build',
    debugArtifactSha256: 'b'.repeat(64),
    stripTool: { id: 'strip', version: 'GNU strip 2.42' },
    stripArgv: ['--strip-debug'],
    stripConfig: { mode: 'debug-only', inPlace: true },
    strippedArtifactSha256: 'c'.repeat(64),
    lineage: {
      relation: 'debug-artifact-strip-only',
      immutable: true,
      sourceArtifactSha256: 'b'.repeat(64),
      strippedArtifactSha256: 'c'.repeat(64),
    },
  });
}

test('measured binary truth rejects a forged digest-only twin reference', () => {
  const mutated = structuredClone(profile);
  mutated.metrics['machine-effects-x86_64-coverage'].groundTruth = {
    kind: 'binary-corpus',
    authority: 'same-binary-twin',
    status: 'measured',
    binaryScored: true,
    twinManifest: { corpusId: 'mutation-corpus', corpusVersion: 1, manifestDigest: '0'.repeat(32) },
  };
  assert.throws(() => verifyCompetitiveProfile(mutated), /binary-ground-truth-twin-full-required/);
});

test('v2 scorecard rejects an empty UNMEASURED entry without ground-truth fields', () => {
  const mutated = fullScorecard();
  delete mutated.entries[0].groundTruth;
  assert.throws(() => verifyCompetitiveScorecard(mutated, profile, { expectedGitSha: TEST_HEAD, expectedTreeSha: TEST_TREE }), /entry-missing-field/);
});

test('measured binary truth rejects an authority other than same-binary-twin', () => {
  const mutated = structuredClone(profile);
  mutated.metrics['machine-effects-x86_64-coverage'].groundTruth = {
    kind: 'binary-corpus',
    authority: 'source-spec',
    status: 'measured',
    binaryScored: true,
    twinManifest: syntheticTwinManifest(),
  };
  assert.throws(() => verifyCompetitiveProfile(mutated), /binary-ground-truth-authority-required/);
});

test('measured nonbinary source truth is accepted without a twin', () => {
  const mutated = structuredClone(profile);
  mutated.metrics['alias-v2-exact-precision'].groundTruth = {
    kind: 'source-level-spec',
    authority: 'source-spec',
    status: 'measured',
    binaryScored: false,
    twinManifest: null,
  };
  assert.doesNotThrow(() => verifyCompetitiveProfile(mutated));
});

test('measured binary score requires replayed twin evidence and exact artifact identity', () => {
  const fixture = buildTwinFixture();
  try {
    const outputPath = `${fixture.root}/scorecard-twin.stripped.elf`;
    const manifest = generateTwinManifest({
      debugArtifactPath: fixture.debug.path,
      strippedArtifactPath: outputPath,
      ...fixture.context,
    });
    const measuredProfile = structuredClone(profile);
    const metricId = 'machine-effects-x86_64-coverage';
    measuredProfile.metrics[metricId].corpusWorkloadIds.push(fixture.context.corpusId);
    measuredProfile.metrics[metricId].groundTruth = {
      kind: 'binary-corpus',
      authority: 'same-binary-twin',
      status: 'measured',
      binaryScored: true,
      twinManifest: manifest,
    };
    const measuredScorecard = fullScorecard();
    const entry = measuredScorecard.entries.find((candidate) => candidate.metricId === metricId);
    entry.corpusId = fixture.context.corpusId;
    entry.inputIdentity = `bin_sha256_${manifest.strippedArtifactSha256}`;
    entry.groundTruth = measuredProfile.metrics[metricId].groundTruth;
    entry.groundTruthAuthority = 'same-binary-twin';
    entry.groundTruthStatus = 'measured';
    entry.twinManifest = manifest;
    const identity = { expectedGitSha: TEST_HEAD, expectedTreeSha: TEST_TREE };
    const evidence = {
      [metricId]: {
        debugArtifactPath: fixture.debug.path,
        strippedArtifactPath: outputPath,
        expected: fixture.context,
      },
    };
    assert.doesNotThrow(() => verifyCompetitiveScorecard(measuredScorecard, measuredProfile, {
      ...identity,
      twinEvidenceByMetric: evidence,
    }));
    assert.throws(() => verifyCompetitiveScorecard(measuredScorecard, measuredProfile, identity), /binary-twin-evidence-required/);
  } finally {
    removeTwinFixture(fixture);
  }
});
