import test from 'node:test';
import assert from 'node:assert/strict';

import { parseCil } from '../../../js/managed/cil/parser.js';
import { parseCil as parseCilBase } from '../../../js/managed/cil/parser-base.js';
import { overlayCilMetadata } from '../../../js/managed/cil/parser-overlay.js';
import { buildCil } from '../fixtures/medium-cil.mjs';

const pad = (b) => { const p = new Uint8Array(Math.ceil(b.length / 4) * 4); p.set(b); return p; };
const stringsHeap = (names) => pad(Uint8Array.from([0, ...names.flatMap((n) => [...new TextEncoder().encode(n), 0])]));

// Raw overlay path: surfaces the specific fail-closed codes that the parseCil
// probe facade collapses to cil-unsupported-binary.
const rawParse = (bytes) => overlayCilMetadata(bytes, parseCilBase(bytes));

// Parse a fixture whose #Strings heap carries defaultNames; the builder's
// inline heap only covers its own names, so rebuild with an extended one.
function parseWithStrings(caseOptions) {
  const first = buildCil(caseOptions);
  const tablesStream = first.layout.streams.find((s) => s.name === '#~');
  const tablesBytes = first.bytes.slice(tablesStream.offset, tablesStream.offset + tablesStream.size);
  // Carry the first build's blob heap: per-method signature blobs appended by
  // the builder live past the legacy prefix, and signature-bound validation
  // (param arity, property signatures) must be able to read them back.
  const blobStream = first.layout.streams.find((s) => s.name === '#Blob');
  const blobBytes = blobStream
    ? pad(first.bytes.slice(blobStream.offset, blobStream.offset + blobStream.size))
    : pad(Uint8Array.of(0, 3, 0, 0, 1, 2, 6, 8));
  const bytes = buildCil({
    ...caseOptions,
    streams: [
      { name: '#~', bytes: tablesBytes },
      { name: '#Strings', bytes: stringsHeap(defaultNames) },
      { name: '#Blob', bytes: blobBytes },
    ],
  }).bytes;
  return bytes;
}


const defaultNames = ['Run', 'Widget', 'Example', 'P', 'Value', 'Tick'];
// HASTHIS property signature: 0 params, int32 return (II.23.2.5). Appended
// via buildCil's blobs option; its heap offset is PROPERTY_SIG_BLOB_INDEX.
const PROPERTY_SIG_BLOB = Uint8Array.of(0x08, 0x00, 0x08); // HASTHIS property, 0 params, int32 return
const PROPERTY_SIG_BLOB_INDEX = 8;

test('#7623 Param rows bind flags, sequence, and names onto their MethodDef', () => {
  // Param rows: Flags / Sequence / Name — Out(0x2) on Sequence 1, In(0x1) on Sequence 2.
  const params = new Uint8Array(12);
  const pv = new DataView(params.buffer);
  pv.setUint16(0, 0x0002, true); pv.setUint16(2, 1, true); pv.setUint16(4, 20, true); // 'P'
  pv.setUint16(6, 0x0001, true); pv.setUint16(8, 2, true); pv.setUint16(10, 20, true);
  const image = parseCil(parseWithStrings({
    // (int32, int32) -> void — declared arity must cover both Param rows.
    methods: [{ name: 'Run', body: [0x2a], signature: [0, 2, 1, 0x08, 0x08] }],
    extraRows: [[0x08, { count: 2, bytes: params }]],
  }));
  assert.deepEqual(image.methods[0].params, ['0x08000001', '0x08000002']);
  assert.equal(image.params.length, 2);
  assert.equal(image.params[0].flags, 0x0002);
  assert.equal(image.params[0].sequence, 1);
  assert.equal(image.params[0].name, 'P');
  assert.equal(image.params[0].ownerToken, '0x06000001');
  assert.equal(image.params[1].flags, 0x0001);
});

test('#7623 differing In/Out flags change the canonical method surface', () => {
  const paramRow = (flags) => {
    const params = new Uint8Array(6);
    const pv = new DataView(params.buffer);
    pv.setUint16(0, flags, true); pv.setUint16(2, 1, true); pv.setUint16(4, 20, true);
    return parseWithStrings({
      methods: [{ name: 'Run', body: [0x2a], signature: [0, 1, 1, 0x08] }],
      extraRows: [[0x08, { count: 1, bytes: params }]],
    });
  };
  const image = parseCil(paramRow(0x0002));
  assert.equal(image.params[0].flags, 0x0002);
  const twin = parseCil(paramRow(0x0001));
  assert.equal(twin.params[0].flags, 0x0001);
  assert.notEqual(JSON.stringify(twin.params), JSON.stringify(image.params));
});

