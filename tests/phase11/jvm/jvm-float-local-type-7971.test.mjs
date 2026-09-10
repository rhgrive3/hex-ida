// Regression for #7971: fload/dload and their store round-trips must retain
// JVM floating-point type authority through VMEffects -> Semantic IR.
import assert from 'node:assert/strict';

import { JvmFrontend } from '../../../js/managed/jvm/frontend.js';
import { lowerVMEffectsToSemanticIr } from '../../../js/managed/shared/bridge-v2.js';

const FLOAT32 = Object.freeze({ kind: 'float', widthBits: 32, format: 'binary32' });
const FLOAT64 = Object.freeze({ kind: 'float', widthBits: 64, format: 'binary64' });

function makeClass({ name = 'f', descriptor, codeBytes, maxStack, maxLocals }) {
  const b = [];
  const u1 = (n) => b.push(n & 0xff);
  const u2 = (n) => b.push((n >>> 8) & 0xff, n & 0xff);
  const u4 = (n) => b.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
  const utf = (text) => {
    const bytes = Buffer.from(text);
    u1(1); u2(bytes.length); b.push(...bytes);
  };

  // CP: A, Class(A), java/lang/Object, Class(Object), method name,
  // method descriptor, Code.
  u4(0xcafebabe); u2(0); u2(61); u2(8);
  utf('A'); u1(7); u2(1);
  utf('java/lang/Object'); u1(7); u2(3);
  utf(name); utf(descriptor); utf('Code');

  u2(0x0021); u2(2); u2(4); u2(0); // public + ACC_SUPER, this, super, interfaces
  u2(0); // fields
  u2(1); // methods
  u2(0x0009); u2(5); u2(6); u2(1); // public static method, one Code attribute
  u2(7); u4(12 + codeBytes.length);
  u2(maxStack); u2(maxLocals); u4(codeBytes.length); b.push(...codeBytes);
  u2(0); u2(0); // exception table, nested Code attributes
  u2(0); // class attributes
  return Uint8Array.from(b);
}

async function project(options) {
  const frontend = new JvmFrontend();
  const image = await frontend.open(makeClass(options), { binaryId: `issue-7971-${options.name}` });
  const methods = [];
  for await (const method of frontend.enumerateMethods(image)) methods.push(method);
  assert.equal(methods.length, 1);
  const decoded = await frontend.decodeMethod(methods[0], { image });
  const validation = await frontend.validateMethod(decoded, { image });
  const lowered = lowerVMEffectsToSemanticIr(decoded);
  assert.equal(validation.status, 'valid');
  assert.equal(validation.completeness.semanticEffect, 'complete');
  assert.equal(decoded.aggregateCompleteness, 'exact');
  assert.equal(lowered.semanticIr.completeness, 'complete');
  return { decoded, lowered };
}

function machineTypeForOutput(lowered, mnemonic) {
  const node = lowered.semanticIr.nodes.find((candidate) => candidate.metadata?.mnemonic === mnemonic);
  assert.ok(node, `missing Semantic IR node for ${mnemonic}`);
  const value = lowered.semanticIr.values.find((candidate) => node.outputs.includes(candidate.id));
  assert.ok(value, `missing Semantic IR output for ${mnemonic}`);
  return value.machineType;
}

function machineTypeForLocalRead(lowered, index, mnemonic) {
  const operation = lowered.semanticIr.nodes.find((candidate) => candidate.metadata?.mnemonic === mnemonic);
  assert.ok(operation, `missing operation for ${mnemonic}`);
  const stateRead = lowered.semanticIr.nodes.find((candidate) =>
    candidate.kind === 'state-read'
    && candidate.variable?.physicalIdentity === `local:${index}`
    && candidate.sourceEffectIds?.some((id) => operation.sourceEffectIds?.includes(id)));
  assert.ok(stateRead, `missing local:${index} state-read for ${mnemonic}`);
  const value = lowered.semanticIr.values.find((candidate) => stateRead.outputs.includes(candidate.id));
  assert.ok(value, `missing local:${index} read value for ${mnemonic}`);
  return value.machineType;
}

async function assertFloatingLoad({ name, descriptor, codeBytes, maxStack, maxLocals, mnemonic, localIndex, type }) {
  const { decoded, lowered } = await project({ name, descriptor, codeBytes, maxStack, maxLocals });
  const load = decoded.bundles.find((bundle) => bundle.mnemonic === mnemonic);
  assert.ok(load, `missing bundle for ${mnemonic}`);
  assert.deepEqual(load.locationReads[0]?.type, type);
  assert.deepEqual(load.producedValues[0]?.type, type);
  assert.deepEqual(machineTypeForLocalRead(lowered, localIndex, mnemonic), type);
  assert.deepEqual(machineTypeForOutput(lowered, mnemonic), type);
}

// Implicit-index forms.
await assertFloatingLoad({
  name: 'implicitF', descriptor: '(F)F', codeBytes: [0x22, 0xae], maxStack: 1, maxLocals: 1,
  mnemonic: 'fload_0', localIndex: 0, type: FLOAT32,
});
await assertFloatingLoad({
  name: 'implicitD', descriptor: '(D)D', codeBytes: [0x26, 0xaf], maxStack: 2, maxLocals: 2,
  mnemonic: 'dload_0', localIndex: 0, type: FLOAT64,
});

