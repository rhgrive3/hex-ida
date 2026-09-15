import assert from 'node:assert/strict';
import { buildCil } from '../fixtures/medium-cil.mjs';
import { parseCil } from '../../../js/managed/cil/parser.js';
import { readCilMetadataContext } from '../../../js/managed/cil/metadata-context.js';
import { readCilGenericMetadata } from '../../../js/managed/cil/metadata-generics.js';
import { createCilMetadataAdmission } from '../../../js/managed/cil/metadata-budget.js';

console.log('[phase11] running issue #8699 CIL metadata #Strings alias interning tests...');

// `parseCil` collapses internal metadata codes to `cil-unsupported-binary`, so the
// exact budget/interning authority is observed on the validated metadata context
// the public pipeline itself builds.
const rawParse = (bytes, options = {}) => readCilMetadataContext(bytes, options);

// Table 0x04 (Field) row = flags(2) + name(s2) + signature(b2) = 6 bytes.
// #8699's amplification needs MANY references to ONE shared #Strings entry. A
// valid way to get that (without an ECMA-335 duplicate-definition identity, see
// #8778) is to give each reference a DIFFERENT owner: N top-level TypeDefs, each
// owning one Field whose Name indexes the same shared long #Strings offset.
function fieldAliasFixture(n, nameLen = 4095) {
  const shared = 'F'.repeat(nameLen);
  const fields = new Uint8Array(n * 6);
  const fv = new DataView(fields.buffer);
  for (let i = 0; i < n; i++) {
    const p = i * 6;
    fv.setUint16(p, 6, true);       // FieldAccess flags
    fv.setUint16(p + 2, 1, true);   // every Field -> shared #Strings offset 1
    fv.setUint16(p + 4, 5, true);   // valid field signature blob
  }
  const types = Array.from({ length: n }, (_, i) => ({
    name: `T${i}`, namespace: '', flags: 1, fieldList: i + 1, methodList: 1,
  }));
  const imageSize = 0x400 + 0x100 + shared.length + n * 14 + n * 6 + n * 12 + 0x2000;
  return buildCil({
    methods: [], types, leadingStrings: [shared],
    extraRows: new Map([[0x04, { count: n, bytes: fields }]]),
    imageSize, metadataSize: imageSize - 0x300,
  }).bytes;
}

// One shared #Strings entry referenced by the definitions reader (TypeDef.Name)
// and by the GenericParam reader (4 rows) in the same parse.
function crossReaderAliasFixture(n = 4, nameLen = 2048) {
  const shared = 'x'.repeat(nameLen);
  const pre = buildCil({
    methods: [],
    types: [{ name: 'placeholder-owner', namespace: '', flags: 1, fieldList: 1, methodList: 1 }],
    leadingStrings: [shared],
  });
  const nameOff = pre.layout.leadingStringIndex[shared];
  const rows = new Uint8Array(n * 8);
  const v = new DataView(rows.buffer);
  for (let i = 0; i < n; i++) {
    const p = i * 8;
    v.setUint16(p, i, true);
    v.setUint16(p + 2, 0, true);
    v.setUint16(p + 4, 2, true); // TypeDef rid 1, tag 0
    v.setUint16(p + 6, nameOff, true);
  }
  const built = buildCil({
    methods: [],
    types: [{ name: 'placeholder-owner', namespace: '', flags: 1, fieldList: 1, methodList: 1 }],
    leadingStrings: [shared],
    extraRows: new Map([[0x2a, { count: n, bytes: rows }]]),
  });
  // Point TypeDef.Name at the exact same leading #Strings offset used by every
  // GenericParam. The referenced entry is decoded once across both readers.
  const tablesStream = built.layout.streams.find(stream => stream.name === '#~' || stream.name === '#-');
  const typeDefPos = tablesStream.offset + built.layout.tables.offsets.get(0x02);
  new DataView(built.bytes.buffer, built.bytes.byteOffset, built.bytes.byteLength)
    .setUint16(typeDefPos + 4, nameOff, true);
  return built.bytes;
}

function countSharedDecodes(run, sharedLen) {
  const originalDecode = TextDecoder.prototype.decode;
  let sharedDecodes = 0;
  TextDecoder.prototype.decode = function (...args) {
    const view = args[0];
    if (view && typeof view.byteLength === 'number' && view.byteLength === sharedLen) sharedDecodes += 1;
    return originalDecode.apply(this, args);
  };
  try { return { result: run(), sharedDecodes }; }
  finally { TextDecoder.prototype.decode = originalDecode; }
}

// Count chargeStringBytes calls carrying exactly `lengthBytes` through a wrapped
// admission, so the interning authority must neither re-charge an aliased offset
// nor launder a charge the per-reference path would have made.
function countingAdmission(lengthBytes) {
  const base = createCilMetadataAdmission({});
  let charges = 0;
  const counting = {
    version: base.version,
    limits: base.limits,
    chargeStringBytes: (count) => { if (count === lengthBytes) charges += 1; return base.chargeStringBytes(count); },
    chargeRows: (...args) => base.chargeRows(...args),
    chargeObjects: (count) => base.chargeObjects(count),
    chargeOperations: (count) => base.chargeOperations(count),
    usage: () => base.usage(),
    snapshot: () => base.snapshot(),
  };
  return { admission: counting, charges: () => charges };
}

