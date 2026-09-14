import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SwiftMetadataProvider } from '../js/metadata/swift.js';
import {
  applyLanguageMetadataTypesToGraph,
  createLanguageMetadataIdentity,
  createLanguageMetadataRecord,
  createLanguageMetadataResult,
  isLanguageRecordAuthoritative,
} from '../js/metadata/provider.js';
import { createAnalysisStatus, FAIL_CLOSED_STOP_REASONS } from '../js/analysis/status.js';
import { TypeConstraintGraph } from '../js/analysis/types/graph.js';

const binaryIdentity = 'sha256:issue-4929-bounded';
async function fixture(options = {}) {
  const bytes = new Uint8Array(4096);
  const data = new DataView(bytes.buffer);
  const rel = (at, to) => data.setInt32(at, to - at, true);
  const string = (at, value) => bytes.set(new TextEncoder().encode(`${value}\0`), at);
  rel(64, 256);
  if (options.sectionBudget) rel(68, 256);
  data.setUint32(256, 0x80000010, true);
  rel(264, 768);
  string(768, 'BoundedType');
  data.setUint32(304, options.truncatedVtable || options.vtableBudget ? 2 : 1, true);
  if (!options.unknownMethod) rel(312, 2048);
  rel(128, 512);
  rel(512, 800);
  rel(516, 256);
  rel(520, 900);
  data.setUint32(524, options.conditionalConformance ? 256 : options.unknownTypeRef ? 32 : 0, true);
  if (options.truncatedFields || options.unknownField || options.fieldBudget) {
    rel(272, 1024);
    data.setUint32(292, options.truncatedFields || options.fieldBudget ? 2 : 1, true);
    data.setUint16(1034, 12, true);
    data.setUint32(1036, options.truncatedFields || options.fieldBudget ? 2 : 1, true);
    rel(1044, 1120);
    rel(1048, 1100);
    string(1100, 'first');
    if (!options.unknownField) string(1120, 'Si');
  }
  const controller = new AbortController();
  if (options.cancelled) controller.abort();
  const reader = async (address, length) => {
    if ((options.truncatedVtable && address === 316n)
      || (options.truncatedFields && address === 1052n)
      || (options.malformedConformance && address === 512n)) return null;
    return bytes.subarray(Number(address), Number(address) + length);
  };
  const provider = new SwiftMetadataProvider({
    binaryIdentity: options.unbound ? null : binaryIdentity,
    sections: [
      { name: '__swift5_types', vmAddr: 64n, size: options.sectionBudget ? 8 : 4 },
      ...options.complete ? [] : [{ name: '__swift5_proto', vmAddr: 128n, size: 4 }],
    ],
    readAt: reader,
    options: {
      reader,
      signal: controller.signal,
      ...options.budget == null ? {} : { budget: options.budget },
      ...options.injectedTable ? { vtables: [{ address: 308n, count: 1, typeAddress: 256n }] } : {},
    },
  });
  return { provider, result: await provider.probe() };
}

function records(provider) {
  return [provider.types(), provider.vtables(), provider.conformances()].flatMap(page => page.records);
}
function expectNoPublicAuthority(provider, result) {
  for (const record of records(provider)) assert.equal(isLanguageRecordAuthoritative(result, record), false, record.entityId);
  for (const reader of [provider.types, provider.vtables, provider.conformances]) {
    assert.equal(provider.authoritativeRecords(result, reader).records.length, 0);
  }
  const graph = new TypeConstraintGraph({ snapshotId: '4929-negative' });
  const applied = applyLanguageMetadataTypesToGraph(graph, result, provider.types());
  assert.equal(applied.hard, 0);
  assert.equal(applied.soft, provider.types().records.length);
}

test('#4929 actual partial probe proves only its sound bound through public consumers', async () => {
  const { provider, result } = await fixture();
  assert.equal(result.identity.verdict, 'matched-partial');
  assert.equal(result.completeness.complete, false);
  assert.equal(result.status.completeness, 'bounded');
  assert.equal(result.status.snapshotId, binaryIdentity);
  assert.equal(provider.cachedModel.completeness.witnessTables.complete, false);
  assert.equal(new Set(records(provider).map(record => record.address)).size, 3);
  for (const record of records(provider)) assert.equal(isLanguageRecordAuthoritative(result, record), true, record.entityId);
  for (const reader of [provider.types, provider.vtables, provider.conformances]) {
    assert.equal(provider.authoritativeRecords(result, reader).records.length, 1);
  }
  const graph = new TypeConstraintGraph({ snapshotId: '4929-positive' });
  assert.deepEqual(applyLanguageMetadataTypesToGraph(graph, result, provider.types()), { hard: 1, soft: 0, skipped: 0 });
});