test('#7623 malformed Param rows fail closed', () => {
  const bad = (rows) => rawParse(parseWithStrings({ extraRows: rows }));
  // reserved flag bits
  const reserved = new Uint8Array(6);
  new DataView(reserved.buffer).setUint16(0, 0x8000, true);
  new DataView(reserved.buffer).setUint16(2, 1, true);
  new DataView(reserved.buffer).setUint16(4, 20, true);
  assert.throws(() => bad([[0x08, { count: 1, bytes: reserved }]]), /cil-param-flags-invalid/);
  // In/Out direction on the return parameter (Sequence 0)
  const retDirection = new Uint8Array(6);
  new DataView(retDirection.buffer).setUint16(0, 0x0002, true);
  assert.throws(() => bad([[0x08, { count: 1, bytes: retDirection }]]), /cil-param-return-direction-invalid/);
});

test('#7637 PropertyMap/Property/MethodSemantics reach the canonical type surface', () => {
  const propertyMap = new Uint8Array(4);
  const pmv = new DataView(propertyMap.buffer);
  pmv.setUint16(0, 1, true); pmv.setUint16(2, 1, true); // parent rid 1, list 1
  const property = new Uint8Array(6);
  const prv = new DataView(property.buffer);
  prv.setUint16(0, 0, true); prv.setUint16(2, 22, true); prv.setUint16(4, PROPERTY_SIG_BLOB_INDEX, true); // 'Value', blob 1
  // Setter (0x0001) on MethodDef rid 1, associated with Property rid 1.
  const semantics = new Uint8Array(6);
  const msv = new DataView(semantics.buffer);
  msv.setUint16(0, 0x0001, true);
  msv.setUint16(2, 1, true); // Method: plain MethodDef table index, rid 1 (II.22.28)
  msv.setUint16(4, 3, true); // HasSemantics coded: Property rid 1 (tag 1)
  const image = parseCil(parseWithStrings({
    blobs: [PROPERTY_SIG_BLOB],
    extraRows: [
      [0x15, { count: 1, bytes: propertyMap }],
      [0x17, { count: 1, bytes: property }],
      [0x18, { count: 1, bytes: semantics }],
    ],
  }));
  assert.deepEqual(image.types[0].propertyTokens, ['0x17000001']);
  const property2 = image.properties[0];
  assert.equal(property2.ownerToken, '0x02000001');
  assert.equal(property2.name, 'Value');
  assert.deepEqual(property2.accessors, [{ kind: 'setter', methodToken: '0x06000001' }]);
});

test('#7637 property and accessor bindings fail closed', () => {
  const bad = (rows) => rawParse(parseWithStrings({ extraRows: rows }));
  const propertyMap = new Uint8Array(4);
  new DataView(propertyMap.buffer).setUint16(0, 1, true);
  new DataView(propertyMap.buffer).setUint16(2, 1, true);
  const property = new Uint8Array(6);
  new DataView(property.buffer).setUint16(2, 5, true);
  // unknown semantics kind
  const badKind = new Uint8Array(6);
  const bkv = new DataView(badKind.buffer);
  bkv.setUint16(0, 0x0040, true); bkv.setUint16(2, 2, true); bkv.setUint16(4, 3, true);
  assert.throws(() => bad([[0x15, { count: 1, bytes: propertyMap }], [0x17, { count: 1, bytes: property }], [0x18, { count: 1, bytes: badKind }]]), /cil-method-semantics-kind-invalid/);
  // accessor method that is not a MethodDef (MemberRef-coded)
  const memberRef = new Uint8Array(6);
  const mrv = new DataView(memberRef.buffer);
  mrv.setUint16(0, 0x0001, true); mrv.setUint16(2, 3, true); mrv.setUint16(4, 3, true);
  assert.throws(() => bad([[0x15, { count: 1, bytes: propertyMap }], [0x17, { count: 1, bytes: property }], [0x18, { count: 1, bytes: memberRef }]]), /cil-method-semantics-method-invalid/);
  // property map pointing outside the TypeDef table
  const orphanMap = new Uint8Array(4);
  const omv = new DataView(orphanMap.buffer);
  omv.setUint16(0, 9, true); omv.setUint16(2, 1, true);
  assert.throws(() => bad([[0x15, { count: 1, bytes: orphanMap }], [0x17, { count: 1, bytes: property }]]), /cil-property-map-parent-invalid/);
});

