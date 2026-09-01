import assert from 'node:assert/strict';
import {
  createLanguageMetadataIdentity,
  isAuthoritative,
  isLanguageRecordAuthoritative,
  createLanguageMetadataRecord,
  createLanguageMetadataPage,
  createLanguageMetadataResult,
  LanguageMetadataProvider,
  applyLanguageMetadataTypesToGraph,
  languageMetadataFunctionEvidence,
  METADATA_IDENTITY_VERDICTS,
} from '../js/metadata/provider.js';
import { TypeConstraintGraph } from '../js/analysis/types/graph.js';

console.log('Testing Language Metadata Provider Contract...');

// 1. Identity creation & verdict checks
assert.throws(() => createLanguageMetadataIdentity({ verdict: 'invalid-verdict' }), /metadata-identity-invalid-verdict/);
assert.throws(() => createLanguageMetadataIdentity({ verdict: 'matched-authoritative' }), /metadata-identity-provider-required/);
assert.throws(() => createLanguageMetadataIdentity({
  verdict: 'matched-authoritative',
  providerId: 'go-metadata',
  providerVersion: '1.0.0',
  ecosystem: 'go',
  method: 'filename',
}), /metadata-identity-filename-is-not-authority/);

const authIdentity = createLanguageMetadataIdentity({
  verdict: 'matched-authoritative',
  providerId: 'go-metadata',
  providerVersion: '1.0.0',
  ecosystem: 'go',
  toolchainVersion: 'go1.21.0',
  binaryIdentity: 'sha256:abc',
  expected: 'sha256:abc',
  observed: 'sha256:abc',
  method: 'pclntab-magic',
});

assert.equal(authIdentity.verdict, 'matched-authoritative');
assert.equal(isAuthoritative(authIdentity), true);
assert.ok(authIdentity.digest);

const unauthIdentity = createLanguageMetadataIdentity({
  verdict: 'identity-unavailable',
  providerId: 'go-metadata',
  providerVersion: '1.0.0',
  ecosystem: 'go',
  method: 'none',
});
assert.equal(isAuthoritative(unauthIdentity), false);

// 2. Partial identity & coverage filtering
const partialCoverageSource = {
  recordKinds: ['type'],
  entityIds: ['type@0x1000'],
  nested: { values: ['caller-owned'] },
};
const partialIdentity = createLanguageMetadataIdentity({
  verdict: 'matched-partial',
  providerId: 'rust-metadata',
  providerVersion: '1.0.0',
  ecosystem: 'rust',
  toolchainVersion: 'rustc-1.78.0',
  binaryIdentity: 'sha256:def',
  coverage: partialCoverageSource,
});

// Coverage is immutable inside the identity without freezing or aliasing caller-owned values (#3146).
assert.notStrictEqual(partialIdentity.coverage, partialCoverageSource);
assert.notStrictEqual(partialIdentity.coverage.recordKinds, partialCoverageSource.recordKinds);
assert.notStrictEqual(partialIdentity.coverage.entityIds, partialCoverageSource.entityIds);
assert.notStrictEqual(partialIdentity.coverage.nested, partialCoverageSource.nested);
assert.notStrictEqual(partialIdentity.coverage.nested.values, partialCoverageSource.nested.values);
assert.equal(Object.isFrozen(partialIdentity.coverage), true);
assert.equal(Object.isFrozen(partialIdentity.coverage.entityIds), true);
assert.equal(Object.isFrozen(partialIdentity.coverage.nested), true);
assert.equal(Object.isFrozen(partialIdentity.coverage.nested.values), true);
assert.equal(Object.isFrozen(partialCoverageSource), false);
assert.equal(Object.isFrozen(partialCoverageSource.entityIds), false);
assert.equal(Object.isFrozen(partialCoverageSource.nested), false);
assert.equal(Object.isFrozen(partialCoverageSource.nested.values), false);
partialCoverageSource.entityIds.push('type@0x2000');
partialCoverageSource.nested.values.push('still-mutable');
assert.deepEqual(partialIdentity.coverage.entityIds, ['type@0x1000']);
assert.deepEqual(partialIdentity.coverage.nested.values, ['caller-owned']);

