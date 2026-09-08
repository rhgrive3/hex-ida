import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PHASE7_ARTIFACT_KINDS,
  createPhase7ArtifactDescriptor,
  dependencyClassFor,
  explainArtifactMismatch,
} from '../../../js/analysis/artifact-identity.js';

const base = (overrides = {}) => ({
  kind: 'phase7.pointsto.local',
  binaryId: 'binary_1',
  functionId: 'function_1',
  architectureId: 'arm64',
  snapshotId: 'snapshot_1',
  analyzerId: 'phase7.pointsto.a2-local',
  analyzerVersion: '1.0.0',
  semanticSchemaVersion: '2',
  cfgVersion: '2.0.0',
  ssaVersion: '2.0.0',
  memorySsaVersion: '2.0.0',
  architectureSemanticVersion: '1',
  abiSemanticVersion: '1',
  // Points-to completeness depends on the budget, so the fixture declares a
  // budget class; #5751 makes an unbound budget class on a
  // completeness-affecting artifact a fail-closed construction error.
  budgetClass: 'interactive',
  budgetAffectsCompleteness: true,
  ...overrides,
});

test('every declared artifact kind declares its dependency class', () => {
  for (const kind of PHASE7_ARTIFACT_KINDS) {
    const classes = dependencyClassFor(kind);
    assert.ok(Array.isArray(classes) && classes.length > 0, `no dependency class for ${kind}`);
    assert.ok(classes.includes('binary'), `${kind} must depend on binary identity`);
  }
});

test('the same inputs produce the same artifact id', () => {
  assert.equal(
    createPhase7ArtifactDescriptor(base()).artifactId,
    createPhase7ArtifactDescriptor(base()).artifactId,
  );
});

test('a change to any semantically relevant input changes the artifact id', () => {
  const reference = createPhase7ArtifactDescriptor(base()).artifactId;
  const mutations = [
    { binaryId: 'binary_2' },
    { functionId: 'function_2' },
    { architectureId: 'x86_64' },
    { snapshotId: 'snapshot_2' },
    { analyzerVersion: '1.0.1' },
    { semanticSchemaVersion: '3' },
    { cfgVersion: '2.1.0' },
    { ssaVersion: '2.1.0' },
    { memorySsaVersion: '2.1.0' },
    { options: { pointsToOptions: { widenAfterIterations: 9 } } },
    { upstreamArtifactIds: ['artifact_upstream_1'] },
  ];
  for (const mutation of mutations) {
    const mutated = createPhase7ArtifactDescriptor(base(mutation)).artifactId;
    assert.notEqual(mutated, reference, `mutation did not change artifact identity: ${JSON.stringify(mutation)}`);
  }
});

test('interprocedural results are keyed by exact callee summary identity', () => {
  const withCallee = (ids) => createPhase7ArtifactDescriptor(base({
    kind: 'phase7.summary.interprocedural',
    calleeSummaryIds: ids,
  })).artifactId;
  assert.notEqual(withCallee(['summary_a@1']), withCallee(['summary_a@2']),
    'a changed callee summary must invalidate the caller result (FM-4)');
  assert.equal(withCallee(['summary_a@1', 'summary_b@1']), withCallee(['summary_b@1', 'summary_a@1']),
    'callee summary order is not semantic');
});

test('debug-derived facts are keyed by provider version and matched build identity', () => {
  const withDebug = (providerVersion, buildIdentity, digest = 'digest_a') => createPhase7ArtifactDescriptor(base({
    kind: 'phase7.debug.facts',
    debugProviderVersion: providerVersion,
    debugBuildIdentity: buildIdentity,
    debugIdentityDigest: digest,
  })).artifactId;
  assert.notEqual(withDebug('1.0.0', 'build_a'), withDebug('1.0.1', 'build_a'));
  assert.notEqual(withDebug('1.0.0', 'build_a'), withDebug('1.0.0', 'build_b'));
});

