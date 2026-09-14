import assert from 'node:assert/strict';
import { buildCil } from '../fixtures/medium-cil.mjs';
import { parseCil } from '../../../js/managed/cil/parser.js';
import { parseCil as parseCilBase } from '../../../js/managed/cil/parser-base.js';
import { overlayCilMetadata } from '../../../js/managed/cil/parser-overlay.js';

console.log('[phase11] running issue #8778 CIL ECMA-335 duplicate-definition identity tests...');

// Public parseCil collapses internal codes to cil-unsupported-binary; use the raw
// overlay path to observe the specific fail-closed identity errors.
const rawParse = (bytes, options = {}) => overlayCilMetadata(bytes, parseCilBase(bytes, options), options);

const typeRow = (name, namespace = 'N') => ({ name, namespace, flags: 1, fieldList: 1, methodList: 1 });

// Duplicate top-level TypeDef (same namespace + name) is an ECMA-335 [ERROR]
// condition and must fail closed instead of publishing two token identities.
{
  const b = buildCil({
    methods: [], types: [typeRow('Dup'), typeRow('Dup')],
    imageSize: 0x6000, metadataSize: 0x5000,
  }).bytes;
  assert.throws(() => rawParse(b, { binaryId: 'dup' }), /cil-typedef-identity-duplicate/,
    'duplicate top-level TypeDef identity must fail closed');
}

// Distinct top-level TypeDef identities remain valid.
{
  const b = buildCil({
    methods: [], types: [typeRow('Alpha'), typeRow('Beta')],
    imageSize: 0x6000, metadataSize: 0x5000,
  }).bytes;
  const image = parseCil(b, { binaryId: 'distinct' });
  assert.equal(image.types.length, 2);
}

// Duplicate Field (same owner + Name + Signature) fails closed.
{
  const b = buildCil({
    methods: [], types: [{ name: 'T', namespace: 'N', fieldList: 1, methodList: 1 }],
    fields: [{ classType: 'T', type: 'I', name: 'dup', flags: 6 }, { classType: 'T', type: 'I', name: 'dup', flags: 6 }],
    imageSize: 0x6000, metadataSize: 0x5000,
  }).bytes;
  assert.throws(() => rawParse(b, { binaryId: 'dupfield' }), /cil-field-identity-duplicate/,
    'duplicate non-CompilerControlled Field identity must fail closed');
}

// Distinct Field names under one owner remain valid.
{
  const b = buildCil({
    methods: [], types: [{ name: 'T', namespace: 'N', fieldList: 1, methodList: 1 }],
    fields: [{ classType: 'T', type: 'I', name: 'a', flags: 6 }, { classType: 'T', type: 'I', name: 'b', flags: 6 }],
    imageSize: 0x6000, metadataSize: 0x5000,
  }).bytes;
  const image = parseCil(b, { binaryId: 'okfield' });
  assert.equal(image.fields.length, 2);
}

// CompilerControlled fields are excluded from the duplicate rule (ECMA-335 II.22.24).
{
  const b = buildCil({
    methods: [], types: [{ name: 'T', namespace: 'N', fieldList: 1, methodList: 1 }],
    fields: [{ classType: 'T', type: 'I', name: 'cc', flags: 0 }, { classType: 'T', type: 'I', name: 'cc', flags: 0 }],
    imageSize: 0x6000, metadataSize: 0x5000,
  }).bytes;
  assert.doesNotThrow(() => parseCil(b, { binaryId: 'ccfield' }),
    'duplicate CompilerControlled Field identities must remain accepted');
}

// MethodAccess CompilerControlled is the access-mask value 0 only.
// Public|HideBySig (0x0086) and Private (0x0001) are ordinary methods.
for (const flags of [0x0086, 0x0001]) {
  const b = buildCil({
    methods: [
      { name: 'DupMethod', flags, signature: [0x00, 0x00, 0x01], body: [0x2a] },
      { name: 'DupMethod', flags, signature: [0x00, 0x00, 0x01], body: [0x2a] },
    ],
    types: [{ name: 'T', namespace: 'N', fieldList: 1, methodList: 1 }],
    imageSize: 0x6000, metadataSize: 0x5000,
  }).bytes;
  assert.throws(() => rawParse(b, { binaryId: `dupmethod-${flags}` }), /cil-methoddef-identity-duplicate/,
    `duplicate MethodDef identity must fail for access flags 0x${flags.toString(16)}`);
}

// Actual CompilerControlled methods (access mask 0) are the exemption.
{
  const b = buildCil({
    methods: [
      { name: 'CC', flags: 0x0000, signature: [0x00, 0x00, 0x01], body: [0x2a] },
      { name: 'CC', flags: 0x0000, signature: [0x00, 0x00, 0x01], body: [0x2a] },
    ],
    types: [{ name: 'T', namespace: 'N', fieldList: 1, methodList: 1 }],
    imageSize: 0x6000, metadataSize: 0x5000,
  }).bytes;
  assert.doesNotThrow(() => parseCil(b, { binaryId: 'ccmethod' }));
}

// Two distinct #Blob offsets with identical MethodDef signature bytes
// are still the same semantic signature.
{
  const b = buildCil({
    methods: [
      { name: 'SameSig', flags: 0x0006, signature: [0x00, 0x00, 0x01], body: [0x2a] },
      { name: 'SameSig', flags: 0x0006, signature: [0x00, 0x00, 0x01], body: [0x2a] },
    ],
    types: [{ name: 'T', namespace: 'N', fieldList: 1, methodList: 1 }],
    imageSize: 0x6000, metadataSize: 0x5000,
  }).bytes;
  assert.throws(() => rawParse(b, { binaryId: 'dup-method-content' }), /cil-methoddef-identity-duplicate/);
}

// The same content rule applies to fields.
{
  const b = buildCil({
    methods: [],
    types: [{ name: 'T', namespace: 'N', fieldList: 1, methodList: 1 }],
    fields: [
      { name: 'dupBlobField', flags: 6, signature: [0x06, 0x08] },
      { name: 'dupBlobField', flags: 6, signature: [0x06, 0x08] },
    ],
    imageSize: 0x6000, metadataSize: 0x5000,
  }).bytes;
  assert.throws(() => rawParse(b, { binaryId: 'dup-field-content' }), /cil-field-identity-duplicate/);
}

// Property signatures use the same exact-content rule. Each one-byte
// payload occupies a different #Blob heap entry (offsets 8 and 10).
{
  const properties = new Uint8Array(12);
  const pv = new DataView(properties.buffer);
  for (const [i, blobIndex] of [8, 10].entries()) {
    pv.setUint16(i * 6, 0, true);
    pv.setUint16(i * 6 + 2, 1, true);
    pv.setUint16(i * 6 + 4, blobIndex, true);
  }
  const propertyMap = new Uint8Array(4);
  const pmv = new DataView(propertyMap.buffer);
  pmv.setUint16(0, 1, true);
  pmv.setUint16(2, 1, true);
  const b = buildCil({
    methods: [], fields: [],
    types: [{ name: 'T', namespace: 'N', fieldList: 1, methodList: 1 }],
    leadingStrings: ['DupProperty'],
    blobs: [[0x08], [0x08]],
    extraRows: new Map([
      [0x15, { count: 1, bytes: propertyMap }],
      [0x17, { count: 2, bytes: properties }],
    ]),
    imageSize: 0x6000, metadataSize: 0x5000,
  }).bytes;
  assert.throws(() => rawParse(b, { binaryId: 'dup-property-content' }), /cil-property-identity-duplicate/);
}

console.log('[phase11] issue #8778 CIL ECMA-335 duplicate-definition identity tests passed');
