import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCil } from '../../../js/managed/cil/parser.js';
import { parseCil as parseCilBase } from '../../../js/managed/cil/parser-base.js';
import { overlayCilMetadata } from '../../../js/managed/cil/parser-overlay.js';
import { CilFrontend } from '../../../js/managed/cil/frontend.js';
import { metadataRowSize } from '../../../js/managed/cil/metadata-layout.js';
import { buildCil, collect } from '../fixtures/medium-cil.mjs';

function rows(width, entries) {
  const bytes = new Uint8Array(width * entries.length);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < entries.length; i++) entries[i](view, i * width);
  return { count:entries.length, bytes };
}
const u16 = (view, offset, value) => view.setUint16(offset, value, true);
const parseStrict = bytes => overlayCilMetadata(bytes, parseCilBase(bytes));

function stringIndexes(values) {
  let cursor = 1;
  const out = {};
  for (const value of values) { out[value] = cursor; cursor += Buffer.byteLength(value) + 1; }
  return out;
}

function paramRows(specs, names = specs.map((_, i) => `p${i + 1}`)) {
  const idx = stringIndexes(names);
  return rows(6, specs.map((spec, i) => (view, p) => {
    u16(view, p, spec.flags ?? 0);
    u16(view, p + 2, spec.sequence);
    u16(view, p + 4, idx[names[i]]);
  }));
}

function metadataFixture({ paramSpecs, paramPointers, methodSignature } = {}) {
  const names = (paramSpecs ?? []).map((_, i) => `p${i + 1}`);
  const extraRows = [];
  if (paramPointers) extraRows.push([0x07, rows(2, paramPointers.map(rid => (view, p) => u16(view, p, rid)))]);
  if (paramSpecs) extraRows.push([0x08, paramRows(paramSpecs, names)]);
  return buildCil({
    tableName:'#-', leadingStrings:names,
    methods:[{ name:'M', owner:0, body:null, signature:methodSignature ?? [0x00, 0x02, 0x01, 0x08, 0x08] }],
    extraRows,
  }).bytes;
}

test('#7623 ParamPtr controls MethodDef.ParamList ownership without changing Param identity', () => {
  const image = parseCil(metadataFixture({
    paramSpecs:[{ sequence:2, flags:0x0002 }, { sequence:1, flags:0x0001 }],
    paramPointers:[2, 1],
  }));
  assert.deepEqual(image.methods[0].params, ['0x08000002', '0x08000001']);
  assert.equal(image.params[0].ownerToken, image.methods[0].token);
  assert.equal(image.params[1].ownerToken, image.methods[0].token);
  assert.deepEqual(image.params.map(row => row.sequence), [2, 1]);
  assert.deepEqual(image.params.map(row => row.flags), [0x0002, 0x0001]);
  const flagsImage = parseCil(metadataFixture({
    paramSpecs:[{ sequence:2, flags:0x0004 }, { sequence:0, flags:0x0008 }],
    paramPointers:[1, 2],
  }));
  assert.deepEqual(flagsImage.params.map(row => row.flags), [0x0004, 0x0008],
    'LCID/Retval are defined ParamAttributes, not reserved bits');
});

test('#7623 rejects duplicate non-zero Sequence and signature-arity overflow', () => {
  assert.throws(() => parseStrict(metadataFixture({
    paramSpecs:[{ sequence:1 }, { sequence:1 }], paramPointers:[1, 2],
  })), /cil-param-sequence-duplicate/);
  assert.throws(() => parseStrict(metadataFixture({
    paramSpecs:[{ sequence:3 }], paramPointers:[1], methodSignature:[0x00, 0x02, 0x01, 0x08, 0x08],
  })), /cil-param-sequence-out-of-range/);
});

test('#7623 MethodDef row width follows ParamPtr in #- metadata', () => {
  const counts = new Array(64).fill(0);
  counts[0x07] = 0x10000;
  counts[0x08] = 1;
  assert.equal(metadataRowSize(0x06, counts, 0), 16,
    'ParamList must become a 4-byte ParamPtr index even when Param itself stays 2 bytes');
});

function semanticFixture({ propertyMethod = 1, semanticsRows = null, propertySignature = [0x28, 0x01, 0x08, 0x08], eventType = 4, types = undefined } = {}) {
  const names = ['P', 'E'];
  const idx = stringIndexes(names);
  const property = rows(6, [(view, p) => { u16(view, p, 0); u16(view, p + 2, idx.P); u16(view, p + 4, 8); }]);
  const propertyMap = rows(4, [(view, p) => { u16(view, p, 1); u16(view, p + 2, 1); }]);
  const event = rows(6, [(view, p) => { u16(view, p, 0); u16(view, p + 2, idx.E); u16(view, p + 4, eventType); }]);
  const eventMap = rows(4, [(view, p) => { u16(view, p, 1); u16(view, p + 2, 1); }]);
  const specs = semanticsRows ?? [
    { semantics:0x0002, method:propertyMethod, association:3 }, // Getter -> Property#1
    { semantics:0x0001, method:2, association:3 }, // Setter -> Property#1
    { semantics:0x0008, method:1, association:2 }, // AddOn -> Event#1
    { semantics:0x0010, method:2, association:2 }, // RemoveOn -> Event#1
    { semantics:0x0020, method:3, association:2 }, // Fire -> Event#1
  ];
  const methodSemantics = rows(6, specs.map(spec => (view, p) => {
    u16(view, p, spec.semantics); u16(view, p + 2, spec.method); u16(view, p + 4, spec.association);
  }));
  return buildCil({
    leadingStrings:names,
    ...(types ? { types } : {}),
    blobs:[propertySignature],
    methods:[
      { name:'get_P', owner:0, body:null, signature:[0x00,0x00,0x08] },
      { name:'set_P', owner:0, body:null, signature:[0x00,0x01,0x01,0x08] },
      { name:'raise_E', owner:0, body:null, signature:[0x00,0x00,0x01] },
    ],
    extraRows:[[0x12,eventMap],[0x14,event],[0x15,propertyMap],[0x17,property],[0x18,methodSemantics]],
  }).bytes;
}

