import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createPhase7ArtifactDescriptor,
} from '../js/analysis/artifact-identity.js';

// Issue #6164: `createPhase7ArtifactDescriptor` hashed `input.options` into the
// artifact id wholesale, so an option belonging to a dependency class the kind
// does not declare still changed the identity. Points-to tuning churned
// alias-only artifacts and alias tuning churned option-free artifacts — FM-14
// over-invalidation at the descriptor boundary itself.

const base = (overrides = {}) => ({
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
  ...overrides,
});

const artifactIdFor = (input) => createPhase7ArtifactDescriptor(input).artifactId;

test('issue-6164: an unrelated points-to option does not invalidate an alias artifact', () => {
  // `phase7.alias.region` declares aliasOptions but not pointsToOptions.
  const a = artifactIdFor(base({ options: { pointsToOptions: { maxIterations: 10 } } }));
  const b = artifactIdFor(base({ options: { pointsToOptions: { maxIterations: 20 } } }));
  assert.equal(a, b,
    'points-to tuning is not an alias dependency, so it must not churn the alias artifact id (FM-14)');
});

test('issue-6164: the declared alias option still invalidates the alias artifact', () => {
  const a = artifactIdFor(base({ options: { aliasOptions: { widenAfterIterations: 3 } } }));
  const b = artifactIdFor(base({ options: { aliasOptions: { widenAfterIterations: 9 } } }));
  assert.notEqual(a, b,
    'an option the kind actually depends on must keep changing the artifact id');
});

test('issue-6164: a points-to artifact is keyed by both option classes it declares', () => {
  const make = (options) => artifactIdFor(base({
    kind: 'phase7.pointsto.local',
    analyzerId: 'phase7.pointsto.a2-local',
    calleeSummaryIds: ['B@1'],
    options,
  }));
  const reference = make({ aliasOptions: { widenAfterIterations: 3 }, pointsToOptions: { maxTargetsPerSet: 4 } });
  assert.notEqual(reference, make({ aliasOptions: { widenAfterIterations: 9 }, pointsToOptions: { maxTargetsPerSet: 4 } }),
    'aliasOptions are declared and must be keyed');
  assert.notEqual(reference, make({ aliasOptions: { widenAfterIterations: 3 }, pointsToOptions: { maxTargetsPerSet: 8 } }),
    'pointsToOptions are declared and must be keyed');
});

test('issue-6164: kinds without an option class ignore unrelated analysis options entirely', () => {
  const debugBase = {
    kind: 'phase7.debug.facts',
    binaryId: 'binary_1',
    snapshotId: 'snapshot_1',
    analyzerId: 'phase7.debug',
    analyzerVersion: '1.0.0',
    semanticSchemaVersion: '2',
    debugProviderVersion: '1.0.0',
    debugBuildIdentity: 'build_a',
  };
  assert.equal(
    artifactIdFor(debugBase),
    artifactIdFor({ ...debugBase, options: { aliasOptions: { a: 1 }, pointsToOptions: { b: 2 } } }),
    'debug facts depend on neither alias nor points-to options',
  );
});

test('issue-6164: absent, empty, and projected-empty options hash identically', () => {
  const withOptions = artifactIdFor(base({ options: {} }));
  const without = artifactIdFor(base());
  assert.equal(withOptions, without, 'an empty option bag must not be a new key dimension');
  const projectedAway = artifactIdFor(base({ options: { pointsToOptions: { only: 'option' } } }));
  assert.equal(projectedAway, without,
    'after projection removes the undeclared namespace nothing is left to hash');
});

test('issue-6164: presentation-state rejection survives the projection', () => {
  // #1724's contract: forbidden fields fail closed whether or not their
  // namespace survives projection — the caller may have smuggled them in
  // under a declared namespace too.
  assert.throws(
    () => createPhase7ArtifactDescriptor(base({ options: { tabId: 'x' } })),
    /phase7-artifact-presentation-state-in-key/,
  );
  assert.throws(
    () => createPhase7ArtifactDescriptor(base({ options: { aliasOptions: { fileName: 'x.bin' } } })),
    /phase7-artifact-presentation-state-in-key/,
  );
});
