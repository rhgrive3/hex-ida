import assert from 'node:assert/strict';
import { buildCil } from '../fixtures/medium-cil.mjs';
import { parseCil } from '../../../js/managed/cil/parser.js';
import { parseCil as parseCilBase } from '../../../js/managed/cil/parser-base.js';
import { overlayCilMetadata } from '../../../js/managed/cil/parser-overlay.js';

console.log('[phase11] running issue #8699 CIL metadata #Strings alias / GenericParam budget tests...');

// The public parseCil probe facade collapses every internal fail-closed code to
// cil-unsupported-binary; the raw overlay path surfaces the specific budgets.
const rawParse = (bytes, options = {}) => overlayCilMetadata(bytes, parseCilBase(bytes, options), options);

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

function genericParamAliasFixture(n, nameLen = 2048) {
  const name = 'g'.repeat(nameLen);
  const pre = buildCil({ leadingStrings: [name] });
  const nameOff = pre.layout.leadingStringIndex[name];
  const rows = new Uint8Array(n * 8);
  const v = new DataView(rows.buffer);
  for (let i = 0; i < n; i++) {
    const p = i * 8;
    v.setUint16(p, i, true);                 // Number = i (contiguous 0..n-1, unique)
    v.setUint16(p + 2, 0, true);             // Flags
    v.setUint16(p + 4, (1 << 1) | 0, true);  // Owner = TypeDef rid 1 (tag 0)
    v.setUint16(p + 6, nameOff, true);       // Name -> one shared #Strings entry
  }
  const imageSize = 0x400 + 0x100 + name.length + n * 8 + 0x1400;
  return buildCil({
    types: [{ name: 'T', namespace: 'N', fieldList: 1, methodList: 1 }],
    leadingStrings: [name],
    extraRows: new Map([[0x2a, { count: n, bytes: rows }]]),
    imageSize, metadataSize: imageSize - 0x300,
  }).bytes;
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

// Interning (red: pre-fix re-decodes the shared entry once per reference). Each
// reference to the long shared name must be decoded at most once per parse pass.
{
  const originalDecode = TextDecoder.prototype.decode;
  let sharedDecodes = 0;
  TextDecoder.prototype.decode = function (...args) {
    const view = args[0];
    const len = view && typeof view.byteLength === 'number' ? view.byteLength : -1;
    if (len === 4095) sharedDecodes += 1;
    return originalDecode.apply(this, args);
  };
  let image;
  try { image = parseCil(fieldAliasFixture(2000), { binaryId: 'intern' }); }
  finally { TextDecoder.prototype.decode = originalDecode; }
  assert.equal(image.fields.length, 2000);
  assert.equal(image.fields[0].name.length, 4095);
  assert.ok(sharedDecodes <= 16,
    `2000 references to one shared #Strings entry must intern it (sharedDecodes=${sharedDecodes})`);
}

// Availability: the default (generous) budget must still ADMIT a large repeated-
// offset alias table and intern it correctly (a tiny budget above rejected it).
{
  const image = parseCil(fieldAliasFixture(5000), { binaryId: 'default' });
  assert.equal(image.fields.length, 5000);
  assert.equal(image.fields[0].name.length, 4095);
  assert.equal(image.fields[4999].name, image.fields[0].name);
}

// Admission: an injected tiny string budget must fail closed with a deterministic
// code before the oversized shared string is materialized (red: no budget, parses).
assert.throws(
  () => rawParse(fieldAliasFixture(2000), { binaryId: 'budget', resourceBudget: { maxStringBytes: 64 } }),
  /cil-metadata-resource-limit-strings/,
  'string-byte budget must reject a large #Strings entry before materialization',
);

// GenericParam: shared names interned and a contiguous, unique number series under
// one owner stays valid after the O(n^2) includes() -> Set rewrite.
{
  const image = parseCil(genericParamAliasFixture(40, 2048), { binaryId: 'gparam' });
  assert.equal(image.genericParams.length, 40);
  assert.equal(image.genericParams[0].name.length, 2048);
}

// GenericParam duplicate-number detection must remain exact with the Set.
{
  const name = 'g'.repeat(64);
  const pre = buildCil({ leadingStrings: [name] });
  const nameOff = pre.layout.leadingStringIndex[name];
  const rows = new Uint8Array(3 * 8); const v = new DataView(rows.buffer);
  const write = (i, number) => { const p = i * 8;
    v.setUint16(p, number, true); v.setUint16(p + 2, 0, true);
    v.setUint16(p + 4, (1 << 1) | 0, true); v.setUint16(p + 6, nameOff, true); };
  write(0, 0); write(1, 1); write(2, 1); // duplicate Number 1
  const imageSize = 0x400 + 0x100 + name.length + rows.length + 0x1400;
  const bytes = buildCil({
    types: [{ name: 'T', namespace: 'N', fieldList: 1, methodList: 1 }],
    leadingStrings: [name], extraRows: new Map([[0x2a, { count: 3, bytes: rows }]]),
    imageSize, metadataSize: imageSize - 0x300,
  }).bytes;
  assert.throws(() => rawParse(bytes, { binaryId: 'dup' }), /cil-generic-param-number-duplicate/,
    'duplicate GenericParam.Number must still fail closed');
}

console.log('[phase11] issue #8699 CIL metadata #Strings alias / GenericParam budget tests passed');
