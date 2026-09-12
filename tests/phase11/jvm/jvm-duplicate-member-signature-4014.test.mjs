import assert from 'node:assert/strict';
import { parseJvm } from '../../../js/managed/jvm/parser.js';

function buildClass({ fields = [], methods = [] } = {}) {
  const out = [];
  const u1 = (n) => out.push(n & 0xff);
  const u2 = (n) => out.push((n >>> 8) & 0xff, n & 0xff);
  const u4 = (n) => out.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
  const utf = (text) => {
    const bytes = Buffer.from(text, 'utf8');
    u1(1); u2(bytes.length); out.push(...bytes);
  };

  u4(0xcafebabe); u2(0); u2(61);
  // 1 DupMembers, 2 Class#1, 3 Object, 4 Class#3,
  // 5 x, 6 I, 7 J, 8 foo, 9 ()V, 10 (I)V,
  // 11 x, 12 I, 13 foo, 14 ()V (distinct CP entries, same resolved text).
  u2(15);
  utf('DupMembers'); u1(7); u2(1);
  utf('java/lang/Object'); u1(7); u2(3);
  utf('x'); utf('I'); utf('J'); utf('foo'); utf('()V'); utf('(I)V');
  utf('x'); utf('I'); utf('foo'); utf('()V');

  u2(0x0421); // public | super | abstract
  u2(2); u2(4); u2(0); // this, super, interfaces_count

  u2(fields.length);
  for (const field of fields) {
    u2(field.flags ?? 0x0001);
    u2(field.nameIndex);
    u2(field.descriptorIndex);
    u2(0); // attributes_count
  }

  u2(methods.length);
  for (const method of methods) {
    u2(method.flags ?? 0x0401); // public | abstract => no Code attribute
    u2(method.nameIndex);
    u2(method.descriptorIndex);
    u2(0); // attributes_count
  }

  u2(0); // class attributes_count
  return Uint8Array.from(out);
}

assert.throws(
  () => parseJvm(buildClass({
    fields: [
      { nameIndex: 5, descriptorIndex: 6 },
      { nameIndex: 5, descriptorIndex: 6 },
    ],
  })),
  /jvm-duplicate-field-name-descriptor/,
  'a class must not declare the same field name+descriptor twice',
);

assert.throws(
  () => parseJvm(buildClass({
    methods: [
      { nameIndex: 8, descriptorIndex: 9 },
      { nameIndex: 8, descriptorIndex: 9 },
    ],
  })),
  /jvm-duplicate-method-name-descriptor/,
  'a class must not declare the same method name+descriptor twice',
);

assert.throws(
  () => parseJvm(buildClass({
    fields: [
      { nameIndex: 5, descriptorIndex: 6 },
      { nameIndex: 11, descriptorIndex: 12 },
    ],
  })),
  /jvm-duplicate-field-name-descriptor/,
  'duplicate field identity is based on resolved text, not raw constant-pool indices',
);

assert.throws(
  () => parseJvm(buildClass({
    methods: [
      { nameIndex: 8, descriptorIndex: 9 },
      { nameIndex: 13, descriptorIndex: 14 },
    ],
  })),
  /jvm-duplicate-method-name-descriptor/,
  'duplicate method identity is based on resolved text, not raw constant-pool indices',
);

const sameFieldNameDifferentDescriptor = parseJvm(buildClass({
  fields: [
    { nameIndex: 5, descriptorIndex: 6 },
    { nameIndex: 5, descriptorIndex: 7 },
  ],
}));
assert.equal(sameFieldNameDifferentDescriptor.fields.length, 2);
assert.deepEqual(
  sameFieldNameDifferentDescriptor.fields.map((field) => field.descriptor),
  ['I', 'J'],
  'field uniqueness is the full name+descriptor pair, not name alone',
);

const overloadedMethods = parseJvm(buildClass({
  methods: [
    { nameIndex: 8, descriptorIndex: 9 },
    { nameIndex: 8, descriptorIndex: 10 },
  ],
}));
assert.equal(overloadedMethods.methods.length, 2);
assert.deepEqual(
  overloadedMethods.methods.map((method) => method.descriptor),
  ['()V', '(I)V'],
  'method overloading by descriptor remains valid',
);

const separateNamespaces = parseJvm(buildClass({
  fields: [{ nameIndex: 8, descriptorIndex: 6 }],
  methods: [{ nameIndex: 8, descriptorIndex: 9 }],
}));
assert.equal(separateNamespaces.fields[0].name, 'foo');
assert.equal(separateNamespaces.methods[0].name, 'foo');

console.log('[phase11] jvm duplicate member signature #4014 tests passed');