test('#7659 EventMap/Event/MethodSemantics reach the canonical type surface', () => {
  const eventMap = new Uint8Array(4);
  const emv = new DataView(eventMap.buffer);
  emv.setUint16(0, 1, true); emv.setUint16(2, 1, true); // parent rid 1, list 1
  const event = new Uint8Array(6);
  const evv = new DataView(event.buffer);
  evv.setUint16(0, 0, true); evv.setUint16(2, 28, true); evv.setUint16(4, 4, true); // 'Tick', TypeDef rid 1 coded
  // AddOn (0x0008) on MethodDef rid 1, associated with Event rid 1 (tag 0).
  const semantics = new Uint8Array(6);
  const msv = new DataView(semantics.buffer);
  msv.setUint16(0, 0x0008, true);
  msv.setUint16(2, 1, true); // Method: plain MethodDef table index, rid 1 (II.22.28)
  msv.setUint16(4, 2, true); // HasSemantics coded: Event rid 1 (tag 0)
  const image = parseCil(parseWithStrings({
    extraRows: [
      [0x12, { count: 1, bytes: eventMap }],
      [0x14, { count: 1, bytes: event }],
      [0x18, { count: 1, bytes: semantics }],
    ],
  }));
  assert.deepEqual(image.types[0].eventTokens, ['0x14000001']);
  const eventRow = image.events[0];
  assert.equal(eventRow.ownerToken, '0x02000001');
  assert.equal(eventRow.name, 'Tick');
  assert.equal(eventRow.eventTypeToken, '0x02000001');
  assert.deepEqual(eventRow.accessors, [{ kind: 'addOn', methodToken: '0x06000001' }]);
});

test('#7659 malformed event bindings fail closed', () => {
  const bad = (rows) => rawParse(parseWithStrings({ extraRows: rows }));
  const eventMap = new Uint8Array(4);
  new DataView(eventMap.buffer).setUint16(0, 1, true);
  new DataView(eventMap.buffer).setUint16(2, 1, true);
  const event = new Uint8Array(6);
  new DataView(event.buffer).setUint16(2, 6, true);
  // EventType coded index outside TypeDefOrRef row range
  const badType = new Uint8Array(6);
  const btv = new DataView(badType.buffer);
  btv.setUint16(2, 6, true); btv.setUint16(4, 0x0030, true); // TypeDef rid 12
  assert.throws(() => bad([[0x12, { count: 1, bytes: eventMap }], [0x14, { count: 1, bytes: badType }]]), /cil-event-type-invalid/);
  // event map parent outside the TypeDef table
  const orphanMap = new Uint8Array(4);
  const omv = new DataView(orphanMap.buffer);
  omv.setUint16(0, 9, true); omv.setUint16(2, 1, true);
  assert.throws(() => bad([[0x12, { count: 1, bytes: orphanMap }], [0x14, { count: 1, bytes: event }]]), /cil-event-map-parent-invalid/);
  // accessor method rid outside MethodDef table
  const semantics = new Uint8Array(6);
  const msv = new DataView(semantics.buffer);
  msv.setUint16(0, 0x0008, true); msv.setUint16(2, 12, true); msv.setUint16(4, 2, true);
  assert.throws(() => bad([[0x12, { count: 1, bytes: eventMap }], [0x14, { count: 1, bytes: event }], [0x18, { count: 1, bytes: semantics }]]), /cil-method-semantics-method-invalid/);
});

test('#7606 catch clauses accept only TypeDefOrRef tokens within row ranges', () => {
  // Reuse the pinned #3885 EH builder (declares a resolvable one-row TypeRef).
  const bytes = buildEhFixture({ clause: { kind: 'catch', classTokenOrFilter: 0x06000001 } });
  assert.throws(() => rawParse(bytes), /cil-invalid-catch-token-kind/);
  // out-of-range TypeRef rid
  const outOfRange = buildEhFixture({ clause: { kind: 'catch', classTokenOrFilter: 0x01000009 } });
  assert.throws(() => rawParse(outOfRange), /cil-invalid-catch-token-rid/);
  // valid TypeRef rid 1 stays publishable
  const valid = buildEhFixture({ clause: { kind: 'catch', classTokenOrFilter: 0x01000001 } });
  const image = rawParse(valid);
  assert.equal(image.methodBodies[0].exceptionClauses[0].classTokenOrFilter, 0x01000001);
});

