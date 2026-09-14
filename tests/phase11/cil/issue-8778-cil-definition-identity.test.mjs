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

console.log('[phase11] issue #8778 CIL ECMA-335 duplicate-definition identity tests passed');