test('debug facts bind the canonical debug identity digest (#5849)', () => {
  // matched-partial coverage decides which records are hard evidence, so two
  // debug identities with different coverage must not share an identity.
  const withDigest = (digest) => createPhase7ArtifactDescriptor(base({
    kind: 'phase7.debug.facts',
    debugProviderVersion: '1.0.0',
    debugBuildIdentity: 'build_a',
    debugIdentityDigest: digest,
  })).artifactId;
  assert.notEqual(withDigest('digest_a'), withDigest('digest_b'),
    'a different debug identity digest must change artifact identity');
  for (const kind of ['phase7.debug.facts', 'phase7.types.constraint-graph', 'phase7.discovery.candidates']) {
    assert.throws(
      () => createPhase7ArtifactDescriptor(base({
        kind,
        ...(kind === 'phase7.types.constraint-graph' ? { abiId: 'abi_a' } : {}),
        debugProviderVersion: '1.0.0',
        debugBuildIdentity: 'build_a',
        debugIdentityDigest: undefined,
      })),
      /phase7-artifact-debug-identity-digest-required/,
      `${kind} declares the debugIdentity class, so the digest is required`,
    );
  }
});

test('debug facts require the provider version and build identity they declare (#5836)', () => {
  assert.throws(
    () => createPhase7ArtifactDescriptor(base({
      kind: 'phase7.debug.facts',
      debugIdentityDigest: 'digest_a',
      debugBuildIdentity: 'build_a',
      debugProviderVersion: undefined,
    })),
    /phase7-artifact-debug-provider-version-required/,
  );
  assert.throws(
    () => createPhase7ArtifactDescriptor(base({
      kind: 'phase7.debug.facts',
      debugIdentityDigest: 'digest_a',
      debugProviderVersion: '1.0.0',
      debugBuildIdentity: undefined,
    })),
    /phase7-artifact-debug-build-identity-required/,
  );
});

test('presentation state can never enter a semantic cache key', () => {
  // Keying alias analysis by the open tab or a user rename both over-invalidates
  // and makes the cache unreproducible, so it is rejected rather than hashed.
  for (const key of ['fileName', 'tabId', 'displayAddress', 'userName', 'userComment', 'selection']) {
    assert.throws(
      () => createPhase7ArtifactDescriptor(base({ options: { [key]: 'anything' } })),
      /phase7-artifact-presentation-state-in-key/,
      `presentation field accepted into the key: ${key}`,
    );
  }
  assert.throws(
    () => createPhase7ArtifactDescriptor(base({ options: { nested: { tabId: 'x' } } })),
    /phase7-artifact-presentation-state-in-key/,
  );
});

test('budget class enters the key only when completeness depends on it', () => {
  const bounded = createPhase7ArtifactDescriptor(base({ budgetClass: 'interactive' })).artifactId;
  const exhaustive = createPhase7ArtifactDescriptor(base({ budgetClass: 'exhaustive' })).artifactId;
  assert.notEqual(bounded, exhaustive, 'a bounded artifact must not be interchangeable with an exhaustive one');
  const ignored = createPhase7ArtifactDescriptor(base({ budgetClass: 'interactive', budgetAffectsCompleteness: false })).artifactId;
  const ignoredOther = createPhase7ArtifactDescriptor(base({ budgetClass: 'exhaustive', budgetAffectsCompleteness: false })).artifactId;
  assert.equal(ignored, ignoredOther);
});

test('an option group outside the dependency class cannot change artifact identity (#6164)', () => {
  // phase7.alias.region declares aliasOptions only: points-to tuning must not
  // invalidate it, otherwise the dependency table lies about change impact.
  const aliasBase = {
    kind: 'phase7.alias.region',
    binaryId: 'binary_1',
    functionId: 'function_1',
    architectureId: 'arm64',
    snapshotId: 'snapshot_1',
    analyzerId: 'phase7.alias',
    analyzerVersion: '1.0.0',
    semanticSchemaVersion: '2',
    cfgVersion: '2.0.0',
    ssaVersion: '2.0.0',
    memorySsaVersion: '2.0.0',
    architectureSemanticVersion: '1',
    abiSemanticVersion: '1',
    budgetClass: 'interactive',
    budgetAffectsCompleteness: true,
  };
  const reference = createPhase7ArtifactDescriptor(aliasBase).artifactId;
  assert.equal(
    createPhase7ArtifactDescriptor({ ...aliasBase, options: { pointsToOptions: { maxIterations: 10 } } }).artifactId,
    reference,
    'an undeclared option group must be identity-neutral',
  );
});