function buildEhFixture({ clause }) {
  // Inlined from tests/phase11/cil/cil-exception-clause-range-3885.test.mjs (kept in sync).
  const buf = new Uint8Array(0x900);
  const view = new DataView(buf.buffer);
  buf[0] = 0x4d; buf[1] = 0x5a;
  view.setUint32(0x3c, 0x80, true);
  buf.set([0x50, 0x45, 0, 0], 0x80);
  view.setUint16(0x86, 1, true);
  view.setUint16(0x94, 0xe0, true);
  const optionalOffset = 0x98;
  view.setUint16(optionalOffset, 0x10b, true);
  view.setUint32(optionalOffset + 92, 16, true);
  view.setUint32(optionalOffset + 96 + 14 * 8, 0x2000, true);
  view.setUint32(optionalOffset + 96 + 14 * 8 + 4, 72, true);
  const sectionOffset = optionalOffset + 0xe0;
  view.setUint32(sectionOffset + 8, 0x700, true);
  view.setUint32(sectionOffset + 12, 0x2000, true);
  view.setUint32(sectionOffset + 16, 0x700, true);
  view.setUint32(sectionOffset + 20, 0x200, true);
  const cliOffset = 0x200;
  view.setUint32(cliOffset, 72, true);
  view.setUint32(cliOffset + 8, 0x2100, true);
  view.setUint32(cliOffset + 12, 0x200, true);
  const metadataOffset = 0x300;
  view.setUint32(metadataOffset, 0x424a5342, true);
  view.setUint16(metadataOffset + 4, 1, true);
  view.setUint16(metadataOffset + 6, 1, true);
  const version = new TextEncoder().encode('v4.0.30319\0\0');
  view.setUint32(metadataOffset + 12, version.length, true);
  buf.set(version, metadataOffset + 16);
  const flagsOffset = (metadataOffset + 16 + version.length + 3) & ~3;
  view.setUint16(flagsOffset + 2, 1, true);
  let streamPos = flagsOffset + 4;
  view.setUint32(streamPos, 0x80, true);
  view.setUint32(streamPos + 4, 0x80, true);
  streamPos += 8;
  buf.set(new TextEncoder().encode('#~\0'), streamPos);
  const tablesOffset = metadataOffset + 0x80;
  view.setUint32(tablesOffset + 8, (1 << 1) | (1 << 2) | (1 << 6), true);
  let tablePos = tablesOffset + 24;
  view.setUint32(tablePos, 1, true); tablePos += 4; // TypeRef
  view.setUint32(tablePos, 1, true); tablePos += 4; // TypeDef
  view.setUint32(tablePos, 1, true); tablePos += 4; // MethodDef
  tablePos += 6; // TypeRef row (nulls)
  view.setUint32(tablePos, 0, true); tablePos += 4;
  view.setUint16(tablePos, 0, true); tablePos += 2;
  view.setUint16(tablePos, 0, true); tablePos += 2;
  view.setUint16(tablePos, 0, true); tablePos += 2;
  view.setUint16(tablePos, 1, true); tablePos += 2;
  view.setUint16(tablePos, 1, true); tablePos += 2;
  view.setUint32(tablePos, 0x2300, true);
  const codeSize = 16;
  const methodOffset = 0x500;
  view.setUint16(methodOffset, 0x300b, true);
  view.setUint16(methodOffset + 2, 8, true);
  view.setUint32(methodOffset + 4, codeSize, true);
  view.setUint32(methodOffset + 8, 0, true);
  const codeOffset = methodOffset + 12;
  buf.fill(0x00, codeOffset, codeOffset + codeSize);
  buf[codeOffset + codeSize - 1] = 0x2a;
  const kindFlags = clause.kind === 'filter' ? 1 : clause.kind === 'finally' ? 2 : clause.kind === 'fault' ? 4 : 0;
  const extraOffset = (codeOffset + codeSize + 3) & ~3;
  const dataSize = 4 + 12;
  buf[extraOffset] = 0x01;
  buf[extraOffset + 1] = dataSize & 0xff;
  const clauseOffset = extraOffset + 4;
  view.setUint16(clauseOffset, kindFlags, true);
  view.setUint16(clauseOffset + 2, clause.tryOffset ?? 0, true);
  buf[clauseOffset + 4] = clause.tryLength ?? 4;
  view.setUint16(clauseOffset + 5, clause.handlerOffset ?? 8, true);
  buf[clauseOffset + 7] = clause.handlerLength ?? 4;
  view.setUint32(clauseOffset + 8, clause.classTokenOrFilter, true);
  return buf;
}

