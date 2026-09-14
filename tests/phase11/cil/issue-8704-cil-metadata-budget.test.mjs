import assert from 'node:assert/strict';
import { parseCil, probeCil } from '../../../js/managed/cil/parser.js';
import { createCilMetadataAdmission, CIL_METADATA_BUDGET_VERSION } from '../../../js/managed/cil/metadata-budget.js';

console.log('[phase11] running CIL metadata admission budget regression (#8704)...');

const align4 = n => Math.ceil(n / 4) * 4;
const utf8 = text => new TextEncoder().encode(text);

function buildCilMetadata({ tables = [], strings = '\0A\0', blobs = [0, 1, 0x2a], heapSizes = 0 }) {
  const entries = [...tables].sort(([a], [b]) => a - b);
  const tableLength = 24 + entries.length * 4 + entries.reduce((n, [, , rowBytes]) => n + rowBytes.length, 0);
  const tableBytes = new Uint8Array(align4(tableLength));
  const tv = new DataView(tableBytes.buffer);
  tableBytes[4] = 2; // tables major version
  tableBytes[6] = heapSizes;
  let valid = 0n, pos = 24;
  for (const [table, count] of entries) { tv.setUint32(pos, count, true); pos += 4; valid |= 1n << BigInt(table); }
  tv.setBigUint64(8, valid, true);
  for (const [, , rowBytes] of entries) { tableBytes.set(rowBytes, pos); pos += rowBytes.length; }

  const heap = bytes => { const out = new Uint8Array(align4(bytes.length)); out.set(bytes); return out; };
  const streams = [
    { name: '#~', bytes: tableBytes },
    { name: '#Strings', bytes: heap(utf8(strings)) },
    { name: '#Blob', bytes: heap(Uint8Array.from(blobs)) },
  ];

  const rootLength = 0x400 + streams.reduce((n, s) => n + s.bytes.length, 0);
  const bytes = new Uint8Array(0x300 + rootLength);
  const v = new DataView(bytes.buffer);
  bytes[0] = 0x4d; bytes[1] = 0x5a;
  v.setUint32(0x3c, 0x80, true);
  bytes.set([0x50, 0x45, 0, 0], 0x80);
  v.setUint16(0x84, 0x014c, true); v.setUint16(0x86, 1, true); v.setUint16(0x94, 0xe0, true);
  const opt = 0x98;
  v.setUint16(opt, 0x10b, true); v.setUint32(opt + 92, 16, true);
  v.setUint32(opt + 96 + 14 * 8, 0x2000, true); v.setUint32(opt + 100 + 14 * 8, 72, true);
  const section = opt + 0xe0;
  v.setUint32(section + 8, bytes.length - 0x200, true); v.setUint32(section + 12, 0x2000, true);
  v.setUint32(section + 16, bytes.length - 0x200, true); v.setUint32(section + 20, 0x200, true);
  v.setUint32(0x200, 72, true); v.setUint16(0x204, 2, true); v.setUint16(0x206, 5, true);
  v.setUint32(0x208, 0x2100, true); v.setUint32(0x20c, rootLength, true); v.setUint32(0x210, 1, true);
  const root = 0x300;
  v.setUint32(root, 0x424a5342, true);
  v.setUint16(root + 4, 1, true); v.setUint16(root + 6, 1, true);
  v.setUint32(root + 12, 12, true);
  bytes.set([...utf8('v4.0.30319'), 0], root + 16);
  const flags = root + 16 + 12;
  v.setUint16(flags + 2, streams.length, true);
  let header = flags + 4, data = root + 0x400;
  for (const stream of streams) {
    const name = utf8(stream.name);
    v.setUint32(header, data - root, true); v.setUint32(header + 4, stream.bytes.length, true);
    bytes.set(name, header + 8);
    header += 8 + align4(name.length + 1);
    bytes.set(stream.bytes, data);
    data += stream.bytes.length;
  }
  return bytes;
}

function rows(table, count, row) {
  const bytes = new Uint8Array(row.length * count);
  for (let i = 0; i < count; i += 1) bytes.set(row, i * row.length);
  return [table, count, bytes];
}

