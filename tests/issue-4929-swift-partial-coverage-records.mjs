// Regression for #4929: SwiftMetadataProvider.probe() published matched-partial
// coverage whose `recordKinds` spanned type/vtable/conformance while the
// coordinate selector only listed type descriptor addresses. Parsed vtable and
// conformance records therefore failed the conjunctive coverage check in
// isLanguageRecordAuthoritative() and could never become authoritative.
// Partial coverage must name exactly the parsed, address-bearing records.
import assert from 'node:assert/strict';

import {
  createLanguageMetadataIdentity,
  createLanguageMetadataRecord,
  createLanguageMetadataResult,
  isLanguageRecordAuthoritative,
} from '../js/metadata/provider.js';
import { SwiftMetadataProvider } from '../js/metadata/swift.js';

const BINARY_IDENTITY = 'sha256:hex-4929';

function makeReader(mem) {
  return async (addr, len) => {
    const a = Number(addr);
    if (a < 0 || a >= mem.length) return null;
    return mem.subarray(a, Math.min(mem.length, a + len));
  };
}

function buildPartialSwiftFixture() {
  const mem = new Uint8Array(0x8000);
  const dv = new DataView(mem.buffer);

  // __swift5_types relative pointer table at 0x1000 -> class descriptor 0x1100
  dv.setInt32(0x1000, 0x1100 - 0x1000, true);

  // Class nominal descriptor at 0x1100: flags = class (0x10) | HAS_VTABLE
  // (bit 15 of the specific section -> bit 31), non-generic, metadataInit 0,
  // no resilient superclass.
  dv.setUint32(0x1100, 0x80000010, true);
  dv.setInt32(0x1104, 0, true); // parent
  dv.setInt32(0x1108, 0x1200 - 0x1108, true); // name -> 0x1200
  dv.setInt32(0x110c, 0, true); // metadata accessor
  dv.setInt32(0x1110, 0, true); // field descriptor (absent)
  // 0x1114..0x112c: class descriptor tail (zeroed).
  // Class vtable header at descriptor + 44: { vtableOffset, count }
  dv.setUint32(0x112c, 0, true);
  dv.setUint32(0x1130, 1, true); // one method entry at 0x1134
  dv.setInt32(0x1138, 0x5000 - 0x1138, true); // parsed implementation target
  const nameStr = 'Foo';
  for (let i = 0; i < nameStr.length; i++) mem[0x1200 + i] = nameStr.charCodeAt(i);
  mem[0x1200 + nameStr.length] = 0;

  // __swift5_proto conformance table at 0x2000 -> descriptor 0x3000.
  dv.setInt32(0x2000, 0x3000 - 0x2000, true);
  dv.setInt32(0x3000, 0x3100 - 0x3000, true); // protocol reference (no protocol section => not proof-safe)
  dv.setInt32(0x3004, 0x1100 - 0x3004, true); // type reference -> the parsed class
  dv.setInt32(0x3008, 0x4000 - 0x3008, true); // witness table (never projected)
  dv.setUint32(0x300c, 0, true); // flags: direct type reference

  return mem;
}

async function partialProbe() {
  const provider = new SwiftMetadataProvider({
    sections: [
      { name: '__swift5_types', section: '__swift5_types', size: 4, vmAddr: 0x1000n },
      { name: '__swift5_proto', section: '__swift5_proto', size: 4, vmAddr: 0x2000n },
    ],
    readAt: makeReader(buildPartialSwiftFixture()),
    binaryIdentity: BINARY_IDENTITY,
  });
  const probe = await provider.probe();
  assert.equal(probe.identity.verdict, 'matched-partial', 'fixture model must be partial (unprojectable witness table)');
  assert.equal(probe.authoritative, true, 'matched-partial is authoritative-verdict');
  return { provider, probe };
}

// Complete result controls continue to exercise non-authoritative verdicts.
// The positive regression below uses the actual incomplete probe() result.
function coverageResult(identity) {
  return createLanguageMetadataResult({
    identity,
    completeness: { present: true, declared: 3, scanned: 3, parsed: 3, complete: true },
  });
}

const { provider, probe } = await partialProbe();
const types = provider.types();
const vtables = provider.vtables();
const conformances = provider.conformances();
assert.equal(types.records.length, 1);
assert.equal(vtables.records.length, 1);
assert.equal(conformances.records.length, 1);

const typeRecord = types.records[0];
const vtableRecord = vtables.records[0];
const conformanceRecord = conformances.records[0];

// (5) Distinct type/vtable/conformance addresses: no accidental overlap that
// could mask the coverage coordinate mismatch.
assert.ok(typeRecord.address && vtableRecord.address && conformanceRecord.address);
assert.equal(new Set([typeRecord.address, vtableRecord.address, conformanceRecord.address]).size, 3);
assert.notEqual(typeRecord.address, vtableRecord.address);
assert.notEqual(vtableRecord.address, conformanceRecord.address);
assert.notEqual(typeRecord.address, conformanceRecord.address);

const result = probe;

// The kind dimension of the published coverage keeps covering all three
// Swift record kinds.
assert.deepEqual([...probe.identity.coverage.recordKinds].sort(), ['conformance', 'type', 'vtable']);

