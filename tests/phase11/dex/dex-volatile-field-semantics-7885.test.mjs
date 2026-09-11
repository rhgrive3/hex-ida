import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DexFrontend } from '../../../js/managed/dex/frontend.js';
import { liftDexMethod } from '../../../js/managed/dex/lifter.js';
import { buildManagedMethodSummary, lowerVMEffectsToSemanticIr } from '../../../js/managed/shared/bridge-v2.js';
import { buildMemorySsa } from '../../../js/semantics/memoryssa/build.js';
import { buildDex } from '../fixtures/medium-dex.mjs';

const ACC_PUBLIC = 0x01;
const ACC_STATIC = 0x08;
const ACC_VOLATILE = 0x40;

async function decodeFixture({ opcode, descriptor = 'I', fieldFlags, fieldStatic = true, fieldClass = 'LTest;' }) {
  const formatByte = fieldStatic ? 0 : 0x10;
  const word = opcode | (formatByte << 8);
  const { bytes } = buildDex({
    classNames: ['LTest;'],
    fields: [{ classType: fieldClass, type: descriptor, name: 'x', flags: fieldFlags, static: fieldStatic }],
    methods: [{
      classType: 'LTest;', name: 'm', returnType: 'V', params: [], flags: ACC_PUBLIC | ACC_STATIC,
      words: [word, 0, 0x000e], registers: 2,
    }],
  });
  const frontend = new DexFrontend();
  const image = await frontend.open(bytes, { binaryId: 'dex-volatile-7885' });
  const methods = [];
  for await (const method of frontend.enumerateMethods(image)) methods.push(method);
  const decoded = await frontend.decodeMethod(methods[0], { image });
  return { frontend, image, decoded };
}

function firstMemory(decoded) {
  return decoded.bundles.find((bundle) => bundle.memoryEffects?.length)?.memoryEffects?.[0];
}

function firstMemoryNode(lowered) {
  return lowered.semanticIr.nodes.find((node) => node.kind === 'load' || node.kind === 'store');
}

test('#7885 local volatile static read/write preserve acquire/release authority through Semantic IR and summary', async () => {
  for (const [opcode, isWrite, ordering] of [[0x60, false, 'acquire'], [0x67, true, 'release']]) {
    const { frontend, image, decoded } = await decodeFixture({
      opcode,
      fieldFlags: ACC_PUBLIC | ACC_STATIC | ACC_VOLATILE,
    });
    assert.equal(image.classes[0].staticFields[0].accessFlags, ACC_PUBLIC | ACC_STATIC | ACC_VOLATILE);
    const effect = firstMemory(decoded);
    assert.equal(effect.volatility, true);
    assert.equal(effect.atomic, true);
    assert.equal(effect.ordering, ordering);
    assert.equal(decoded.aggregateCompleteness, 'exact');

    const validation = await frontend.validateMethod(decoded, { image });
    assert.equal(validation.completeness.semanticEffect, 'complete');
    const lowered = lowerVMEffectsToSemanticIr(decoded);
    const memory = firstMemoryNode(lowered).memory;
    assert.equal(memory.volatility, true);
    assert.equal(memory.atomic, true);
    assert.equal(memory.ordering, ordering);

    const memorySsa = buildMemorySsa(lowered.semanticIr, lowered.cfg);
    assert.ok(memorySsa.accessMetadata.some((access) => access.sourceEntityId === firstMemoryNode(lowered).id
      && access.sequencing?.volatility === true && access.sequencing?.atomic === true
      && access.sequencing?.ordering === ordering));

    const summary = buildManagedMethodSummary(lowered);
    assert.ok(summary.summary.semanticFacts.some((fact) => fact.kind === 'managed-memory-ordering'
      && fact.volatility === true && fact.atomic === true && fact.ordering === ordering
      && fact.isWrite === isWrite));
  }
});

test('#7885 all DEX field opcode variants preserve volatile qualifier', async () => {
  const descriptors = ['I', 'J', 'Ljava/lang/Object;', 'Z', 'B', 'C', 'S'];
  for (const isStatic of [false, true]) {
    for (const isWrite of [false, true]) {
      const base = isStatic ? (isWrite ? 0x67 : 0x60) : (isWrite ? 0x59 : 0x52);
      for (let variant = 0; variant < descriptors.length; variant++) {
        const { decoded } = await decodeFixture({
          opcode: base + variant,
          descriptor: descriptors[variant],
          fieldFlags: ACC_PUBLIC | (isStatic ? ACC_STATIC : 0) | ACC_VOLATILE,
          fieldStatic: isStatic,
        });
        const effect = firstMemory(decoded);
        assert.equal(effect.volatility, true, `opcode 0x${(base + variant).toString(16)}`);
        assert.equal(effect.atomic, true);
        assert.equal(effect.ordering, isWrite ? 'release' : 'acquire');
      }
    }
  }
});

