import assert from 'node:assert/strict';
import { test } from 'node:test';

import { dexFieldEffects } from '../../js/managed/dex/field-effects.js';
import { resolveJvmFieldRef } from '../../js/managed/jvm/field-reference.js';

// #8829: field / class-initialization authority must be a per-image fact,
// not a per-instruction module-metadata rescan. These tests replace the raw
// metadata arrays on a synthetic image with counting stand-ins and assert that
// repeated field accesses of the same shape do not multiply the underlying
// `.filter` calls on the image-wide arrays.

function countingArray(items) {
  let filterCalls = 0;
  const arr = items.slice();
  Object.defineProperty(arr, 'filter', {
    configurable: true,
    writable: true,
    value(...args) { filterCalls += 1; return Array.prototype.filter.apply(arr, args); },
  });
  Object.defineProperty(arr, 'filterCalls', { configurable: true, enumerable: false, get: () => filterCalls });
  return arr;
}

function dexImageForStaticAccess(countUnrelatedMethods = 500) {
  const methods = [{ classType: 'LA;', name: 'A', accessFlags: 0x09 }];
  for (let i = 0; i < countUnrelatedMethods; i++) methods.push({ classType: 'LA;', name: `m${i}`, accessFlags: 0x09 });
  const classes = [{ classType: 'LA;', interfaceTypes: [], staticFields: [{ fieldIdx: 0, accessFlags: 0x09 }], instanceFields: [] }];
  const fields = [{ name: 'x', classType: 'LA;', type: 'I' }];
  const image = { formatVersion: 'dex-039', moduleId: 'mod:x', methods: countingArray(methods), classes: countingArray(classes), fields };
  return image;
}

test('DEX static sget: repeated accesses of the same field do not rescan image.methods per instruction', () => {
  const image = dexImageForStaticAccess(600);
  const op = () => dexFieldEffects({ opcode: 0x60, formatByte: 1, fieldIndex: 0, image, method: { classType: 'LA;', name: 'A' } });
  const first = op();
  assert.equal(first.completeness, 'exact', 'first access stays exact');
  assert.equal(first.memoryEffects[0].classInitialization.initializationRequired, false, 'no <clinit> => not required');
  assert.equal(first.memoryEffects[0].declarationResolved, true);
  const methodsBase = image.methods.filterCalls;
  const classesBase = image.classes.filterCalls;
  for (let i = 0; i < 500; i++) op();
  // The chain authority is keyed by (declaringClass, selfInitializing) and the
  // declaration by (fieldIndex, isStatic); once cached, the loop must add no
  // additional image-wide array scans.
  assert.equal(image.methods.filterCalls, methodsBase, `image.methods.filter re-invoked for cached sget accesses (${methodsBase} -> ${image.methods.filterCalls})`);
  assert.equal(image.classes.filterCalls, classesBase, `image.classes.filter re-invoked for cached sget accesses (${classesBase} -> ${image.classes.filterCalls})`);
  // Cross-check the returned effects are semantically identical across calls.
  const again = op();
  assert.deepEqual(again.memoryEffects[0].classInitialization, first.memoryEffects[0].classInitialization, 'cached chain result equals first');
});

test('DEX static sget: per-image cache is keyed by classType and does not leak across images', () => {
  const imageA = dexImageForStaticAccess(0);
  const imageB = dexImageForStaticAccess(0);
  imageB.classes[0].staticFields[0].accessFlags = 0x09;
  // Add a second class to imageB to prove per-image scoping.
  const a1 = dexFieldEffects({ opcode: 0x60, formatByte: 1, fieldIndex: 0, image: imageA, method: { classType: 'LA;', name: 'A' } });
  const b1 = dexFieldEffects({ opcode: 0x60, formatByte: 1, fieldIndex: 0, image: imageB, method: { classType: 'LA;', name: 'A' } });
  assert.equal(a1.memoryEffects[0].classInitialization.initializationRequired, false);
  assert.equal(b1.memoryEffects[0].classInitialization.initializationRequired, false);
});

function jvmClassForFieldAccess(fieldCount) {
  const pool = [null];
  const add = (e) => { pool.push(e); return pool.length - 1; };
  const thisNameIdx = add({ tag: 1, value: 'Stress' });
  const thisIdx = add({ tag: 7, nameIndex: thisNameIdx });
  const nameIdx = add({ tag: 1, value: 'f0' });
  const descIdx = add({ tag: 1, value: 'I' });
  const ntIdx = add({ tag: 12, nameIndex: nameIdx, descriptorIndex: descIdx });
  const fieldRef = add({ tag: 9, classIndex: thisIdx, nameAndTypeIndex: ntIdx });
  const fields = [];
  for (let i = 0; i < fieldCount; i++) fields.push({ name: i === 0 ? 'f0' : `f${i}`, descriptor: 'I', accessFlags: 0x0009 });
  const cls = {
    thisClassName: 'Stress',
    constantPool: pool,
    fields: countingArray(fields),
  };
  return { cls, cpIndex: fieldRef };
}

test('JVM resolveJvmFieldRef: repeated getstatic does not rescan declared fields per call', () => {
  const { cls, cpIndex } = jvmClassForFieldAccess(2000);
  const first = resolveJvmFieldRef(cls, cpIndex, { resolveDeclaredFlags: true });
  assert.equal(first.isVolatile, false, 'ACC_VOLATILE not set');
  assert.equal(first.declaredAccessFlags & 0x08, 0x08, 'ACC_STATIC kept');
  const afterFirst = cls.fields.filterCalls;
  for (let i = 0; i < 1000; i++) resolveJvmFieldRef(cls, cpIndex, { resolveDeclaredFlags: true });
  assert.equal(cls.fields.filterCalls, afterFirst, `jvmClass.fields.filter must not be re-invoked on cached (owner,name,descriptor) hits (was ${afterFirst}, became ${cls.fields.filterCalls})`);
});
