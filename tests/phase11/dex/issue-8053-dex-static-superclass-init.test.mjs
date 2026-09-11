import assert from 'node:assert/strict';

import { dexFieldEffects } from '../../../js/managed/dex/field-effects.js';

function imageFor({ superType = null, includeSuper = true, superClinit = false } = {}) {
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

{
  const effect = dexFieldEffects({
    opcode: 0x60,
    formatByte: 0,
    fieldIndex: 0,
    image: imageFor({ superType: null, superClinit: false }),
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