test('a kind without option dependencies ignores analysis tuning options (#6164)', () => {
  const debugBase = {
    kind: 'phase7.debug.facts',
    binaryId: 'binary_1',
    snapshotId: 'snapshot_1',
    analyzerId: 'phase7.debug',
    analyzerVersion: '1.0.0',
    semanticSchemaVersion: '2',
    debugProviderVersion: '1.0.0',
    debugBuildIdentity: 'build_a',
    debugIdentityDigest: 'digest_issue_6164',
    budgetClass: 'interactive',
    budgetAffectsCompleteness: true,
  };
  const reference = createPhase7ArtifactDescriptor(debugBase).artifactId;
  assert.equal(
    createPhase7ArtifactDescriptor({
      ...debugBase,
      options: { aliasOptions: { keepAllLocals: true }, pointsToOptions: { maxIterations: 10 } },
    }).artifactId,
    reference,
    'debug facts declare no option dependency, so tuning options cannot enter the key',
  );
});

test('declared option groups still enter the artifact identity (#6164)', () => {
  const withPointsTo = (maxIterations) => createPhase7ArtifactDescriptor(base({
    options: { pointsToOptions: { maxIterations } },
  })).artifactId;
  assert.notEqual(withPointsTo(10), withPointsTo(20),
    'a declared option group must remain identity-affecting');
  assert.equal(withPointsTo(10), withPointsTo(10));
});

test('alias option changes affect each kind that declares them (#6164)', () => {
  for (const kind of ['phase7.alias.region', 'phase7.pointsto.local']) {
    const descriptor = (keepAllLocals) => createPhase7ArtifactDescriptor(base({
      kind, options: { aliasOptions: { keepAllLocals } },
    })).artifactId;
    assert.notEqual(descriptor(true), descriptor(false), kind);
  }
});

test('options keys outside the known option classes fail closed (#6164)', () => {
  assert.throws(
    () => createPhase7ArtifactDescriptor(base({ options: { maxIterations: 9 } })),
    /phase7-artifact-unknown-option-class:maxIterations/,
    'an unrecognized options key would silently narrow the key below real semantics',
  );
  assert.throws(
    () => createPhase7ArtifactDescriptor(base({ options: { aliasOptions: {}, pointsToOptions: {}, surprise: 1 } })),
    /phase7-artifact-unknown-option-class:surprise/,
  );
});