test('#7623 ParamPtr indirection resolves ParamList ranges to physical Param rids', () => {
  // #-metadata: the method's ParamList points at ParamPtr rows that redirect
  // to (unordered) physical Param rows. The binding must follow the pointer
  // and keep owner/sequence authority (#7623 R0 review).
  const paramPtr = new Uint8Array(2);
  new DataView(paramPtr.buffer).setUint16(0, 2, true); // pointer rid 1 → Param rid 2
  const paramPtr2 = new Uint8Array(2);
  new DataView(paramPtr2.buffer).setUint16(0, 1, true); // pointer rid 2 → Param rid 1
  const params = new Uint8Array(12);
  const pv = new DataView(params.buffer);
  pv.setUint16(0, 0x0002, true); pv.setUint16(2, 1, true); pv.setUint16(4, 20, true); // 'P' Out seq 1
  pv.setUint16(6, 0x0001, true); pv.setUint16(8, 2, true); pv.setUint16(10, 20, true); // 'P' In seq 2
  const image = parseCil(parseWithStrings({
    methods: [{ name: 'Run', body: [0x2a], signature: [0, 2, 1, 0x08, 0x08] }],
    extraRows: [
      [0x07, { count: 2, bytes: new Uint8Array([...paramPtr, ...paramPtr2]) }],
      [0x08, { count: 2, bytes: params }],
    ],
  }));
  assert.deepEqual(image.methods[0].params, ['0x08000002', '0x08000001']);
  assert.equal(image.params[0].sequence, 1);
  assert.equal(image.params[1].sequence, 2);
  assert.equal(image.params[0].ownerToken, '0x06000001');
});

test('#7623 duplicate sequences and arity overflow fail closed', () => {
  const paramRow = (sequence, extra = 0) => {
    const bytes = new Uint8Array(6 + extra);
    const v = new DataView(bytes.buffer);
    v.setUint16(0, 0x0001, true); v.setUint16(2, sequence, true); v.setUint16(4, 20, true);
    return bytes;
  };
  // duplicate sequence within one owner
  assert.throws(() => rawParse(parseWithStrings({
    methods: [{ name: 'Run', body: [0x2a], signature: [0, 2, 1, 0x08, 0x08] }],
    extraRows: [[0x08, { count: 2, bytes: new Uint8Array([...paramRow(1), ...paramRow(1)]) }]],
  })), /cil-param-sequence-invalid/);
  // more param rows than the declared signature arity
  assert.throws(() => rawParse(parseWithStrings({
    methods: [{ name: 'Run', body: [0x2a] }], // default signature arity 0
    extraRows: [[0x08, { count: 1, bytes: paramRow(1) }]],
  })), /cil-param-arity-exceeded/);
});

test('#7637/#7659 MethodSemantics kind must match the association table', () => {
  const fixture = (semantics, assoc) => {
    const propertyMap = new Uint8Array(4);
    const pmv = new DataView(propertyMap.buffer);
    pmv.setUint16(0, 1, true); pmv.setUint16(2, 1, true);
    const property = new Uint8Array(6);
    const prv = new DataView(property.buffer);
    prv.setUint16(0, 0, true); prv.setUint16(2, 22, true); prv.setUint16(4, PROPERTY_SIG_BLOB_INDEX, true);
    const eventMap = new Uint8Array(4);
    const emv = new DataView(eventMap.buffer);
    emv.setUint16(0, 1, true); emv.setUint16(2, 1, true);
    const event = new Uint8Array(6);
    const evv = new DataView(event.buffer);
    evv.setUint16(0, 0, true); evv.setUint16(2, 28, true); evv.setUint16(4, 4, true);
    const rows = [
      [0x15, { count: 1, bytes: propertyMap }],
      [0x17, { count: 1, bytes: property }],
      [0x12, { count: 1, bytes: eventMap }],
      [0x14, { count: 1, bytes: event }],
      [0x18, { count: 1, bytes: semantics }],
    ];
    if (assoc === 0x17) rows.splice(2, 2); // property association only
    else rows.splice(0, 2); // event association only
    return rawParse(parseWithStrings({ blobs: [PROPERTY_SIG_BLOB], extraRows: rows }));
  };
  // addOn (event-only) against a Property association
  const eventSemantics = new Uint8Array(6);
  const esv = new DataView(eventSemantics.buffer);
  esv.setUint16(0, 0x0008, true); esv.setUint16(2, 1, true); esv.setUint16(4, 3, true);
  assert.throws(() => fixture(eventSemantics, 0x17), /cil-method-semantics-kind-association-invalid/);
  // setter (property-only) against an Event association
  const setterSemantics = new Uint8Array(6);
  const ssv = new DataView(setterSemantics.buffer);
  ssv.setUint16(0, 0x0001, true); ssv.setUint16(2, 1, true); ssv.setUint16(4, 2, true);
  assert.throws(() => fixture(setterSemantics, 0x14), /cil-method-semantics-kind-association-invalid/);
});