test('#7885 proven local non-volatile field is explicit, while external declaration stays partial/unknown', async () => {
  const local = await decodeFixture({ opcode: 0x60, fieldFlags: ACC_PUBLIC | ACC_STATIC });
  const localEffect = firstMemory(local.decoded);
  assert.equal(localEffect.volatility, false);
  assert.equal(localEffect.atomic, false);
  assert.equal(localEffect.ordering, 'unknown');
  assert.equal(local.decoded.aggregateCompleteness, 'exact');

  const external = await decodeFixture({
    opcode: 0x60,
    fieldClass: 'LExternal;',
    fieldFlags: ACC_PUBLIC | ACC_STATIC,
  });
  const externalEffect = firstMemory(external.decoded);
  assert.equal(externalEffect?.volatility ?? 'unknown', 'unknown');
  assert.notEqual(external.decoded.aggregateCompleteness, 'exact');
  assert.ok(external.decoded.bundles.some((bundle) =>
    bundle.unknownEffects?.some((unknown) => unknown.reason === 'dex-field-declaration-unresolved')));
  const externalLowered = lowerVMEffectsToSemanticIr(external.decoded);
  assert.equal(externalLowered.semanticIr.completeness, 'partial');
  const externalSummary = buildManagedMethodSummary(externalLowered);
  assert.equal(externalSummary.completeness, 'partial');
  assert.equal(externalSummary.summary.status.completeness, 'partial');
});

test('#7885 static/instance declaration mismatch fails closed before publishing a memory effect', async () => {
  const { bytes } = buildDex({
    fields: [{ classType: 'LTest;', type: 'I', name: 'x', flags: ACC_PUBLIC, static: false }],
    methods: [{ classType: 'LTest;', name: 'm', returnType: 'V', params: [], flags: ACC_PUBLIC | ACC_STATIC,
      words: [0x0060, 0, 0x000e] }],
  });
  const frontend = new DexFrontend();
  const image = await frontend.open(bytes);
  const methods = [];
  for await (const method of frontend.enumerateMethods(image)) methods.push(method);
  const decoded = await frontend.decodeMethod(methods[0], { image });
  const fieldBundle = decoded.bundles[0];
  assert.notEqual(fieldBundle.completeness, 'exact');
  assert.deepEqual(fieldBundle.memoryEffects, []);
  assert.ok(fieldBundle.unknownEffects.some((unknown) => unknown.reason === 'dex-field-static-instance-mismatch'));
});

// Keep the synthetic direct-lifter path covered: absence of parser declaration metadata is not
// permission to invent a non-volatile fact.
test('#7885 direct synthetic field effect without declaration authority never fabricates volatility=false', () => {
  const image = {
    moduleId: 'managed-mod:7885', vmSpecEdition: 'dalvik-dex-035',
    rawBytes: new Uint8Array(32), strings: [], types: ['LTest;'],
    fields: [{ classType: 'LExternal;', type: 'I', name: 'x' }],
    methods: [{ name: 'm', classType: 'LTest;', proto: { params: [], returnType: 'V' } }],
    classes: [{ classType: 'LTest;', directMethods: [{ methodIdx: 0, codeOff: 4, accessFlags: 9 }], virtualMethods: [] }],
  };
  const v = new DataView(image.rawBytes.buffer);
  v.setUint16(4, 1, true); v.setUint16(8, 0, true); v.setUint32(16, 3, true);
  v.setUint16(20, 0x0060, true); v.setUint16(22, 0, true); v.setUint16(24, 0x000e, true);
  const decoded = liftDexMethod(0, image);
  assert.notEqual(decoded.aggregateCompleteness, 'exact');
  assert.notEqual(firstMemory(decoded)?.volatility, false);
});

test('#7885 ambiguous or malformed declaration authority cannot mint exact field semantics', () => {
  const base = {
    moduleId: 'managed-mod:7885-adversarial', vmSpecEdition: 'dalvik-dex-035',
    rawBytes: new Uint8Array(32), strings: [], types: ['LTest;'],
    fields: [{ classType: 'LTest;', type: 'I', name: 'x' }],
    methods: [{ name: 'm', classType: 'LTest;', proto: { params: [], returnType: 'V' } }],
  };
  const writeCode = (image) => {
    const v = new DataView(image.rawBytes.buffer);
    v.setUint16(4, 1, true); v.setUint16(8, 0, true); v.setUint32(16, 3, true);
    v.setUint16(20, 0x0060, true); v.setUint16(22, 0, true); v.setUint16(24, 0x000e, true);
    return image;
  };
  const method = { methodIdx: 0, codeOff: 4, accessFlags: ACC_PUBLIC | ACC_STATIC };
  for (const classes of [
    [{ classType: 'LTest;', staticFields: [{ fieldIdx: 0, accessFlags: ACC_PUBLIC | ACC_STATIC }], instanceFields: [], directMethods: [method], virtualMethods: [] },
      { classType: 'LTest;', staticFields: [{ fieldIdx: 0, accessFlags: ACC_PUBLIC | ACC_STATIC }], instanceFields: [], directMethods: [], virtualMethods: [] }],
    [{ classType: 'LTest;', staticFields: [{ fieldIdx: 0, accessFlags: '9' }], instanceFields: [], directMethods: [method], virtualMethods: [] }],
  ]) {
    const decoded = liftDexMethod(0, writeCode({ ...base, rawBytes: new Uint8Array(base.rawBytes), classes }));
    assert.notEqual(decoded.aggregateCompleteness, 'exact');
    assert.deepEqual(decoded.bundles[0].memoryEffects, []);
  }
});
