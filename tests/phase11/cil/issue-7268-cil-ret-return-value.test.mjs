import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CilFrontend } from '../../../js/managed/cil/frontend.js';
import { liftCilMethod } from '../../../js/managed/cil/lifter.js';
import { parseCil } from '../../../js/managed/cil/parser.js';
import { validateCilEffectFunction } from '../../../js/managed/cil/validation.js';
import { lowerVMEffectsToSemanticIr } from '../../../js/managed/shared/bridge-lowering-v2.js';

function addBlob(buf, offset, cursor, bytes) {
  if (bytes == null) return 0;
  const index = cursor.value;
  assert.ok(bytes.length < 0x80);
  buf[offset + index] = bytes.length;
  buf.set(bytes, offset + index + 1);
  cursor.value += bytes.length + 1;
  return index;
}

function addString(buf, offset, cursor, value) {
  const index = cursor.value;
  const bytes = new TextEncoder().encode(value);
  buf.set(bytes, offset + index);
  buf[offset + index + bytes.length] = 0;
  cursor.value += bytes.length + 1;
  return index;
}

function buildReturnPe({ returnSignature, bytecode }) {
  const buf = new Uint8Array(0xd00);
  const view = new DataView(buf.buffer);

  // One-section PE32 image. MethodDef RID 1 is abstract (RVA=0), while the
  // concrete body belongs to RID 2. This makes bodyIndex-based token guessing
  // observably wrong and forces the lifter to bind by MethodDef body identity.
  buf[0] = 0x4d; buf[1] = 0x5a;
  view.setUint32(0x3c, 0x80, true);
  buf.set([0x50, 0x45, 0, 0], 0x80);
  view.setUint16(0x86, 1, true);
  view.setUint16(0x94, 0xe0, true);

  const optional = 0x98;
  view.setUint16(optional, 0x10b, true);
  view.setUint32(optional + 92, 16, true);
  const cliDirectory = optional + 96 + 14 * 8;
  view.setUint32(cliDirectory, 0x2000, true);
  view.setUint32(cliDirectory + 4, 72, true);

  const section = optional + 0xe0;
  view.setUint32(section + 8, 0xa00, true);
  view.setUint32(section + 12, 0x2000, true);
  view.setUint32(section + 16, 0xa00, true);
  view.setUint32(section + 20, 0x200, true);

  const cli = 0x200;
  view.setUint32(cli, 72, true);
  view.setUint16(cli + 4, 2, true);
  view.setUint16(cli + 6, 5, true);
  view.setUint32(cli + 8, 0x2100, true);
  view.setUint32(cli + 12, 0x400, true);
  view.setUint32(cli + 16, 1, true);

  const metadata = 0x300;
  view.setUint32(metadata, 0x424a5342, true);
  view.setUint16(metadata + 4, 1, true);
  view.setUint16(metadata + 6, 1, true);
  const version = new TextEncoder().encode('v4.0.30319\0\0');
  view.setUint32(metadata + 12, version.length, true);
  buf.set(version, metadata + 16);

  const flags = (metadata + 16 + version.length + 3) & ~3;
  view.setUint16(flags + 2, 3, true);
  let streamPos = flags + 4;
  const addStream = (relativeOffset, size, name) => {
    view.setUint32(streamPos, relativeOffset, true);
    view.setUint32(streamPos + 4, size, true);
    streamPos += 8;
    const nameBytes = new TextEncoder().encode(`${name}\0`);
    buf.set(nameBytes, streamPos);
    streamPos = (streamPos + nameBytes.length + 3) & ~3;
  };
  addStream(0x100, 0x100, '#~');
  addStream(0x200, 0x100, '#Blob');
  addStream(0x300, 0x80, '#Strings');

  const blobOffset = metadata + 0x200;
  buf[blobOffset] = 0;
  const blobCursor = { value:1 };
  const abstractVoidSignature = addBlob(buf, blobOffset, blobCursor, Uint8Array.from([0x00, 0x00, 0x01]));
  const concreteSignature = addBlob(buf, blobOffset, blobCursor, returnSignature);

  const stringsOffset = metadata + 0x300;
  buf[stringsOffset] = 0;
  const stringCursor = { value:1 };
  const abstractName = addString(buf, stringsOffset, stringCursor, 'AbstractBeforeBody');
  const concreteName = addString(buf, stringsOffset, stringCursor, 'Target');

  const tables = metadata + 0x100;
  buf[tables + 4] = 2;
  buf[tables + 7] = 1;
  view.setUint32(tables + 8, 1 << 6, true);
  let tablePos = tables + 24;
  view.setUint32(tablePos, 2, true);
  tablePos += 4;

  const addMethodDef = (rva, nameIndex, signatureIndex) => {
    view.setUint32(tablePos, rva, true);
    view.setUint16(tablePos + 8, nameIndex, true);
    view.setUint16(tablePos + 10, signatureIndex, true);
    view.setUint16(tablePos + 12, 0, true);
    tablePos += 14;
  };
  addMethodDef(0, abstractName, abstractVoidSignature);
  addMethodDef(0x2600, concreteName, concreteSignature);

  assert.ok(bytecode.length < 64, 'focused fixture requires a tiny method body');
  const methodOffset = 0x800;
  buf[methodOffset] = (bytecode.length << 2) | 0x02;
  buf.set(bytecode, methodOffset + 1);
  return buf;
}

function imageFor(signatureBytes, bytecode) {
  return parseCil(buildReturnPe({
    returnSignature:signatureBytes == null ? null : Uint8Array.from(signatureBytes),
    bytecode:Uint8Array.from(bytecode),
  }));
}