test('#7637/#7659 bind spec-valid Property/Event accessors and preserve Property signature authority', async () => {
  const frontend = new CilFrontend();
  const image = await frontend.open(semanticFixture());
  assert.equal(image.properties.length, 1);
  assert.equal(image.events.length, 1);
  assert.deepEqual(image.properties[0].rawSignature, [0x28,0x01,0x08,0x08]);
  assert.equal(image.properties[0].signature.hasThis, true);
  assert.deepEqual(image.properties[0].signature.propertyType, { stackType:'int32', bits:32, primitive:'i4' });
  assert.equal(image.properties[0].signature.parameters.length, 1);
  assert.deepEqual(image.properties[0].accessors.map(x => x.kind), ['getter','setter']);
  assert.deepEqual(image.events[0].accessors.map(x => x.kind), ['addOn','removeOn','fire']);
  const types = await collect(frontend.enumerateTypes(image));
  assert.deepEqual(types[0].propertyTokens, ['0x17000001']);
  assert.deepEqual(types[0].eventTokens, ['0x14000001']);
  assert.equal(image.properties[0].ownerToken, image.types[0].token);
  assert.equal(image.events[0].ownerToken, image.types[0].token);
});

test('#7637 raw MethodDef RID is authoritative and getter target changes canonical projection', () => {
  const one = parseCil(semanticFixture({ propertyMethod:1 }));
  const two = parseCil(semanticFixture({ propertyMethod:3 }));
  assert.equal(one.properties[0].accessors[0].methodToken, '0x06000001');
  assert.equal(two.properties[0].accessors[0].methodToken, '0x06000003');
  assert.notDeepEqual(one.properties, two.properties);
  const counts = new Array(64).fill(0);
  counts[0x06] = 1; counts[0x0a] = 0x8000; counts[0x14] = 1; counts[0x17] = 1;
  assert.equal(metadataRowSize(0x18, counts, 0), 6,
    'MemberRef cardinality must not widen MethodSemantics.Method');
  counts[0x06] = 0x10000;
  assert.equal(metadataRowSize(0x18, counts, 0), 8,
    'MethodSemantics.Method becomes 4 bytes only when MethodDef itself crosses the table-index boundary');
});

test('#7637/#7659 reject association-kind mismatches and duplicate singleton accessors', () => {
  assert.throws(() => parseStrict(semanticFixture({ semanticsRows:[
    { semantics:0x0008, method:1, association:3 }, // AddOn -> Property
  ] })), /cil-method-semantics-association-kind-invalid/);
  assert.throws(() => parseStrict(semanticFixture({ semanticsRows:[
    { semantics:0x0002, method:1, association:3 },
    { semantics:0x0002, method:2, association:3 },
  ] })), /cil-method-semantics-accessor-duplicate/);
  assert.throws(() => parseStrict(semanticFixture({ semanticsRows:[
    { semantics:0x0002, method:1, association:2 }, // Getter -> Event
  ] })), /cil-method-semantics-association-kind-invalid/);
  assert.throws(() => parseStrict(semanticFixture({ semanticsRows:[
    { semantics:0x0002, method:1, association:3 },
    { semantics:0x0001, method:1, association:3 },
  ] })), /cil-method-semantics-method-conflict/);
});

test('#7637/#7659 accessor methods must belong to the association owner type', () => {
  assert.throws(() => parseStrict(semanticFixture({
    types:[
      { name:'Owner', namespace:'N', fieldList:1, methodList:1 },
      { name:'Other', namespace:'N', fieldList:1, methodList:2 },
    ],
    semanticsRows:[{ semantics:0x0002, method:2, association:3 }],
  })), /cil-method-semantics-owner-mismatch/);
});

test('#7637 malformed PropertySig fails closed instead of publishing opaque exact identity', () => {
  assert.throws(() => parseStrict(semanticFixture({ propertySignature:[0x08,0x01,0x08] })), /cil-property-signature-invalid/);
});

test('#7659 EventType is non-null canonical TypeDefOrRef authority', () => {
  assert.throws(() => parseStrict(semanticFixture({ eventType:0 })), /cil-event-type-required/);
});
