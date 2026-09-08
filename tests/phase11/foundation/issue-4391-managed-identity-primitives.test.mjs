import assert from 'node:assert/strict';
import test from 'node:test';
import * as ids from '../../../js/managed/shared/identity.js';

const textual = [
  ['image binary', (x) => ids.createManagedImageId(x)],
  ['image member', (x) => ids.createManagedImageId('bin', x)],
  ['module parent', (x) => ids.createManagedModuleId(x, 'main')],
  ['type parent', (x) => ids.createManagedTypeId(x, 'C')],
  ['method parent', (x) => ids.createManagedMethodId(x, 0)],
  ['method signature', (x) => ids.createManagedMethodId('m', 0, x)],
  ['field parent', (x) => ids.createManagedFieldId(x, 'x')],
  ['operation parent', (x) => ids.createVMOperationId(x, 0)],
  ['value parent', (x) => ids.createVMValueId(x, 'op', 0)],
  ['value operation', (x) => ids.createVMValueId('m', x, 0)],
  ['frame parent', (x) => ids.createVMFrameStateId(x, 0)],
  ['call parent', (x) => ids.createManagedCallSiteId(x, 0)],
  ['exception parent', (x) => ids.createManagedExceptionRegionId(x, 0)],
  ['profile frontend', (x) => ids.createManagedTargetProfileId(x, 1, 'edition')],
];
for (const [name, make] of textual) {
  test(`#4391 ${name} is a nonempty string identity`, () => {
    for (const value of [[], ['id'], {}, true, false, 0, 1, '', ' ']) assert.throws(() => make(value), TypeError);
    assert.equal(make(' id '), make('id'));
  });
}

const namedOrIndexed = [
  ['module', (x) => ids.createManagedModuleId('i', x)],
  ['type', (x) => ids.createManagedTypeId('m', x)],
  ['method', (x) => ids.createManagedMethodId('m', x)],
  ['field', (x) => ids.createManagedFieldId('t', x)],
  ['slot', (x) => ids.createVMValueId('m', 'op', x)],
  ['format version', (x) => ids.createManagedTargetProfileId('wasm', x, 'edition')],
  ['spec edition', (x) => ids.createManagedTargetProfileId('wasm', 1, x)],
];
for (const [name, make] of namedOrIndexed) {
  test(`#4391 ${name} allows explicit string or nonnegative integer token, not coercion`, () => {
    for (const value of [['1'], {}, true, false, NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => make(value), TypeError);
    assert.equal(make(0), make('0'));
    assert.equal(make(16), make('16'));
    assert.ok(make('named-token').endsWith('named-token') || name === 'format version');
  });
}

const numeric = [
  ['offset', (x) => ids.createVMOperationId('m', x)],
  ['sequence', (x) => ids.createVMOperationId('m', 0, x)],
  ['frame offset', (x) => ids.createVMFrameStateId('m', x)],
  ['call offset', (x) => ids.createManagedCallSiteId('m', x)],
  ['call index', (x) => ids.createManagedCallSiteId('m', 0, x)],
  ['handler index', (x) => ids.createManagedExceptionRegionId('m', x)],
];
for (const [name, make] of numeric) {
  test(`#4391 ${name} requires a primitive nonnegative safe integer`, () => {
    for (const value of [[16], {}, true, false, '16', '', null, NaN, Infinity, -1, 1.5, 1n, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => make(value), TypeError);
    assert.doesNotThrow(() => make(0));
    assert.doesNotThrow(() => make(Number.MAX_SAFE_INTEGER));
  });
}

test('#4391 established identifier spelling and optional-null semantics remain stable', () => {
  assert.equal(ids.createManagedImageId('bin'), 'managed-image:bin');
  assert.equal(ids.createManagedImageId('bin', null), 'managed-image:bin');
  assert.equal(ids.createManagedMethodId('m', 0, null), 'managed-method:m:0');
  assert.equal(ids.createVMOperationId('m', 16, 2), 'vm-op:m:0x10:2');
  assert.equal(ids.createVMFrameStateId('m', 16), 'vm-frame:m:0x10');
});