// TypeRef (0x01): ResolutionScope | TypeName | TypeNamespace. At 600k rows the
// coded index widens to 4 bytes, so one row costs 8 input bytes and no long
// string is involved — the exact amplifier shape from the report.
function typeRefFixture(count) {
  const scopeWidth = count >= (1 << 14) ? 4 : 2;
  const row = new Uint8Array(scopeWidth + 4);
  new DataView(row.buffer).setUint16(scopeWidth, 1, true); // TypeName -> "A"
  return buildCilMetadata({ tables: [rows(0x01, count, row)] });
}

// AssemblyRef (0x23): 12 fixed bytes + PublicKeyOrToken + Name + Culture + Hash.
function assemblyRefFixture(count) {
  const row = new Uint8Array(20);
  new DataView(row.buffer).setUint16(14, 1, true); // Name -> "A"
  return buildCilMetadata({ tables: [rows(0x23, count, row)] });
}

// ModuleRef (0x1a) + MemberRef (0x0a) + one TypeRef: several high-cardinality
// tables in one image, so admission has to be aggregate rather than per table.
function memberRefFixture(count) {
  const typeRefRow = new Uint8Array(6);
  new DataView(typeRefRow.buffer).setUint16(2, 1, true);
  const memberRefRow = new Uint8Array(6);
  const mv = new DataView(memberRefRow.buffer);
  mv.setUint16(0, 1 << 3, true); // parent = TypeRef rid 1 (tag 1)
  mv.setUint16(2, 1, true); // Name -> "A"
  return buildCilMetadata({ tables: [
    rows(0x01, 1, typeRefRow),
    rows(0x1a, count, Uint8Array.from([1, 0])),
    rows(0x0a, count, memberRefRow),
  ] });
}

// File (0x26) rows are decoded only by the manifest/security overlay, the second
// full-graph reader the report named (#8704).
function fileFixture(count) {
  const row = Uint8Array.from([0, 0, 0, 0, 3, 0, 1, 0]); // Flags, Name "f.dll", HashValue #Blob 1
  return buildCilMetadata({
    strings: '\0A\0f.dll\0',
    blobs: [0, 3, 0x01, 0x02, 0x03],
    tables: [rows(0x26, count, row)],
  });
}

// GenericParam (0x2a) rows are decoded by the generics reader, so only a
// TypeDef owner makes them legal metadata.
function genericParamFixture(count) {
  const typeDefRow = new Uint8Array(14);
  const tdv = new DataView(typeDefRow.buffer);
  tdv.setUint16(4, 1, true); // Name -> "A"
  tdv.setUint16(10, 1, true); // FieldList
  tdv.setUint16(12, 1, true); // MethodList
  const paramRow = new Uint8Array(8);
  const pv = new DataView(paramRow.buffer);
  pv.setUint16(4, 2, true); // Owner = TypeDef rid 1 (coded, tag 0)
  pv.setUint16(6, 1, true); // Name -> "A"
  return buildCilMetadata({ tables: [rows(0x02, 1, typeDefRow), rows(0x2a, count, paramRow)] });
}

// A resolution scope RID above every ResolutionScope table is malformed
// authority, not a resource stop.
function malformedTypeRefFixture() {
  const row = Uint8Array.from([0x0c, 0, 0, 0, 1, 0]); // scope = TypeRef rid 3, table 0x01 (absent)
  return buildCilMetadata({ tables: [rows(0x01, 3, row)] });
}

function recordingAdmission(limits = {}) {
  const inner = createCilMetadataAdmission(limits);
  const calls = { rows: 0, rowCharges: 0, objects: 0, objectCharges: 0, stringBytes: 0, operations: 0 };
  return Object.freeze({
    version: CIL_METADATA_BUDGET_VERSION,
    limits: inner.limits,
    calls,
    chargeRows: (count, table) => { calls.rows += count; calls.rowCharges += 1; return inner.chargeRows(count, table); },
    chargeObjects: (count) => { calls.objects += count; calls.objectCharges += 1; return inner.chargeObjects(count); },
    chargeStringBytes: (count) => { calls.stringBytes += count; return inner.chargeStringBytes(count); },
    chargeOperations: (count = 1) => { calls.operations += count; return inner.chargeOperations(count); },
    checkpoint: () => inner.checkpoint(),
    usage: () => inner.usage(),
    snapshot: () => inner.snapshot(),
  });
}