// Authority filtering uses a known-dimension coverage only. The immutability
// identity above deliberately carries an unknown `nested` dimension, which the
// fail-closed authority contract must never authorize (unknown stays explicit).
const authorityIdentity = createLanguageMetadataIdentity({
  verdict: 'matched-partial',
  providerId: 'rust-metadata',
  providerVersion: '1.0.0',
  ecosystem: 'rust',
  toolchainVersion: 'rustc-1.78.0',
  binaryIdentity: 'sha256:def',
  coverage: {
    recordKinds: ['type'],
    entityIds: ['type@0x1000'],
  },
});

const coveredRecord = createLanguageMetadataRecord({
  kind: 'type',
  entityId: 'type@0x1000',
  name: 'MyStruct',
  address: '0x1000',
  providerId: 'rust-metadata',
  providerVersion: '1.0.0',
  ecosystem: 'rust',
  buildIdentity: 'sha256:def',
  descriptor: { name: 'MyStruct', byteSize: 16 },
});

const uncoveredRecord = createLanguageMetadataRecord({
  kind: 'type',
  entityId: 'type@0x2000',
  name: 'OtherStruct',
  address: '0x2000',
  providerId: 'rust-metadata',
  providerVersion: '1.0.0',
  ecosystem: 'rust',
  buildIdentity: 'sha256:def',
  descriptor: { name: 'OtherStruct', byteSize: 8 },
});

const symbolRecord = createLanguageMetadataRecord({
  kind: 'symbol',
  entityId: 'sym@0x1000',
  name: 'my_func',
  address: '0x1000',
  providerId: 'rust-metadata',
  providerVersion: '1.0.0',
  ecosystem: 'rust',
  buildIdentity: 'sha256:def',
});

// Partial identity can still authorize an explicitly covered record when the
// result itself is structurally complete.
const partialResult = createLanguageMetadataResult({
  identity: authorityIdentity,
  ecosystem: 'rust',
  sections: ['.comment', '.rodata'],
  completeness: { present: true, declared: 1, scanned: 1, parsed: 1, complete: true },
});

assert.equal(isLanguageRecordAuthoritative(partialResult, coveredRecord), true);
assert.equal(isLanguageRecordAuthoritative(partialResult, uncoveredRecord), false);
assert.equal(isLanguageRecordAuthoritative(partialResult, symbolRecord), false);

// #3265: canonical completeness metrics never coerce non-number or invalid
// numeric values into the result contract.
const metricFields = ['declared', 'scanned', 'parsed', 'unreadableEntries', 'invalidEntries'];
const invalidMetricValues = [{}, ['1'], true, NaN, Infinity, 1.5, -1, Number.MAX_SAFE_INTEGER + 1];
for (const field of metricFields) {
  for (const value of invalidMetricValues) {
    assert.throws(
      () => createLanguageMetadataResult({
        identity: authIdentity,
        completeness: { complete: false, [field]: value },
      }),
      /metadata-result-invalid-/,
      `${field} rejects ${String(value)}`,
    );
  }
}
const metricEdges = createLanguageMetadataResult({
  identity: authIdentity,
  completeness: {
    declared: 0,
    scanned: Number.MAX_SAFE_INTEGER,
    parsed: 0,
    unreadableEntries: 0,
    invalidEntries: 0,
  },
});
assert.equal(metricEdges.completeness.declared, 0);
assert.equal(metricEdges.completeness.scanned, Number.MAX_SAFE_INTEGER);

