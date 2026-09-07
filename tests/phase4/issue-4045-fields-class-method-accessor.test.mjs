import assert from 'node:assert/strict';
import { FieldIndex } from '../../js/fields.js';

const index = new FieldIndex({
  classes: [{
    name: 'C',
    instanceSize: 16,
    ivars: [{ name: '_foo', offset: 8, size: 8 }],
    properties: [{ name: 'foo', ivar: '_foo' }],
    methods: [
      { addr: 0x1000n, sel: 'foo', kind: '-' },
      { addr: 0x1004n, sel: 'setFoo:', kind: '-' },
      { addr: 0x3000n, sel: 'foo', kind: '-' },
    ],
    classMethods: [
      { addr: 0x2000n, sel: 'foo', kind: '+' },
      { addr: 0x2004n, sel: 'setFoo:' },
      { addr: 0x3000n, sel: 'foo', kind: '+' },
    ],
  }],
});

assert.equal(index.ownerOf(0x1000n)?.accessorField?.name, '_foo',
  'an instance getter must retain its declared ivar accessor evidence');
assert.equal(index.ownerOf(0x1004n)?.accessorField?.name, '_foo',
  'an instance setter must retain its declared ivar accessor evidence');

const classGetter = index.ownerOf(0x2000n);
assert.equal(classGetter?.kind, '+');
assert.equal(classGetter?.accessorField, null,
  'a class getter must not be promoted to an instance ivar accessor');

const classSetter = index.ownerOf(0x2004n);
assert.equal(classSetter?.kind, '+',
  'classMethods collection must retain the class-method fallback kind when metadata omits it');
assert.equal(classSetter?.accessorField, null,
  'a class setter must not be promoted to an instance ivar accessor');

const shared = index.ownersOf(0x3000n);
assert.equal(shared.length, 2, 'shared IMP must retain both instance and class owners');
const sharedInstance = shared.find((owner) => owner.kind === '-');
const sharedClass = shared.find((owner) => owner.kind === '+');
assert.equal(sharedInstance?.accessorField?.name, '_foo',
  'shared IMP instance owner must retain accessor evidence');
assert.equal(sharedClass?.accessorField, null,
  'shared IMP class owner must not inherit instance accessor evidence');

console.log('issue-4045-fields-class-method-accessor: PASS');
