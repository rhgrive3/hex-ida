import assert from 'node:assert/strict';
import { parseJvm } from '../../../js/managed/jvm/parser.js';
import { parseJvmFieldDescriptor, parseJvmMethodDescriptor } from '../../../js/managed/jvm/descriptors.js';

console.log('[phase11] running JVM descriptor grammar #3896 tests...');

const typedArray = parseJvmFieldDescriptor('[[Ljava/lang/String;');
assert.equal(typedArray.type.kind, 'array');
assert.equal(typedArray.type.dimensions, 2);
assert.equal(typedArray.type.component.className, 'java/lang/String');
const typedMethod = parseJvmMethodDescriptor('(J[Ljava/lang/Object;)V');
assert.equal(typedMethod.parameters.length, 2);
assert.equal(typedMethod.parameters[0].tag, 'J');
assert.equal(typedMethod.parameters[1].kind, 'array');
assert.equal(typedMethod.returnType, null);
assert.doesNotThrow(() => parseJvmMethodDescriptor(`(${'I'.repeat(255)})V`));
assert.throws(() => parseJvmMethodDescriptor(`(${'I'.repeat(256)})V`), /jvm-invalid-method-descriptor/);
assert.throws(() => parseJvmMethodDescriptor(`(${'J'.repeat(128)})V`), /jvm-invalid-method-descriptor/);

function buildDescriptorClass({ fieldDescriptor = null, methodDescriptor = null, methodAccessFlags = 0x0401 } = {}) {
  const bytes = [];
  const u1 = (value) => bytes.push(value & 0xff);
  const u2 = (value) => { u1(value >>> 8); u1(value); };
  const u4 = (value) => { u1(value >>> 24); u1(value >>> 16); u1(value >>> 8); u1(value); };
  const utf8 = (text) => {
    const encoded = new TextEncoder().encode(text);
    u1(1); u2(encoded.length);
    for (const byte of encoded) u1(byte);
  };

  u4(0xcafebabe); u2(0); u2(61);

  const entries = [
    ['utf8', 'A'],
    ['class', 1],
    ['utf8', 'java/lang/Object'],
    ['class', 3],
  ];
  let fieldNameIndex = 0;
  let fieldDescriptorIndex = 0;
  let methodNameIndex = 0;
  let methodDescriptorIndex = 0;
  if (fieldDescriptor != null) {
    fieldNameIndex = entries.length + 1; entries.push(['utf8', 'x']);
    fieldDescriptorIndex = entries.length + 1; entries.push(['utf8', fieldDescriptor]);
  }
  if (methodDescriptor != null) {
    methodNameIndex = entries.length + 1; entries.push(['utf8', 'm']);
    methodDescriptorIndex = entries.length + 1; entries.push(['utf8', methodDescriptor]);
  }

  u2(entries.length + 1);
  for (const [kind, value] of entries) {
    if (kind === 'utf8') utf8(value);
    else { u1(7); u2(value); }
  }

  u2(0x0421); // public + super + abstract
  u2(2);      // this_class = A
  u2(4);      // super_class = java/lang/Object
  u2(0);      // interfaces_count

  u2(fieldDescriptor == null ? 0 : 1);
  if (fieldDescriptor != null) {
    u2(0x0001); u2(fieldNameIndex); u2(fieldDescriptorIndex); u2(0);
  }

  u2(methodDescriptor == null ? 0 : 1);
  if (methodDescriptor != null) {
    u2(methodAccessFlags);
    u2(methodNameIndex); u2(methodDescriptorIndex); u2(0);
  }

  u2(0); // class attributes_count
  return Uint8Array.from(bytes);
}

for (const descriptor of ['I', 'Ljava/lang/String;', '[[I', '[Ljava/lang/Object;', 'Lpkg/$Inner;']) {
  const parsed = parseJvm(buildDescriptorClass({ fieldDescriptor: descriptor }));
  assert.equal(parsed.fields[0].descriptor, descriptor);
}

for (const descriptor of ['V', 'Ljava/lang/String', '[V', 'I;', `${'['.repeat(256)}I`, 'Lfoo.bar;', 'Lfoo[bar;', 'L/foo;', 'Lfoo//bar;', 'Lfoo/;']) {
  assert.throws(
    () => parseJvm(buildDescriptorClass({ fieldDescriptor: descriptor })),
    /jvm-invalid-field-descriptor/,
    `field descriptor should be rejected: ${descriptor}`,
  );
}

for (const descriptor of ['()V', '([Ljava/lang/String;I)V', '(JD)Ljava/lang/Object;', '()[[I']) {
  const parsed = parseJvm(buildDescriptorClass({ methodDescriptor: descriptor }));
  assert.equal(parsed.methods[0].descriptor, descriptor);
}

for (const descriptor of ['I', '()', '([V)V', '(V)V', '(I)Vx', '(()V', `(${'['.repeat(256)}I)V`, `(${'I'.repeat(256)})V`, `(${'J'.repeat(128)})V`]) {
  assert.throws(
    () => parseJvm(buildDescriptorClass({ methodDescriptor: descriptor })),
    /jvm-invalid-method-descriptor/,
    `method descriptor should be rejected: ${descriptor}`,
  );
}

const instance254 = `(${'I'.repeat(254)})V`;
assert.equal(parseJvm(buildDescriptorClass({ methodDescriptor: instance254 })).methods[0].descriptor, instance254);
const explicit255 = `(${'I'.repeat(255)})V`;
assert.throws(
  () => parseJvm(buildDescriptorClass({ methodDescriptor: explicit255 })),
  /jvm-invalid-method-descriptor/,
  'instance method must include implicit this in the 255-unit limit',
);
assert.equal(
  parseJvm(buildDescriptorClass({ methodDescriptor: explicit255, methodAccessFlags: 0x0109 })).methods[0].descriptor,
  explicit255,
  'static/native method may use all 255 explicit parameter units',
);

console.log('  ok JVM descriptor grammar #3896 tests passed');
