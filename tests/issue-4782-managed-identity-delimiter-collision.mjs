import assert from 'node:assert/strict';

import {
  createManagedCallSiteId,
  createManagedExceptionRegionId,
  createManagedFieldId,
  createManagedImageId,
  createManagedMethodId,
  createManagedModuleId,
  createManagedTargetProfileId,
  createManagedTypeId,
  createVMFrameStateId,
  createVMOperationId,
  createVMValueId,
} from '../js/managed/shared/identity.js';

const colonTuples = [
  ['managed-type:managed-mod:img:A', 'B', null],
  ['managed-type:managed-mod:img', 'A:B', null],
  ['managed-type:managed-mod:img:A', 'B', 'sig'],
  ['managed-type:managed-mod:img', 'A:B', 'sig'],
  ['managed-type:managed-mod:img', 'A', 'B:sig'],
  ['managed-type:managed-mod', 'img:A', 'B'],
];

{
  const ids = colonTuples.map(([parent, method, signature]) => createManagedMethodId(parent, method, signature));
  assert.equal(new Set(ids).size, ids.length, 'distinct managed-method tuples must not share one id');
  assert.notEqual(
    createManagedMethodId('managed-type:managed-mod:img:A', 'B'),
    createManagedMethodId('managed-type:managed-mod:img', 'A:B'),
    'the #4782 method tuple must not collide',
  );
}

assert.notEqual(
  createManagedImageId('binary:A', 'B'),
  createManagedImageId('binary', 'A:B'),
  'the #4782 image tuple must not collide',
);

const builders = [
  ['image', (...parts) => createManagedImageId(...parts)],
  ['module', (...parts) => createManagedModuleId(...parts)],
  ['type', (...parts) => createManagedTypeId(...parts)],
  ['method', (...parts) => createManagedMethodId(...parts)],
  ['field', (...parts) => createManagedFieldId(...parts)],
  ['value', (...parts) => createVMValueId(...parts)],
  ['profile', (...parts) => createManagedTargetProfileId(...parts)],
];

// Every fixed-arity builder must be injective over separator-bearing components,
// including the escape marker itself.
for (const [name, build] of builders) {
  const arity = { image: 2, module: 2, type: 2, method: 3, field: 2, value: 3, profile: 3 }[name];
  const alphabet = ['a', 'a:b', 'a%3Ab', 'a%253Ab', 'b:c', ':', '%', 'a:', ':a'];
  const ids = [];
  const walk = (prefix) => {
    if (prefix.length === arity) {
      ids.push(build(...prefix));
      return;
    }
    for (const part of alphabet) walk([...prefix, part]);
  };
  walk([]);
  assert.equal(new Set(ids).size, ids.length, `${name} identity components must be boundary-safe`);
}

// Optional components must not alias a shorter tuple whose tail carries the separator.
assert.notEqual(createManagedImageId('a:b'), createManagedImageId('a', 'b'));
assert.notEqual(createManagedImageId('a', 'b'), createManagedImageId('a:b:'));
assert.notEqual(
  createManagedMethodId('managed-type:mod', 'meth'),
  createManagedMethodId('managed-type:mod', 'meth:x', 'y'),
);
assert.notEqual(
  createManagedTargetProfileId('front:x', 'fmt', 'spec'),
  createManagedTargetProfileId('front', 'x:fmt', 'spec'),
);
assert.notEqual(
  createManagedTargetProfileId('front', 'fmt', 'spec:x'),
  createManagedTargetProfileId('front', 'fmt', 'spec', { featureSet: ['x'] }),
);

// Numeric-derived components stay boundary-safe, and the escape marker is not
// confusable with a raw separator in a parent identity.
assert.notEqual(
  createVMOperationId('managed-method:a:b', 0x10, 2),
  createVMOperationId('managed-method:a%3Ab', 0x10, 2),
);
assert.notEqual(
  createVMValueId('managed-method:a:b', 'vm-op:x', 0),
  createVMValueId('managed-method:a', 'b:vm-op:x', 0),
);
assert.notEqual(
  createVMFrameStateId('managed-method:a:b', 1),
  createVMFrameStateId('managed-method:a%3Ab', 1),
);
assert.notEqual(
  createManagedCallSiteId('managed-method:a:b', 0, 1),
  createManagedCallSiteId('managed-method:a%3Ab', 0, 1),
);
assert.notEqual(
  createManagedExceptionRegionId('managed-method:a:b', 1),
  createManagedExceptionRegionId('managed-method:a%3Ab', 1),
);
assert.notEqual(
  createManagedFieldId('managed-type:a:b', 'c'),
  createManagedFieldId('managed-type:a', 'b:c'),
);
assert.notEqual(
  createManagedTypeId('managed-mod:a:b', 'c'),
  createManagedTypeId('managed-mod:a', 'b:c'),
);
assert.notEqual(
  createManagedModuleId('managed-image:a:b', 'c'),
  createManagedModuleId('managed-image:a', 'b:c'),
);