// Explicit-index forms.
await assertFloatingLoad({
  name: 'explicitF', descriptor: '(F)F', codeBytes: [0x17, 0x00, 0xae], maxStack: 1, maxLocals: 1,
  mnemonic: 'fload', localIndex: 0, type: FLOAT32,
});
await assertFloatingLoad({
  name: 'explicitD', descriptor: '(D)D', codeBytes: [0x18, 0x00, 0xaf], maxStack: 2, maxLocals: 2,
  mnemonic: 'dload', localIndex: 0, type: FLOAT64,
});

// Same-width integer controls must remain bitvectors, not acquire float type.
for (const control of [
  { name: 'intControl', descriptor: '(I)I', codeBytes: [0x1a, 0xac], maxStack: 1, maxLocals: 1, mnemonic: 'iload_0', widthBits: 32 },
  { name: 'longControl', descriptor: '(J)J', codeBytes: [0x1e, 0xad], maxStack: 2, maxLocals: 2, mnemonic: 'lload_0', widthBits: 64 },
]) {
  const { decoded, lowered } = await project(control);
  const load = decoded.bundles.find((bundle) => bundle.mnemonic === control.mnemonic);
  assert.ok(load);
  assert.equal(load.locationReads[0]?.type, undefined);
  assert.equal(load.producedValues[0]?.type, undefined);
  assert.deepEqual(machineTypeForOutput(lowered, control.mnemonic), {
    kind: 'bitvector', widthBits: control.widthBits,
  });
}

// Store/load round-trips retain float authority on the local write, the value
// consumed by the store, and the subsequent local read/output.
for (const roundTrip of [
  {
    name: 'roundTripF', descriptor: '(F)F',
    codeBytes: [0x22, 0x44, 0x23, 0xae], // fload_0; fstore_1; fload_1; freturn
    maxStack: 1, maxLocals: 2, storeMnemonic: 'fstore_1', loadMnemonic: 'fload_1', localIndex: 1, type: FLOAT32,
  },
  {
    name: 'roundTripD', descriptor: '(D)D',
    codeBytes: [0x26, 0x49, 0x28, 0xaf], // dload_0; dstore_2; dload_2; dreturn
    maxStack: 2, maxLocals: 4, storeMnemonic: 'dstore_2', loadMnemonic: 'dload_2', localIndex: 2, type: FLOAT64,
  },
]) {
  const { decoded, lowered } = await project(roundTrip);
  const store = decoded.bundles.find((bundle) => bundle.mnemonic === roundTrip.storeMnemonic);
  const load = decoded.bundles.find((bundle) => bundle.mnemonic === roundTrip.loadMnemonic);
  assert.ok(store && load);
  assert.deepEqual(store.locationWrites[0]?.type, roundTrip.type);
  assert.deepEqual(store.consumedValues[0]?.type, roundTrip.type);
  assert.deepEqual(load.locationReads[0]?.type, roundTrip.type);
  assert.deepEqual(load.producedValues[0]?.type, roundTrip.type);
  assert.deepEqual(machineTypeForLocalRead(lowered, roundTrip.localIndex, roundTrip.loadMnemonic), roundTrip.type);
  assert.deepEqual(machineTypeForOutput(lowered, roundTrip.loadMnemonic), roundTrip.type);
}

// Adversarial second pass: the operand-index store forms share the same type
// authority, while equal-width integer stores stay untyped at the VMEffect
// boundary. These cases protect both switch families from drifting apart.
for (const explicitStore of [
  {
    name: 'explicitRoundTripF', descriptor: '(F)F',
    codeBytes: [0x17, 0x00, 0x38, 0x01, 0x17, 0x01, 0xae],
    maxStack: 1, maxLocals: 2, storeMnemonic: 'fstore', localIndex: 1, type: FLOAT32,
  },
  {
    name: 'explicitRoundTripD', descriptor: '(D)D',
    codeBytes: [0x18, 0x00, 0x39, 0x02, 0x18, 0x02, 0xaf],
    maxStack: 2, maxLocals: 4, storeMnemonic: 'dstore', localIndex: 2, type: FLOAT64,
  },
]) {
  const { decoded } = await project(explicitStore);
  const store = decoded.bundles.find((bundle) =>
    bundle.mnemonic === explicitStore.storeMnemonic
    && bundle.locationWrites[0]?.index === explicitStore.localIndex);
  assert.ok(store);
  assert.deepEqual(store.locationWrites[0]?.type, explicitStore.type);
  assert.deepEqual(store.consumedValues[0]?.type, explicitStore.type);
}

for (const integerStore of [
  {
    name: 'intStoreControl', descriptor: '(I)I', codeBytes: [0x1a, 0x3c, 0x1b, 0xac],
    maxStack: 1, maxLocals: 2, storeMnemonic: 'istore_1',
  },
  {
    name: 'longStoreControl', descriptor: '(J)J', codeBytes: [0x1e, 0x41, 0x20, 0xad],
    maxStack: 2, maxLocals: 4, storeMnemonic: 'lstore_2',
  },
]) {
  const { decoded } = await project(integerStore);
  const store = decoded.bundles.find((bundle) => bundle.mnemonic === integerStore.storeMnemonic);
  assert.ok(store);
  assert.equal(store.locationWrites[0]?.type, undefined);
  assert.equal(store.consumedValues[0]?.type, undefined);
}