const UNBOUNDED = { maxRows: null, maxObjects: null, maxStringBytes: null, maxOperations: null, maxElapsedMs: null };

// 1. A low row budget stops the probe before any row object exists.
{
  const bytes = typeRefFixture(20_000);
  const admitted = recordingAdmission(UNBOUNDED);
  assert.equal(probeCil(bytes, { metadataAdmission: admitted }).supported, true, 'sanity: the shape is valid metadata');
  assert.equal(admitted.calls.rows, 20_000, 'one aggregate charge covers the layout');
  assert.equal(admitted.calls.objects, 20_000, 'an admitted image materializes each row once');
  const bounded = recordingAdmission({ maxRows: 1_000 });
  const stopped = probeCil(bytes, { metadataAdmission: bounded });
  assert.deepEqual(stopped, {
    supported: false, confidence: 0, reason: 'cil-metadata-resource-limit-rows',
    status: 'resource-limited', resourceLimited: true,
  });
  assert.equal(bounded.calls.objects, 0, 'no row object is materialized once admission is refused');
  let thrown = null;
  try { parseCil(bytes, { metadataBudget: { maxRows: 1_000 } }); } catch (error) { thrown = error; }
  assert.equal(thrown?.code, 'cil-metadata-resource-limit-rows');
  assert.equal(thrown?.resourceLimited, true);
  assert.equal(thrown?.resource, 'rows:tables');
  assert.ok(thrown.used >= 20_000 && thrown.limit === 1_000);
}

// 2. The report's 600k-row / ~4.8 MiB shape stops under the default budget.
{
  const bytes = typeRefFixture(600_000);
  assert.ok(bytes.length > 4_000_000, 'fixture keeps the reported size class');
  const probe = probeCil(bytes);
  assert.equal(probe.supported, false);
  assert.equal(probe.reason, 'cil-metadata-resource-limit-rows');
  assert.equal(probe.resourceLimited, true);
  assert.throws(() => parseCil(bytes), error => error.code === 'cil-metadata-resource-limit-rows');
}

// 3. Large metadata inside the budget stays exact.
{
  const bytes = typeRefFixture(20_000);
  const budget = { metadataBudget: { maxRows: 20_000 } };
  assert.equal(probeCil(bytes, budget).supported, true);
  const image = parseCil(bytes, budget);
  assert.equal(image.typeRefs.length, 20_000);
  assert.equal(image.typeRefs[0].token, '0x01000001');
  assert.equal(image.typeRefs[19_999].token, '0x01004e20');
  assert.equal(image.typeRefs[19_999].name, 'A');
  assert.equal(image.typeRefs[19_999].namespace, '');
  assert.throws(() => parseCil(bytes, { metadataBudget: { maxRows: 19_999 } }),
    error => error.code === 'cil-metadata-resource-limit-rows');
}

// 4. Probe and parse each decode the definition graph exactly once: the report
// counted four full decodes across probe + two overlays (#8704).
{
  const bytes = typeRefFixture(500);
  const probeAdmission = recordingAdmission(UNBOUNDED);
  assert.equal(probeCil(bytes, { metadataAdmission: probeAdmission }).supported, true);
  assert.equal(probeAdmission.calls.rowCharges, 1, 'one admission pass per probe');
  assert.equal(probeAdmission.calls.rows, 500);
  assert.equal(probeAdmission.calls.objects, 500, 'one definition materialization per probe');
  const parseAdmission = recordingAdmission(UNBOUNDED);
  assert.equal(parseCil(bytes, { metadataAdmission: parseAdmission }).typeRefs.length, 500);
  assert.equal(parseAdmission.calls.rowCharges, 1, 'one admission pass per parse');
  assert.equal(parseAdmission.calls.rows, 500);
  assert.equal(parseAdmission.calls.objects, 500, 'one definition materialization per parse');
}

