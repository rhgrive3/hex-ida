import assert from 'node:assert/strict';
import test from 'node:test';

import { parseDex } from '../../../js/managed/dex/parser.js';
import { DexFrontend } from '../../../js/managed/dex/frontend.js';
import { buildDex } from '../fixtures/medium-dex.mjs';

// #7436: class_def_item.class_idx (and non-NO_INDEX superclass_idx) must be
// class types. Primitives and arrays are legal type_ids for other roles, but a
// class definition defined by `I` or `[I` is a DEX-format violation the parser
// used to publish as a normal defined class.

function classDefBytes(classNames) {
  return buildDex({ classNames, methods: [], fields: [] }).bytes;
}

function withSuperclass({ classNames, fields, superType }) {
  const { bytes, layout } = buildDex({ classNames, methods: [], fields });
  const typeIndex = layout.typesList.indexOf(superType);
  assert.ok(typeIndex >= 0, `fixture type ${superType} must exist in the type table`);
  const view = new DataView(bytes.buffer);
  view.setUint32(layout.classes + 8, typeIndex, true);
  return bytes;
}

test('#7436 a class type is still accepted as the class-def definer', () => {
  const image = parseDex(classDefBytes(['LImpl;']));
  assert.deepEqual(image.classes.map((cls) => cls.classType), ['LImpl;']);
});

test('#7436 a primitive class-def type is rejected', () => {
  assert.throws(() => parseDex(classDefBytes(['I'])), /dex-invalid-class-definer-type/);
  assert.throws(() => parseDex(classDefBytes(['J'])), /dex-invalid-class-definer-type/);
});

test('#7436 an array class-def type is rejected', () => {
  assert.throws(() => parseDex(classDefBytes(['[I'])), /dex-invalid-class-definer-type/);
  assert.throws(() => parseDex(classDefBytes(['[LImpl;'])), /dex-invalid-class-definer-type/);
});

test('#7436 a class superclass is accepted', () => {
  const bytes = withSuperclass({
    classNames: ['LImpl;'],
    fields: [{ classType: 'LImpl;', type: 'Ljava/lang/Object;', name: 'x' }],
    superType: 'Ljava/lang/Object;',
  });
  const image = parseDex(bytes);
  assert.equal(image.classes[0].superType, 'Ljava/lang/Object;');
});

test('#7436 a primitive or array superclass is rejected', () => {
  assert.throws(() => parseDex(withSuperclass({
    classNames: ['LImpl;'],
    fields: [{ classType: 'LImpl;', type: 'I', name: 'x' }],
    superType: 'I',
  })), /dex-invalid-superclass-type/);
  assert.throws(() => parseDex(withSuperclass({
    classNames: ['LImpl;'],
    fields: [{ classType: 'LImpl;', type: '[I', name: 'x' }],
    superType: '[I',
  })), /dex-invalid-superclass-type/);
});

test('#7436 no primitive or array class identity reaches the frontend type enumeration', async () => {
  const frontend = new DexFrontend();
  const image = await frontend.open(classDefBytes(['LImpl;']));
  const enumerated = [];
  for await (const type of frontend.enumerateTypes(image)) enumerated.push(type.classType);
  assert.deepEqual(enumerated, ['LImpl;']);
});
