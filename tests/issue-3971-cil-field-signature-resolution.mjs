// Regression for #3971: `ldfld/stfld/ldsfld/stsfld` must resolve the metadata
// Field/MemberRef token through a checked field-signature resolver and derive
// the evaluation-stack value width/kind from the field signature. int64/float64
// fields lift as 64-bit values, reference fields never borrow a fabricated
// 32-bit integer identity, unresolvable tokens fail closed (never an exact
// field effect), and a valid int32 field keeps its existing 32-bit behavior.
import assert from 'node:assert/strict';

import { parseCil } from '../js/managed/cil/parser.js';
import { liftCilMethod } from '../js/managed/cil/lifter.js';
import { buildCil } from './phase11/fixtures/medium-cil.mjs';

console.log('[phase11] running cil field signature resolution regression #3971...');

const TOKEN_BYTES = [0x01, 0x00, 0x00, 0x04]; // FieldDef rid 1
const RET = 0x2a;

function imageFor(field, body) {
  return buildCil({
    methods: [{ name: 'FieldAccess', body, flags: 0x0006, signature: [0x20, 0x00, 0x01] }],
    fields: [field],
  }).bytes;
}

function bundle(image, mnemonic) {
  const effects = liftCilMethod(0, parseCil(image));
  const found = effects.bundles.find((b) => b.mnemonic === mnemonic);
  assert.ok(found, `${mnemonic} bundle present`);
  return found;
}

// int64 static field: 64-bit evaluation-stack value, exact.
{
  const b = bundle(imageFor({ name: 'Counter', flags: 0x16, signature: [0x06, 0x0a] },
    [0x7e, ...TOKEN_BYTES, RET]), 'ldsfld');
  assert.equal(b.completeness, 'exact');
  assert.equal(b.producedValues[0].bits, 64);
  assert.equal(b.producedValues[0].stackType, 'int64');
  assert.equal(b.memoryEffects[0].fieldName, 'Counter');
  assert.equal(b.memoryEffects[0].fieldType.bits, 64);
  assert.equal(b.memoryEffects[0].fieldProvenance.table, 'FieldDef');
  assert.equal(b.memoryEffects[0].fieldProvenance.rid, 1);
  assert.ok(Number.isSafeInteger(b.memoryEffects[0].fieldProvenance.signatureBlobIndex));
}

// float64 static field: 64-bit value, not a laundered 32-bit load.
{
  const b = bundle(imageFor({ name: 'Total', flags: 0x16, signature: [0x06, 0x0d] },
    [0x7e, ...TOKEN_BYTES, RET]), 'ldsfld');
  assert.equal(b.completeness, 'exact');
  assert.equal(b.producedValues[0].bits, 64);
  assert.equal(b.producedValues[0].stackType, 'float');
}

// reference field: object-ref semantics, never an exact integer32 value.
{
  const b = bundle(imageFor({ name: 'Head', flags: 0x06, signature: [0x06, 0x12, 0x04] },
    [0x02, 0x7b, ...TOKEN_BYTES, RET]), 'ldfld');
  assert.equal(b.completeness, 'exact');
  assert.equal(b.producedValues[0].stackType, 'object-ref');
  assert.ok(b.producedValues[0].bits == null, 'reference width is not minted as 32-bit');
}

// valid int32 instance field keeps the existing 32-bit behavior.
{
  const b = bundle(imageFor({ name: 'Count', flags: 0x06, signature: [0x06, 0x08] },
    [0x02, 0x7b, ...TOKEN_BYTES, RET]), 'ldfld');
  assert.equal(b.completeness, 'exact');
  assert.equal(b.producedValues[0].bits, 32);
  assert.equal(b.memoryEffects[0].fieldName, 'Count');
}

// stores carry the resolved field type so the value can be reconciled.
{
  const b = bundle(imageFor({ name: 'Counter', flags: 0x16, signature: [0x06, 0x0a] },
    [0x17, 0x80, ...TOKEN_BYTES]), 'stsfld');
  assert.equal(b.completeness, 'exact');
  assert.equal(b.memoryEffects[0].fieldType.bits, 64);
  assert.equal(b.memoryEffects[0].isWrite, true);
}

// token without a FieldDef row never promotes to an exact field effect.
{
  const b = bundle(imageFor({ name: 'Counter', flags: 0x16, signature: [0x06, 0x08] },
    [0x7e, 0x99, 0x00, 0x00, 0x04, RET]), 'ldsfld');
  assert.equal(b.completeness, 'partial');
  assert.ok(b.unknownEffects.some((u) => u.category === 'types'));
  assert.equal(b.memoryEffects[0].fieldResolved, false);
  assert.ok(!('bits' in b.producedValues[0]) || b.producedValues[0].bits !== 32,
    'unresolved field must not publish a fabricated 32-bit exact value');
}

// a non-field token table is rejected the same way.
{
  const b = bundle(imageFor({ name: 'Counter', flags: 0x16, signature: [0x06, 0x08] },
    [0x7e, 0x01, 0x00, 0x00, 0x06, RET]), 'ldsfld');
  assert.equal(b.completeness, 'partial');
  assert.equal(b.memoryEffects[0].fieldResolved, false);
}

// a Field signature blob that cannot be decoded stays inexact.
{
  const b = bundle(imageFor({ name: 'Broken', flags: 0x16, signature: [0x06, 0x55] },
    [0x7e, ...TOKEN_BYTES, RET]), 'ldsfld');
  assert.equal(b.completeness, 'partial');
  assert.ok(b.unknownEffects.some((u) => u.category === 'types'));
  assert.equal(b.memoryEffects[0].fieldResolved, false);
}

console.log('[phase11] cil field signature resolution regression #3971 passed');