for (const option of ['truncatedFields', 'truncatedVtable', 'malformedConformance']) {
  test(`#4929 ${option} cannot promote incomplete projected bodies`, async () => {
    const { provider, result } = await fixture({ [option]: true });
    assert.equal(result.completeness.complete, false);
    assert.equal(result.status.completeness, 'partial');
    assert.deepEqual(result.identity.coverage.entityIds, []);
    if (option === 'truncatedFields') {
      assert.equal(provider.cachedModel.types[0].numFields, 2);
      assert.equal(provider.types().records[0].descriptor.fields.length, 1);
      assert.equal(provider.cachedModel.completeness.types.complete, false);
      assert(!result.identity.coverage.entityIds.includes('type@0x100'));
    }
    if (option === 'truncatedVtable') {
      assert.equal(provider.cachedModel.vtables[0].count, 2);
      assert.equal(provider.vtables().records[0].descriptor.methods.length, 1);
      assert.equal(provider.cachedModel.completeness.vtables.complete, false);
      assert(!result.identity.coverage.entityIds.includes('vtable@0x134'));
    }
    expectNoPublicAuthority(provider, result);
  });
}

for (const [option, kind] of [['unknownField', 'type'], ['unknownMethod', 'vtable'], ['unknownTypeRef', 'conformance'], ['conditionalConformance', 'conformance']]) {
  test(`#4929 ${option} stays outside otherwise sound coverage`, async () => {
    const { provider, result } = await fixture({ [option]: true });
    const record = records(provider).find(record => record.kind === kind);
    assert(record);
    assert.equal(isLanguageRecordAuthoritative(result, record), false);
    assert(!result.identity.coverage.entityIds.includes(record.entityId));
  });
}

for (const options of [{ budget: 1, sectionBudget: true }, { budget: 1, fieldBudget: true }, { budget: 1, vtableBudget: true }, { cancelled: true }, { unbound: true }, { injectedTable: true }]) {
  test(`#4929 no bounded proof for ${JSON.stringify(options)}`, async () => {
    const { provider, result } = await fixture(options);
    assert.notEqual(result.status.completeness, 'bounded');
    expectNoPublicAuthority(provider, result);
  });
}

test('#4929 whole-run complete authority is preserved and incomplete authoritative stays blocked', async () => {
  const { provider, result } = await fixture({ complete: true });
  assert.equal(result.identity.verdict, 'matched-authoritative');
  assert.equal(result.completeness.complete, true);
  for (const record of records(provider)) assert.equal(isLanguageRecordAuthoritative(result, record), true);
  const incomplete = createLanguageMetadataResult({ ...result, completeness: { complete: false } });
  expectNoPublicAuthority(provider, incomplete);
});

test('#4929 ordinary partial, aborted, malformed, and foreign proof statuses cannot authorize', async () => {
  const { provider, result } = await fixture();
  const statuses = [
    createAnalysisStatus({ ...result.status, completeness: 'partial', stopReason: 'evidence-missing' }),
    ...FAIL_CLOSED_STOP_REASONS.map(stopReason => createAnalysisStatus({ ...result.status, completeness: 'partial', stopReason })),
    createAnalysisStatus({ ...result.status, snapshotId: 'other-binary' }),
    createAnalysisStatus({ ...result.status, analyzerId: 'metadata.foreign' }),
    createAnalysisStatus({ ...result.status, analyzerVersion: 'other-version' }),
    createAnalysisStatus({ ...result.status, completeness: 'unsupported', stopReason: 'unsupported-input' }),
    { ...result.status, schemaVersion: 99 },
    { ...result.status, completeness: 'unknown' },
    { ...result.status, arbitrary: true },
  ];
  for (const status of statuses) expectNoPublicAuthority(provider, { ...result, status });
  expectNoPublicAuthority(provider, { ...result, completeness: { ...result.completeness, capped: true } });
});

test('#4929 bounded authority requires exact IDs, matched identity, and source provenance', async () => {
  const { provider, result } = await fixture();
  for (const coverage of [null, {}, { recordKinds: ['type', 'vtable', 'conformance'] }, { entityIds: [] }, { entityIds: 'type@0x100' }, { entityIds: ['type@0x100'], unknown: true }]) {
    const identity = createLanguageMetadataIdentity({ ...result.identity, coverage });
    expectNoPublicAuthority(provider, { ...result, identity });
  }
  for (const changes of [
    { verdict: 'identity-mismatch' }, { verdict: 'malformed' }, { verdict: 'ambiguous' },
    { expected: 'foreign-binary' }, { observed: 'foreign-binary' },
    { binaryIdentity: null }, { providerId: 'metadata.foreign' }, { ecosystem: 'go' },
  ]) {
    const identity = createLanguageMetadataIdentity({ ...result.identity, ...changes });
    expectNoPublicAuthority(provider, { ...result, identity });
  }
  const source = provider.types().records[0];
  for (const changes of [{ entityId: 'type@0x999' }, { providerId: 'metadata.foreign' }, { providerVersion: 'other' }, { ecosystem: 'go' }, { buildIdentity: 'foreign-binary' }, { buildIdentity: null }]) {
    const record = createLanguageMetadataRecord({ ...source, ...changes });
    assert.equal(isLanguageRecordAuthoritative(result, record), false);
  }
});