function retBundle(lifted) {
  const ret = lifted.bundles.find((bundle) => bundle.mnemonic === 'ret');
  assert.ok(ret, 'ret bundle exists');
  return ret;
}

function returnNode(lowered) {
  const node = lowered.semanticIr.nodes.find((candidate) => candidate.kind === 'return');
  assert.ok(node, 'Semantic IR return node exists');
  return node;
}

test('#7268 enclosing MethodDef identity, not bodyIndex, owns non-void ret semantics', async () => {
  const image = imageFor([0x00, 0x00, 0x08], [0x17, 0x2a]); // static int32(); ldc.i4.1; ret
  assert.equal(image.methodBodies.length, 1);

  const frontend = new CilFrontend();
  const methods = [];
  for await (const method of frontend.enumerateMethods(image)) methods.push(method);
  assert.equal(methods.length, 1);
  assert.equal(methods[0].token, '0x06000002', 'concrete body belongs to MethodDef RID 2');

  const lifted = liftCilMethod(0, image);
  assert.equal(lifted.methodId, methods[0].id);
  assert.equal(lifted.entryState.returnStackSlots, 1);
  const ret = retBundle(lifted);
  assert.equal(ret.completeness, 'exact');
  assert.equal(ret.consumedValues.length, 1);
  assert.equal(ret.consumedValues[0].stackType, 'int32');
  assert.equal(ret.consumedValues[0].bits, 32);

  const valid = validateCilEffectFunction(lifted);
  assert.equal(valid.status, 'valid', JSON.stringify(valid.errors));
  // Caller-supplied shape cannot override parsed MethodDef authority.
  assert.equal(validateCilEffectFunction(lifted, { returnStackSlots:0 }).status, 'valid');

  const lowered = lowerVMEffectsToSemanticIr(lifted);
  assert.equal(lowered.semanticIr.completeness, 'complete');
  assert.equal(returnNode(lowered).inputs.length, 1);
  assert.equal(lowered.semanticIr.nodes.filter((node) => node.kind === 'state-write'
    && String(node.variable?.key || '').includes('stack')).length, 0);
});

test('#7268 unresolved enclosing signature fails closed instead of inferring ret from stack height', () => {
  const lifted = liftCilMethod(0, imageFor(null, [0x17, 0x2a]));
  const ret = retBundle(lifted);
  assert.equal(ret.completeness, 'partial');
  assert.equal(ret.consumedValues.length, 0);
  assert.ok(ret.unknownEffects.some((effect) => effect.reason === 'cil-return-signature-unresolved'));
  assert.equal(lifted.aggregateCompleteness, 'partial');

  const report = validateCilEffectFunction(lifted);
  assert.equal(report.status, 'partial');
  assert.ok(report.warnings.some((warning) => warning.code === 'cil-return-stack-shape-unavailable'));
  assert.equal(lowerVMEffectsToSemanticIr(lifted).semanticIr.completeness, 'partial');
});

test('#7268 declared void with stray stack value is invalid', () => {
  const lifted = liftCilMethod(0, imageFor([0x00, 0x00, 0x01], [0x17, 0x2a])); // static void()
  assert.equal(lifted.entryState.returnStackSlots, 0);
  assert.equal(retBundle(lifted).consumedValues.length, 0);
  const report = validateCilEffectFunction(lifted);
  assert.equal(report.status, 'invalid');
  assert.ok(report.errors.some((error) => error.code === 'cil-return-stack-shape-invalid'));
});

test('#7268 declared non-void with a missing return value fails stack validation', () => {
  const lifted = liftCilMethod(0, imageFor([0x00, 0x00, 0x08], [0x2a])); // static int32(); ret
  assert.equal(retBundle(lifted).consumedValues.length, 1);
  const report = validateCilEffectFunction(lifted);
  assert.equal(report.status, 'invalid');
  assert.ok(report.errors.some((error) => error.code === 'cil-stack-underflow'));
});

test('#7268 int64 and reference returns preserve signature stack type and bridge dataflow', () => {
  const cases = [
    {
      signature:[0x00, 0x00, 0x0a], // static int64()
      bytecode:[0x21, 1, 0, 0, 0, 0, 0, 0, 0, 0x2a],
      stackType:'int64',
      bits:64,
    },
    {
      signature:[0x00, 0x00, 0x1c], // static object()
      bytecode:[0x14, 0x2a], // ldnull; ret
      stackType:'object-ref',
      bits:null,
    },
  ];

  for (const sample of cases) {
    const lifted = liftCilMethod(0, imageFor(sample.signature, sample.bytecode));
    const ret = retBundle(lifted);
    assert.equal(ret.consumedValues.length, 1);
    assert.equal(ret.consumedValues[0].stackType, sample.stackType);
    if (sample.bits == null) assert.equal(ret.consumedValues[0].bits, undefined);
    else assert.equal(ret.consumedValues[0].bits, sample.bits);
    assert.equal(validateCilEffectFunction(lifted).status, 'valid');

    const lowered = lowerVMEffectsToSemanticIr(lifted);
    const node = returnNode(lowered);
    assert.equal(node.inputs.length, 1);
    const value = lowered.semanticIr.values.find((candidate) => candidate.id === node.inputs[0]);
    assert.ok(value, 'return input resolves to a Semantic IR value');
    assert.equal(value.machineType.widthBits, 64);
    assert.equal(lowered.semanticIr.completeness, 'complete');
  }
});