// 5. Budget exhaustion stays distinguishable from malformed metadata.
{
  const malformedProbe = probeCil(malformedTypeRefFixture());
  assert.deepEqual(malformedProbe, { supported: false, confidence: 0, reason: 'malformed-pe-cli' });
  const overBudget = probeCil(typeRefFixture(20_000), { metadataBudget: { maxRows: 10 } });
  assert.equal(overBudget.reason, 'cil-metadata-resource-limit-rows');
  assert.equal(overBudget.status, 'resource-limited');
  assert.throws(() => parseCil(malformedTypeRefFixture()),
    error => error.message === 'cil-unsupported-binary' && error.resourceLimited === undefined);
  assert.throws(() => parseCil(typeRefFixture(20_000), { metadataBudget: { maxRows: 10 } }),
    error => error.code === 'cil-metadata-resource-limit-rows' && error.resourceLimited === true);
}

// 6. An abort signal and an elapsed-time budget are observed inside the row loops.
{
  const bytes = typeRefFixture(20_000);
  const controller = new AbortController();
  controller.abort();
  const cancelled = probeCil(bytes, { metadataBudget: { signal: controller.signal } });
  assert.equal(cancelled.reason, 'cil-metadata-cancelled');
  assert.equal(cancelled.resourceLimited, true);
  assert.throws(() => parseCil(bytes, { metadataBudget: { signal: controller.signal } }),
    error => error.name === 'AbortError' && error.cancelled === true);

  let clock = 0;
  const elapsed = probeCil(bytes, {
    metadataBudget: { ...UNBOUNDED, maxElapsedMs: 4, monotonicNow: () => (clock += 1) },
  });
  assert.equal(elapsed.reason, 'cil-metadata-resource-limit-elapsed');
  assert.equal(elapsed.resourceLimited, true);
  assert.ok(clock > 0, 'the injected monotonic clock is what bounded the decode');
}

// 7. Every metadata table shares one admission budget, including the tables only
// the manifest/security and generics readers decode.
{
  const fixtures = [
    ['AssemblyRef', assemblyRefFixture(20_000), 20_000],
    ['MemberRef+ModuleRef', memberRefFixture(5_000), 10_001],
    ['File', fileFixture(20_000), 20_000],
    ['GenericParam', genericParamFixture(20_000), 20_001],
  ];
  for (const [label, bytes, rowCount] of fixtures) {
    const admission = recordingAdmission({ maxRows: 100 });
    const probe = probeCil(bytes, { metadataAdmission: admission });
    assert.equal(admission.calls.rows, rowCount, `${label}: aggregate admission counts the table`);
    assert.equal(probe.supported, false, `${label}: over-budget image is refused`);
    assert.equal(probe.reason, 'cil-metadata-resource-limit-rows', `${label}: rows budget`);
    assert.equal(admission.calls.objects, 0, `${label}: refused before materialization`);
    assert.throws(() => parseCil(bytes, { metadataBudget: { maxRows: 100 } }),
      error => error.code === 'cil-metadata-resource-limit-rows', `${label}: parse stops too`);
  }
}

// 8. An invalid budget is a caller bug and never falls back to unbounded admission.
{
  assert.throws(() => createCilMetadataAdmission({ maxRows: 1.5 }),
    error => error.message === 'cil-metadata-budget-limit-invalid:maxRows');
  assert.throws(() => createCilMetadataAdmission({ maxRows: -1 }),
    error => error.message === 'cil-metadata-budget-limit-invalid:maxRows');
  assert.throws(() => createCilMetadataAdmission({ signal: {} }),
    error => error.message === 'cil-metadata-budget-signal-invalid');
  assert.throws(() => probeCil(typeRefFixture(10), { metadataBudget: { maxRows: 'many' } }),
    error => error.message === 'cil-metadata-budget-limit-invalid:maxRows');
}

console.log('  ok CIL metadata admission budget regression passed');
