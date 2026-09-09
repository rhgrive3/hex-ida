// Regression for #7854: ACC_SYNCHRONIZED is execution authority. Until the
// shared VMEffect schema can losslessly encode implicit method monitors, JVM
// lifting must fail closed rather than publish plain-method-equivalent complete
// semantics.
import assert from 'node:assert/strict';

import { JvmFrontend } from '../../../js/managed/jvm/frontend.js';
import { lowerVMEffectsToSemanticIr } from '../../../js/managed/shared/bridge-v2.js';

const ACC_PUBLIC = 0x0001;
const ACC_STATIC = 0x0008;
const ACC_SYNCHRONIZED = 0x0020;
const ACC_NATIVE = 0x0100;

function makeClass(methodFlags, { codeBytes = [0xb1], maxStack = 0, hasCode = true } = {}) {
  const b = [];
  const u1 = (n) => b.push(n & 0xff);
  const u2 = (n) => b.push((n >>> 8) & 0xff, n & 0xff);
  const u4 = (n) => b.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
  const utf = (text) => {
    const bytes = Buffer.from(text);
    u1(1); u2(bytes.length); b.push(...bytes);
  };

  // CP: A, Class(A), java/lang/Object, Class(Object), f, ()V, Code.
  u4(0xcafebabe); u2(0); u2(61); u2(8);
  utf('A'); u1(7); u2(1);
  utf('java/lang/Object'); u1(7); u2(3);
  utf('f'); utf('()V'); utf('Code');

  u2(ACC_PUBLIC | 0x0020); u2(2); u2(4); u2(0); // class header, ACC_SUPER
  u2(0); // fields
  u2(1); // methods
  u2(methodFlags); u2(5); u2(6); u2(hasCode ? 1 : 0);
  if (hasCode) {
    u2(7); u4(12 + codeBytes.length);
    u2(maxStack); u2(1); u4(codeBytes.length); b.push(...codeBytes);
    u2(0); u2(0); // exception table, nested attributes
  }
  u2(0); // class attributes
  return Uint8Array.from(b);
}

async function project(methodFlags, fixtureOptions = {}) {
  const frontend = new JvmFrontend();
  const image = await frontend.open(makeClass(methodFlags, fixtureOptions), { binaryId: `issue-7854-${methodFlags}` });
  const methods = [];
  for await (const method of frontend.enumerateMethods(image)) methods.push(method);
  const decoded = await frontend.decodeMethod(methods[0], { image });
  const validation = await frontend.validateMethod(decoded, { image });
  const lowered = lowerVMEffectsToSemanticIr(decoded);
  return { decoded, validation, lowered };
}

const plainStatic = await project(ACC_PUBLIC | ACC_STATIC);
const syncStatic = await project(ACC_PUBLIC | ACC_STATIC | ACC_SYNCHRONIZED);
const syncInstance = await project(ACC_PUBLIC | ACC_SYNCHRONIZED);
const syncAbrupt = await project(ACC_PUBLIC | ACC_STATIC | ACC_SYNCHRONIZED, {
  codeBytes: [0x01, 0xbf], // aconst_null; athrow
  maxStack: 1,
});
const syncNative = await project(ACC_PUBLIC | ACC_STATIC | ACC_SYNCHRONIZED | ACC_NATIVE, { hasCode: false });

assert.equal(plainStatic.validation.status, 'valid');
assert.equal(plainStatic.validation.completeness.semanticEffect, 'complete');
assert.equal(plainStatic.decoded.aggregateCompleteness, 'exact');
assert.equal(plainStatic.lowered.semanticIr.completeness, 'complete');
assert.equal(plainStatic.decoded.metadata.synchronization, undefined);

for (const sync of [syncStatic, syncInstance, syncAbrupt, syncNative]) {
  assert.equal(sync.validation.status, 'partial');
  assert.deepEqual(sync.validation.errors, []);
  assert.equal(sync.validation.completeness.semanticEffect, 'partial');
  assert.equal(sync.decoded.aggregateCompleteness, 'partial');
  assert.ok(sync.decoded.bundles.some((bundle) =>
    bundle.unknownEffects.some((effect) => effect.reason === 'jvm-synchronized-method-monitor-unrepresented')));
  assert.equal(sync.lowered.semanticIr.completeness, 'partial');
  assert.ok(Object.isFrozen(sync.decoded.metadata.synchronization));
  assert.ok(sync.lowered.semanticIr.unknowns.some((unknown) =>
    unknown.reason === 'jvm-synchronized-method-monitor-unrepresented'));
}

assert.deepEqual(syncStatic.decoded.metadata.synchronization, {
  kind: 'implicit-jvm-monitor',
  monitor: 'declaring-class',
  acquire: 'method-entry',
  release: 'normal-or-abrupt-exit',
  reentrant: true,
  completeness: 'unrepresented',
});
assert.equal(syncInstance.decoded.metadata.synchronization.monitor, 'receiver');
assert.equal(syncAbrupt.decoded.metadata.synchronization.release, 'normal-or-abrupt-exit');
assert.equal(syncNative.decoded.metadata.synchronization.monitor, 'declaring-class');

// The same bytecode must no longer collapse to the same complete semantic
// projection solely because the method-level synchronization bit is metadata.
assert.notEqual(syncStatic.lowered.semanticIr.completeness, plainStatic.lowered.semanticIr.completeness);