test('#7637 duplicate accessor roles fail closed', () => {
  const propertyMap = new Uint8Array(4);
  const pmv = new DataView(propertyMap.buffer);
  pmv.setUint16(0, 1, true); pmv.setUint16(2, 1, true);
  const property = new Uint8Array(6);
  const prv = new DataView(property.buffer);
  prv.setUint16(0, 0, true); prv.setUint16(2, 22, true); prv.setUint16(4, PROPERTY_SIG_BLOB_INDEX, true);
  const semanticsRow = () => {
    const semantics = new Uint8Array(6);
    const msv = new DataView(semantics.buffer);
    msv.setUint16(0, 0x0001, true); msv.setUint16(2, 1, true); msv.setUint16(4, 3, true);
    return semantics;
  };
  assert.throws(() => rawParse(parseWithStrings({
    blobs: [PROPERTY_SIG_BLOB],
    extraRows: [
      [0x15, { count: 1, bytes: propertyMap }],
      [0x17, { count: 1, bytes: property }],
      [0x18, { count: 2, bytes: new Uint8Array([...semanticsRow(), ...semanticsRow()]) }],
    ],
  })), /cil-method-semantics-accessor-duplicate/);
});

test('#7637 the property signature participates in the canonical projection', () => {
  const propertyMap = new Uint8Array(4);
  const pmv = new DataView(propertyMap.buffer);
  pmv.setUint16(0, 1, true); pmv.setUint16(2, 1, true);
  const property = new Uint8Array(6);
  const prv = new DataView(property.buffer);
  prv.setUint16(0, 0, true); prv.setUint16(2, 22, true); prv.setUint16(4, PROPERTY_SIG_BLOB_INDEX, true);
  const semantics = new Uint8Array(6);
  const msv = new DataView(semantics.buffer);
  msv.setUint16(0, 0x0001, true); msv.setUint16(2, 1, true); msv.setUint16(4, 3, true);
  // property signature blob: HASTHIS property getter, 0 params, int32 return
  const image = parseCil(parseWithStrings({
    blobs: [PROPERTY_SIG_BLOB],
    extraRows: [
      [0x15, { count: 1, bytes: propertyMap }],
      [0x17, { count: 1, bytes: property }],
      [0x18, { count: 1, bytes: semantics }],
    ],
  }));
  assert.deepEqual(image.properties[0].signature, { parameters: 0, returnValue: { stackType: 'int32', bits: 32 } });
});

test('#7623 sequence gaps cannot hide behind a mid-range mode switch', () => {
  const paramRow = (sequence) => {
    const bytes = new Uint8Array(6);
    const v = new DataView(bytes.buffer);
    // flags 0: a Sequence-0 return row may not carry direction bits.
    v.setUint16(0, sequence === 0 ? 0 : 0x0001, true); v.setUint16(2, sequence, true); v.setUint16(4, 20, true);
    return bytes;
  };
  // [0,2]: the old dual-mode check let the 2 pass as "1-start" at j=1.
  assert.throws(() => rawParse(parseWithStrings({
    methods: [{ name: 'Run', body: [0x2a], signature: [0, 2, 1, 0x08, 0x08] }],
    extraRows: [[0x08, { count: 2, bytes: new Uint8Array([...paramRow(0), ...paramRow(2)]) }]],
  })), /cil-param-sequence-invalid/);
  // [0,1,3]: same mode-switch hole one slot later.
  assert.throws(() => rawParse(parseWithStrings({
    methods: [{ name: 'Run', body: [0x2a], signature: [0, 3, 1, 0x08, 0x08, 0x08] }],
    extraRows: [[0x08, { count: 3, bytes: new Uint8Array([...paramRow(0), ...paramRow(1), ...paramRow(3)]) }]],
  })), /cil-param-sequence-invalid/);
});
