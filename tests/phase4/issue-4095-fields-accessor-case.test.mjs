import assert from 'node:assert/strict';
import { FieldIndex } from '../../js/fields.js';

const collision = new FieldIndex({
  classes: [{
    name: 'C',
    instanceSize: 16,
    ivars: [
      { name: '_foo', offset: 0, size: 4 },
      { name: '_Foo', offset: 4, size: 4 },
    ],
    properties: [],
    methods: [
      { addr: 0x1000n, sel: 'Foo', kind: '-' },
      { addr: 0x1004n, sel: 'foo', kind: '-' },
      { addr: 0x1008n, sel: 'setFoo:', kind: '-' },
    ],
    classMethods: [],
  }],
});

assert.equal(collision.ownerOf(0x1000n)?.accessorField?.name, '_Foo',
  'getter selector Foo must preserve case and resolve only _Foo');
assert.equal(collision.ownerOf(0x1004n)?.accessorField?.name, '_foo',
  'getter selector foo must preserve case and resolve only _foo');
assert.equal(collision.ownerOf(0x1008n)?.accessorField, null,
  'setter whose capitalization maps to multiple case-distinct fields must stay ambiguous');

const normal = new FieldIndex({
  classes: [{
    name: 'Normal',
    instanceSize: 16,
    ivars: [{ name: '_foo', offset: 0, size: 4 }],
    properties: [{ name: 'foo', ivar: '_foo' }],
    methods: [
      { addr: 0x2000n, sel: 'foo', kind: '-' },
      { addr: 0x2004n, sel: 'setFoo:', kind: '-' },
      { addr: 0x2008n, sel: 'setfoo:', kind: '-' },
    ],
    classMethods: [],
  }],
});
assert.equal(normal.ownerOf(0x2000n)?.accessorField?.name, '_foo',
  'ordinary getter mapping must be preserved');
assert.equal(normal.ownerOf(0x2004n)?.accessorField?.name, '_foo',
  'ordinary Objective-C setter mapping must be preserved');
assert.equal(normal.ownerOf(0x2008n)?.accessorField, null,
  'non-canonical setter capitalization must not be case-folded into a match');

const propertyCase = new FieldIndex({
  classes: [{
    name: 'PropertyCase',
    instanceSize: 16,
    ivars: [{ name: '_backing', offset: 0, size: 4 }],
    properties: [{ name: 'Foo', ivar: '_backing' }],
    methods: [
      { addr: 0x3000n, sel: 'Foo', kind: '-' },
      { addr: 0x3004n, sel: 'foo', kind: '-' },
      { addr: 0x3008n, sel: 'setFoo:', kind: '-' },
    ],
    classMethods: [],
  }],
});
assert.equal(propertyCase.ownerOf(0x3000n)?.accessorField?.name, '_backing',
  'declared property name must be matched case-sensitively');
assert.equal(propertyCase.ownerOf(0x3004n)?.accessorField, null,
  'case-distinct getter must not match declared property metadata');
assert.equal(propertyCase.ownerOf(0x3008n)?.accessorField?.name, '_backing',
  'setter mapping through a declared property must remain supported');

console.log('issue-4095-fields-accessor-case: PASS');