test('explicit blank optional identities fail closed instead of becoming absent', () => {
  const cases = [
    [{ sliceId: '   ' }, /phase7-artifact-invalid-slice-id/],
    [{ functionId: '   ' }, /phase7-artifact-invalid-entity-id/],
    // With budget relevance explicitly denied the budget class is an optional
    // key slot, so a blank value still fails closed instead of becoming absent.
    [{ budgetClass: '   ', budgetAffectsCompleteness: false }, /phase7-artifact-invalid-budget-class/],
    [{ platformId: '   ' }, /phase7-artifact-invalid-platform-id/],
  ];
  for (const [overrides, expected] of cases) {
    assert.throws(() => createPhase7ArtifactDescriptor(base(overrides)), expected);
  }

  assert.throws(
    () => createPhase7ArtifactDescriptor(base({
      kind: 'phase7.debug.facts',
      debugIdentityDigest: 'digest_a',
      debugProviderVersion: '   ',
      debugBuildIdentity: 'build_a',
    })),
    // debug.facts declares the debugProvider dependency, so a blank value is
    // a missing required dependency rather than a blank optional identity.
    /phase7-artifact-debug-provider-version-required/,
  );
  assert.throws(
    () => createPhase7ArtifactDescriptor(base({
      kind: 'phase7.debug.facts',
      debugIdentityDigest: 'digest_a',
      debugProviderVersion: '1.0.0',
      debugBuildIdentity: '   ',
    })),
    /phase7-artifact-debug-build-identity-required/,
  );
  assert.throws(
    () => createPhase7ArtifactDescriptor(base({
      kind: 'phase7.discovery.candidates',
      debugIdentityDigest: 'digest_a',
      loaderEvidenceId: '   ',
    })),
    /phase7-artifact-invalid-loader-evidence-id/,
  );

  assert.equal(
    createPhase7ArtifactDescriptor(base()).artifactId,
    createPhase7ArtifactDescriptor(base({ sliceId: null })).artifactId,
    'nullish optional identity must retain absent semantics',
  );
  assert.equal(
    createPhase7ArtifactDescriptor(base({ sliceId: 'slice_1' })).artifactId,
    createPhase7ArtifactDescriptor(base({ sliceId: '  slice_1  ' })).artifactId,
    'non-empty optional identity keeps the existing trim-to-canonical policy',
  );
});

test('a mismatch is always explained, never silently tolerated', () => {
  const expected = createPhase7ArtifactDescriptor(base());
  assert.equal(explainArtifactMismatch(expected, expected), null);
  assert.equal(explainArtifactMismatch(expected, null), 'missing');
  assert.equal(explainArtifactMismatch(expected, createPhase7ArtifactDescriptor(base({ binaryId: 'binary_2' }))), 'binary');
  assert.equal(explainArtifactMismatch(expected, createPhase7ArtifactDescriptor(base({ analyzerVersion: '9.9.9' }))), 'analyzer-version');
  assert.equal(explainArtifactMismatch(expected, createPhase7ArtifactDescriptor(base({ upstreamArtifactIds: ['x'] }))), 'dependency');
  assert.equal(explainArtifactMismatch(expected, createPhase7ArtifactDescriptor(base({ options: { pointsToOptions: { a: 1 } } }))), 'options');
});

test('required identity is enforced rather than defaulted', () => {
  assert.throws(() => createPhase7ArtifactDescriptor(base({ binaryId: '' })), /binary-id-required/);
  assert.throws(() => createPhase7ArtifactDescriptor(base({ snapshotId: null })), /snapshot-required/);
  assert.throws(() => createPhase7ArtifactDescriptor(base({ memorySsaVersion: null })), /memoryssa-version-required/);
  assert.throws(() => createPhase7ArtifactDescriptor(base({ kind: 'phase7.not.a.kind' })), /unknown-kind/);
});

test('a completeness-affecting artifact must bind its budget generation (#5751)', () => {
  // budgetAffectsCompleteness defaults to "relevant", so a producer that
  // forgets budgetClass must not mint an identity where the budget dimension
  // is silently absent — interactive and exhaustive results would collide.
  assert.throws(
    () => createPhase7ArtifactDescriptor(base({ budgetClass: undefined })),
    /phase7-artifact-budget-class-required/,
  );
  assert.throws(
    () => createPhase7ArtifactDescriptor(base({ budgetClass: null })),
    /phase7-artifact-budget-class-required/,
  );
  assert.throws(
    () => createPhase7ArtifactDescriptor(base({ budgetClass: '   ' })),
    /phase7-artifact-budget-class-required/,
  );
  assert.throws(
    () => createPhase7ArtifactDescriptor(base({ budgetAffectsCompleteness: true, budgetClass: null })),
    /phase7-artifact-budget-class-required/,
  );
  // A denied budget dependence keeps the old identity semantics: the budget
  // class is excluded from the key, so omitting it stays legal.
  assert.doesNotThrow(() => createPhase7ArtifactDescriptor(base({ budgetAffectsCompleteness: false, budgetClass: null })));
});
