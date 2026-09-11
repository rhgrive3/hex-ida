import assert from 'node:assert/strict';
import test from 'node:test';
import { createPhase7ArtifactDescriptor, dependencyClassFor } from '../../../js/analysis/artifact-identity.js';

const base = {
  kind: 'phase7.summary.local', binaryId: 'binary-A', functionId: 'caller', architectureId: 'arm64',
  snapshotId: 'snapshot-A', analyzerId: 'phase7.summary.local', analyzerVersion: '1.1.0',
  semanticSchemaVersion: '2', cfgVersion: '2', ssaVersion: '2', memorySsaVersion: '2', architectureSemanticVersion: '1',
};
const id = (calleeSummaryIds, overrides = {}) => createPhase7ArtifactDescriptor({ ...base, calleeSummaryIds, ...overrides }).artifactId;

test('local summaries declare the callee summary dependency', () => {
  assert.ok(dependencyClassFor(base.kind).includes('calleeSummaries'));
});

test('a changed, added or removed callee summary changes caller identity', () => {
  const before = id(['callee@1']);
  assert.notEqual(id(['callee@2']), before);
  assert.notEqual(id(['callee@1', 'other@1']), before);
  assert.notEqual(id([]), before);
});

test('ordering and duplicate references do not change dependency identity', () => {
  assert.equal(id(['B@1', 'A@1', 'A@1']), id(['A@1', 'B@1']));
});

test('malformed dependency identifiers fail closed', () => {
  for (const value of [[''], [['callee']], [true], 'callee']) {
    assert.throws(() => id(value), /phase7-artifact-invalid-callee-summary-id/);
  }
});

test('other dependency classes retain their existing key semantics', () => {
  assert.equal(id(['A@1'], { kind: 'phase7.alias.region' }), id(['A@2'], { kind: 'phase7.alias.region' }));
  assert.notEqual(id(['A@1'], { kind: 'phase7.summary.interprocedural' }), id(['A@2'], { kind: 'phase7.summary.interprocedural' }));
});