// (1) covered type -> authoritative
assert.equal(isLanguageRecordAuthoritative(result, typeRecord), true, 'parsed covered type must be authoritative');
// (2) covered vtable -> authoritative
assert.equal(isLanguageRecordAuthoritative(result, vtableRecord), true, 'parsed covered vtable must be authoritative (#4929)');
// (3) covered conformance -> authoritative
assert.equal(isLanguageRecordAuthoritative(result, conformanceRecord), true, 'parsed covered conformance must be authoritative (#4929)');

// (4) records outside coverage -> non-authoritative (fail closed). These model
// unparsed or forged coordinates: no unparsed record may ride the widened
// coverage into authority.
const swiftRecord = (input) => createLanguageMetadataRecord({
  providerId: 'metadata.swift',
  providerVersion: '1.0.0',
  ecosystem: 'swift',
  buildIdentity: BINARY_IDENTITY,
  ...input,
});
const outsideCoverage = [
  swiftRecord({ kind: 'type', entityId: 'type@0x9999', address: '0x9999' }),
  swiftRecord({ kind: 'vtable', entityId: 'vtable@0x9998', address: '0x9998' }),
  swiftRecord({ kind: 'conformance', entityId: 'conf@0x9997', address: '0x9997' }),
  swiftRecord({ kind: 'vtable', entityId: `vtable@${typeRecord.address}`, address: typeRecord.address }),
  swiftRecord({ kind: 'type', entityId: `type@${vtableRecord.address}`, address: vtableRecord.address }),
  swiftRecord({ kind: 'conformance', entityId: `conf@${vtableRecord.address}`, address: vtableRecord.address }),
  swiftRecord({ kind: 'type', entityId: `type@${conformanceRecord.address}`, address: conformanceRecord.address }),
  swiftRecord({ kind: 'type', entityId: 'type@Unaddressed', address: null }),
  swiftRecord({ kind: 'symbol', entityId: `type@${typeRecord.address}`, address: typeRecord.address }),
];
for (const record of outsideCoverage) {
  assert.equal(
    isLanguageRecordAuthoritative(result, record),
    false,
    `uncovered ${record.kind} ${record.entityId} must stay non-authoritative`,
  );
}

// (6a) complete model keeps matched-authoritative behavior end to end.
{
  const mem = new Uint8Array(0x4000);
  const dv = new DataView(mem.buffer);
  dv.setUint32(0x1100, 17, true); // struct
  dv.setInt32(0x1104, 0, true);
  dv.setInt32(0x1108, 0x1200 - 0x1108, true);
  dv.setInt32(0x110c, 0, true);
  dv.setInt32(0x1110, 0, true);
  dv.setUint32(0x1114, 0, true);
  dv.setUint32(0x1118, 0, true);
  const nameStr = 'AppState';
  for (let i = 0; i < nameStr.length; i++) mem[0x1200 + i] = nameStr.charCodeAt(i);
  mem[0x1200 + nameStr.length] = 0;
  dv.setInt32(0x1000, 0x1100 - 0x1000, true);

  const completeProvider = new SwiftMetadataProvider({
    sections: [{ name: '__swift5_types', section: '__swift5_types', size: 4, vmAddr: 0x1000n }],
    readAt: makeReader(mem),
    binaryIdentity: BINARY_IDENTITY,
  });
  const completeProbe = await completeProvider.probe();
  assert.equal(completeProbe.identity.verdict, 'matched-authoritative');
  assert.equal(completeProbe.identity.coverage, null);
  assert.equal(completeProbe.completeness.complete, true);
  const completeType = completeProvider.types().records[0];
  assert.equal(isLanguageRecordAuthoritative(completeProbe, completeType), true);
}

// (6b) non-authoritative verdicts keep failing closed even when their
// coverage names the exact parsed records.
for (const verdict of ['identity-mismatch', 'malformed', 'identity-unavailable', 'ambiguous', 'unsupported']) {
  const degraded = createLanguageMetadataIdentity({
    verdict,
    providerId: 'metadata.swift',
    providerVersion: '1.0.0',
    ecosystem: 'swift',
    expected: 'sha256:expected-4929',
    observed: 'sha256:observed-4929',
    binaryIdentity: BINARY_IDENTITY,
    method: 'swift5-abi',
    coverage: probe.identity.coverage,
  });
  const degradedResult = coverageResult(degraded);
  assert.equal(isLanguageRecordAuthoritative(degradedResult, typeRecord), false, `${verdict} must not authorize types`);
  assert.equal(isLanguageRecordAuthoritative(degradedResult, vtableRecord), false, `${verdict} must not authorize vtables`);
  assert.equal(isLanguageRecordAuthoritative(degradedResult, conformanceRecord), false, `${verdict} must not authorize conformances`);
}

// (6c) Whole-model incompleteness remains explicit. The separately proven
// bound covers these records even though witness projection is unavailable.
assert.equal(probe.completeness.complete, false);
assert.equal(probe.status.completeness, 'bounded');
for (const reader of [provider.types, provider.vtables, provider.conformances]) {
  assert.equal(provider.authoritativeRecords(probe, reader).records.length, 1);
}

console.log('issue-4929 swift partial coverage records: ok');