// 3. Provider result & abstract class
class TestProvider extends LanguageMetadataProvider {
  probe() {
    return createLanguageMetadataResult({
      identity: authIdentity,
      ecosystem: 'go',
      sections: ['.gopclntab'],
      counts: { symbols: 1, types: 1 },
      completeness: { present: true, declared: 2, scanned: 2, parsed: 2, complete: true },
    });
  }
  symbols() {
    return createLanguageMetadataPage({
      records: [
        createLanguageMetadataRecord({
          kind: 'symbol',
          entityId: 'sym@0x401000',
          name: 'main.main',
          address: '0x401000',
          sizeBytes: 64,
          providerId: 'go-metadata',
          providerVersion: '1.0.0',
          ecosystem: 'go',
        }),
      ],
    });
  }
  types() {
    return createLanguageMetadataPage({
      records: [
        createLanguageMetadataRecord({
          kind: 'type',
          entityId: 'type@0x501000',
          name: 'main.Config',
          address: '0x501000',
          providerId: 'go-metadata',
          providerVersion: '1.0.0',
          ecosystem: 'go',
          descriptor: { name: 'main.Config', byteSize: 32 },
        }),
      ],
    });
  }
}

const provider = new TestProvider({ id: 'go-metadata', version: '1.0.0', ecosystem: 'go' });
const probeResult = provider.probe();
assert.equal(probeResult.authoritative, true);
assert.equal(probeResult.completeness.complete, true);

// 4. TypeConstraintGraph integration
const graph = new TypeConstraintGraph({ snapshotId: 'test-snap' });
const typePage = provider.types();
const applied = applyLanguageMetadataTypesToGraph(graph, probeResult, typePage);
assert.equal(applied.hard, 1);
assert.equal(applied.soft, 0);

const solved = graph.solveEntity('type@0x501000');
assert.equal(solved.layers.nominal.confidence, 'certain');
assert.equal(solved.layers.nominal.selected.descriptor.name, 'main.Config');

// Soft evidence for unauthoritative result
const unauthResult = createLanguageMetadataResult({
  identity: unauthIdentity,
  ecosystem: 'go',
  sections: [],
});
const unauthGraph = new TypeConstraintGraph({ snapshotId: 'test-snap-unauth' });
const unauthApplied = applyLanguageMetadataTypesToGraph(unauthGraph, unauthResult, typePage);
assert.equal(unauthApplied.hard, 0);
assert.equal(unauthApplied.soft, 1);

const unauthSolved = unauthGraph.solveEntity('type@0x501000');
assert.equal(unauthSolved.layers.nominal.confidence, 'possible');

// #3260: authoritative identity alone is insufficient. Incomplete result/status
// must remain soft/heuristic at both downstream authority boundaries.
const incompleteAuthoritativeResult = createLanguageMetadataResult({
  identity: authIdentity,
  ecosystem: 'go',
  sections: ['.gopclntab'],
  completeness: { present: true, declared: 2, scanned: 1, parsed: 1, unreadableEntries: 1, complete: false },
});
assert.equal(isLanguageRecordAuthoritative(incompleteAuthoritativeResult, typePage.records[0]), false);
const incompleteGraph = new TypeConstraintGraph({ snapshotId: 'test-snap-incomplete' });
const incompleteApplied = applyLanguageMetadataTypesToGraph(incompleteGraph, incompleteAuthoritativeResult, typePage);
assert.equal(incompleteApplied.hard, 0);
assert.equal(incompleteApplied.soft, 1);

// 5. Function discovery evidence
const symPage = provider.symbols();
const evidence = languageMetadataFunctionEvidence(probeResult, symPage);
assert.equal(evidence.length, 1);
assert.equal(evidence[0].kind, 'go-function');
assert.equal(evidence[0].confidence, 'exact');
assert.equal(evidence[0].name, 'main.main');
assert.equal(evidence[0].address, '0x401000');

const incompleteEvidence = languageMetadataFunctionEvidence(incompleteAuthoritativeResult, symPage);
assert.equal(incompleteEvidence.length, 1);
assert.equal(incompleteEvidence[0].confidence, 'heuristic');

console.log('Language Metadata Provider Contract tests passed.');