// The same tuple always reaches the same canonical id, and trimming stays canonical.
for (const [name, build] of [
  ['image', () => createManagedImageId(' bin ', ' sub ')],
  ['module', () => createManagedModuleId(' managed-image:bin ', ' classes.dex ')],
  ['type', () => createManagedTypeId('managed-mod:managed-image:bin', ' Lcom/x/C; ')],
  ['method', () => createManagedMethodId('managed-type:managed-mod:managed-image:bin:C', ' m ', '(I)V ')],
  ['field', () => createManagedFieldId('managed-type:managed-mod:managed-image:bin:C', ' f ')],
  ['value', () => createVMValueId('managed-method:managed-type:m', 'vm-op:o:0x0:0', ' r0 ')],
  ['profile', () => createManagedTargetProfileId(' wasm ', 1, ' core-3.0 ')],
]) {
  assert.equal(build(), build(), `${name} canonical id must be stable`);
}
assert.equal(createManagedImageId(' bin '), createManagedImageId('bin'));
assert.equal(createManagedImageId('\u00a0bin\u00a0'), createManagedImageId('bin'));
assert.equal(createManagedImageId('\u3000bin\u3000'), createManagedImageId('bin'));
assert.notEqual(createManagedImageId('a\uff1ab'), createManagedImageId('a:b'));
assert.notEqual(createManagedImageId('a', 'b\uff1ac'), createManagedImageId('a', 'b:c'));
assert.equal(createManagedMethodId('managed-type:m', ' x ', ' sig '), createManagedMethodId('managed-type:m', 'x', 'sig'));
assert.equal(createManagedModuleId('managed-image:bin', 0), createManagedModuleId('managed-image:bin', '0'));

// Components without the separator or the escape marker keep the established readable spelling.
assert.equal(createManagedImageId('bin-123'), 'managed-image:bin-123');
assert.equal(createManagedImageId('bin-123', 'sub-entry'), 'managed-image:bin-123:sub-entry');
assert.equal(createManagedMethodId('m', 0, null), 'managed-method:m:0');
assert.equal(createVMOperationId('m', 16, 2), 'vm-op:m:0x10:2');
assert.equal(createVMFrameStateId('m', 16), 'vm-frame:m:0x10');
assert.equal(createManagedExceptionRegionId('m', 3), 'managed-exc:m:3');
assert.equal(createManagedCallSiteId('m', 16, 1), 'managed-call:m:0x10:1');
assert.equal(createManagedTypeId('moduleIdToken', 'Lcom/example/MyClass;'), 'managed-type:moduleIdToken:Lcom/example/MyClass;');
assert.equal(createManagedFieldId('typeIdToken', 'mField'), 'managed-field:typeIdToken:mField');
assert.equal(createVMValueId('methodIdToken', 'operationIdToken', 'r0'), 'vm-val:methodIdToken:operationIdToken:r0');
assert.ok(createManagedTargetProfileId('wasm', '1', 'core-3.0').startsWith('managed-profile:wasm:1:core-3.0'));
assert.ok(createManagedTargetProfileId('wasm', '1', 'core-3.0', { featureSet: ['simd'] }).startsWith('managed-profile:wasm:1:core-3.0:'));

// Validation contracts are unchanged: only non-empty strings / safe integers are accepted.
for (const value of [[], ['id'], {}, true, false, '', ' ']) {
  assert.throws(() => createManagedImageId(value), TypeError);
  assert.throws(() => createManagedMethodId(value, 0), TypeError);
}
for (const value of [[16], {}, true, '16', '', null, NaN, -1, 1.5]) {
  assert.throws(() => createVMOperationId('m', value), TypeError);
}
