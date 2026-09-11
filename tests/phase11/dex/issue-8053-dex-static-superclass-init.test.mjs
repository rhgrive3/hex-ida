import assert from 'node:assert/strict';

import { dexFieldEffects } from '../../../js/managed/dex/field-effects.js';

function imageFor({ superType = null, includeSuper = true, superClinit = false, formatVersion = 'dex-035' } = {}) {
  const methods = [{ classType: 'LUser;', name: 'access' }];
  if (superClinit) methods.push({ classType: 'LSuper;', name: '<clinit>' });
  const classes = [
    {
      classType: 'LSub;',
      superType,
      staticFields: [{ fieldIdx: 0, accessFlags: 0x08 }],
      instanceFields: [],
    },
  ];
  if (includeSuper) {
    classes.push({ classType: 'LSuper;', superType: null, staticFields: [], instanceFields: [] });
  }
  return {
    moduleId: 'managed-mod:issue-8053-superclass',
    formatVersion,
    fields: [{ classType: 'LSub;', type: 'I', name: 'x' }],
    methods,
    classes,
  };
}

const access = { classType: 'LUser;', name: 'access' };

{
  const effect = dexFieldEffects({
    opcode: 0x60,
    formatByte: 0,
    fieldIndex: 0,
    image: imageFor({ superType: 'LSuper;', superClinit: true }),
    method: access,
  });
  assert.equal(effect.completeness, 'partial');
  assert.deepEqual(effect.unknownEffects, [
    { category: 'calls', reason: 'dex-class-initialization-unverified' },
  ]);
  assert.deepEqual(effect.memoryEffects[0].classInitialization, {
    declaringClass: 'LSub;',
    clinitPresent: false,
    initializationRequired: true,
    initializationProven: false,
    superclassInitializationRequired: true,
    superclassInitializerClass: 'LSuper;',
  });
}

{
  const effect = dexFieldEffects({
    opcode: 0x60,
    formatByte: 0,
    fieldIndex: 0,
    image: imageFor({ superType: 'LExternal;', includeSuper: false }),
    method: access,
  });
  assert.equal(effect.completeness, 'partial');
  assert.deepEqual(effect.unknownEffects, [
    { category: 'calls', reason: 'dex-class-initialization-superclass-unresolved' },
  ]);
  assert.equal(effect.memoryEffects[0].classInitialization.superclassAuthority, 'unresolved');
}

// DEX 035 cannot contain default interface methods. With a clean superclass
// chain, that proves there is no class-initialization trigger left in this
// slice and preserves the exact legacy control.
{
  const effect = dexFieldEffects({
    opcode: 0x60,
    formatByte: 0,
    fieldIndex: 0,
    image: imageFor({ superType: null, superClinit: false, formatVersion: 'dex-035' }),
    method: access,
  });
  assert.equal(effect.completeness, undefined);
  assert.equal(effect.unknownEffects, undefined);
  assert.deepEqual(effect.memoryEffects[0].classInitialization, {
    declaringClass: 'LSub;',
    clinitPresent: false,
    initializationRequired: false,
    initializationProven: false,
  });
}

// DEX 037+ admits default interface methods. Current-main class metadata does
// not provide canonical superinterface/default-method authority to this
// resolver, so a clean declaring/superclass chain alone is insufficient to
// publish an exact static access. Model the concrete counterexample explicitly
// to ensure the absent authority is never mistaken for proof of absence.
{
  const image = imageFor({ superType: 'LSuper;', formatVersion: 'dex-037' });
  image.classes[0].interfaces = ['LI;'];
  image.classes.push({
    classType: 'LI;',
    superType: null,
    accessFlags: 0x200,
    staticFields: [],
    instanceFields: [],
  });
  image.methods.push(
    { classType: 'LI;', name: 'defaultMethod', accessFlags: 0x1 },
    { classType: 'LI;', name: '<clinit>', accessFlags: 0x10008 },
  );
  const effect = dexFieldEffects({
    opcode: 0x60,
    formatByte: 0,
    fieldIndex: 0,
    image,
    method: access,
  });
  assert.equal(effect.completeness, 'partial');
  assert.deepEqual(effect.unknownEffects, [
    { category: 'calls', reason: 'dex-class-initialization-superinterface-authority-unavailable' },
  ]);
  assert.deepEqual(effect.memoryEffects[0].classInitialization, {
    declaringClass: 'LSub;',
    clinitPresent: false,
    initializationRequired: true,
    initializationProven: false,
    superinterfaceAuthority: 'unavailable',
  });
}

// Unknown/malformed version authority is conservative as well; callers cannot
// manufacture an exact result by omitting the version proof.
{
  const image = imageFor({ superType: null });
  delete image.formatVersion;
  const effect = dexFieldEffects({
    opcode: 0x60,
    formatByte: 0,
    fieldIndex: 0,
    image,
    method: access,
  });
  assert.equal(effect.completeness, 'partial');
  assert.deepEqual(effect.unknownEffects, [
    { category: 'calls', reason: 'dex-class-initialization-superinterface-authority-unavailable' },
  ]);
}