// Correctness: distinct field names must still decode losslessly and stay distinct.
{
  const nameA = 'alphaField', nameB = 'betaField';
  const pre = buildCil({ leadingStrings: [nameA, nameB] });
  const ia = pre.layout.leadingStringIndex[nameA], ib = pre.layout.leadingStringIndex[nameB];
  const rows = new Uint8Array(2 * 6); const v = new DataView(rows.buffer);
  v.setUint16(0, 6, true); v.setUint16(2, ia, true); v.setUint16(4, 5, true);
  v.setUint16(6, 6, true); v.setUint16(8, ib, true); v.setUint16(10, 5, true);
  const imageSize = 0x400 + 0x100 + nameA.length + nameB.length + 0x1400;
  const bytes = buildCil({
    methods: [], types: [{ name: 'T', namespace: 'N', fieldList: 1, methodList: 1 }],
    leadingStrings: [nameA, nameB], extraRows: new Map([[0x04, { count: 2, bytes: rows }]]),
    imageSize, metadataSize: imageSize - 0x300,
  }).bytes;
  const image = parseCil(bytes, { binaryId: 'distinct' });
  assert.equal(image.fields.length, 2);
  assert.equal(image.fields[0].name, nameA);
  assert.equal(image.fields[1].name, nameB);
}

// Interning: 2 000 references to one shared #Strings entry decode it exactly
// once in the context the public pipeline validates (red pre-fix: one decode
// per reference).
{
  const bytes = fieldAliasFixture(2000);
  const { result, sharedDecodes } = countSharedDecodes(
    () => rawParse(bytes, { binaryId: 'intern' }), 4095,
  );
  assert.equal(result.defs.fields.length, 2000);
  assert.equal(result.defs.fields[0].name.length, 4095);
  assert.equal(sharedDecodes, 1,
    `2000 references to one shared #Strings entry must intern it (sharedDecodes=${sharedDecodes})`);
}

// Admission: the same 2 000 aliases must be charged against #String bytes once,
// not once per reference (red pre-fix: 2 000 charges).
{
  const { admission, charges } = countingAdmission(4095);
  rawParse(fieldAliasFixture(2000), { binaryId: 'charge-once', metadataAdmission: admission });
  assert.equal(charges(), 1, 'aliased #Strings offsets must be admitted exactly once');
}

// Availability (the reported failure shape): the default budget must still ADMIT
// a large repeated-offset alias table through the public parse (red pre-fix: the
// per-reference charge walks `maxStringBytes` past its 8 MiB default ceiling and
// the valid image is refused).
{
  const image = parseCil(fieldAliasFixture(5000), { binaryId: 'default' });
  assert.equal(image.fields.length, 5000);
  assert.equal(image.fields[0].name.length, 4095);
  assert.equal(image.fields[4999].name, image.fields[0].name);
}

// Cross-reader interning: TypeDef.Name and every GenericParam.Name share ONE
// heap offset; the entry is decoded exactly once and charged exactly once for
// the whole parse (red pre-fix: definitions decodes it once, the GenericParam
// reader re-decodes it once per row because both readers index the same
// #Strings stream object that the pipeline hands to each).
{
  const bytes = crossReaderAliasFixture(4, 2048);
  const { admission, charges } = countingAdmission(2048);
  const { result, sharedDecodes } = countSharedDecodes(() => {
    const context = rawParse(bytes, { binaryId: 'cross-reader', metadataAdmission: admission });
    const generic = readCilGenericMetadata(context.bytes, context.view, context.layout, context.stringsStream, context.defs);
    return { context, generic };
  }, 2048);
  assert.equal(result.context.defs.types.length, 1);
  assert.equal(result.context.defs.types[0].name.length, 2048);
  assert.equal(result.generic.genericParams.length, 4);
  assert.equal(sharedDecodes, 1,
    `definitions + 4 GenericParam references must share one decode (sharedDecodes=${sharedDecodes})`);
  assert.equal(charges(), 1);
}

// Admission is never laundered: a tiny #String byte budget must still reject a
// large referenced entry deterministically.
{
  assert.throws(
    () => rawParse(fieldAliasFixture(2000), { binaryId: 'budget', metadataBudget: { maxStringBytes: 64 } }),
    /cil-metadata-resource-limit-string-bytes/,
    'string-byte budget must reject a large #Strings entry before materialization',
  );
}

// Existing GenericParam authorities must survive the rewiring: a contiguous,
// unique number series under one owner stays valid, and a duplicate Number
// still fails closed.
{
  const name = 'g'.repeat(64);
  const pre = buildCil({ leadingStrings: [name] });
  const nameOff = pre.layout.leadingStringIndex[name];
  const writeRows = (numbers) => {
    const rows = new Uint8Array(numbers.length * 8); const v = new DataView(rows.buffer);
    numbers.forEach((number, i) => {
      const p = i * 8;
      v.setUint16(p, number, true); v.setUint16(p + 2, 0, true);
      v.setUint16(p + 4, (1 << 1) | 0, true); v.setUint16(p + 6, nameOff, true);
    });
    return rows;
  };
  const bytesFor = (rows) => buildCil({
    types: [{ name: 'T', namespace: 'N', fieldList: 1, methodList: 1 }],
    leadingStrings: [name], extraRows: new Map([[0x2a, { count: rows.length / 8, bytes: rows }]]),
    imageSize: 0x400 + 0x100 + name.length + rows.length + 0x1400, metadataSize: 0x1400,
  }).bytes;
  const genericOf = (bytes) => {
    const context = rawParse(bytes, { binaryId: 'ok' });
    return readCilGenericMetadata(context.bytes, context.view, context.layout, context.stringsStream, context.defs);
  };
  assert.equal(genericOf(bytesFor(writeRows([0, 1, 2]))).genericParams.length, 3);
  assert.throws(
    () => genericOf(bytesFor(writeRows([0, 1, 1]))),
    /cil-generic-param-number-duplicate/,
    'duplicate GenericParam.Number must still fail closed',
  );
}

console.log('[phase11] issue #8699 CIL metadata #Strings alias interning tests passed');
