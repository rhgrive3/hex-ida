import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseJvm } from '../../../js/managed/jvm/parser.js';

const ACC_PUBLIC = 0x0001;
const ACC_STATIC = 0x0008;
const ACC_FINAL = 0x0010;

function buildConstantValueClass({ fields, classAccessFlags = 0x0021, major = 61 } = {}) {
  const constantPool = [null];
  const add = (entry) => {
    const index = constantPool.length;
    constantPool.push(entry);
    if (entry.tag === 5 || entry.tag === 6) constantPool.push(null);
    return index;
  };
  const addUtf8 = (value) => add({ tag: 1, value });
  const thisNameIndex = addUtf8('ConstantValues');
  const thisClassIndex = add({ tag: 7, nameIndex: thisNameIndex });
  const superNameIndex = addUtf8('java/lang/Object');
  const superClassIndex = add({ tag: 7, nameIndex: superNameIndex });
  const constantValueNameIndex = addUtf8('ConstantValue');

  const addConstant = (spec) => {
    if (!spec) return null;
    if (spec.tag === 8) {
      const stringIndex = addUtf8(spec.value);
      return add({ tag: 8, stringIndex });
    }
    return add({ tag: spec.tag, value: spec.value });
  };

  const encodedFields = fields.map((field) => {
    const defaultConstantIndex = addConstant(field.constant);
    const attributes = field.attributes ?? (field.constant ? [{ index: defaultConstantIndex }] : []);
    const encodedAttributes = attributes.map((attribute) => {
      const nameIndex = attribute.nameIndex ?? (
        attribute.name == null || attribute.name === 'ConstantValue'
          ? constantValueNameIndex
          : addUtf8(attribute.name)
      );
      const index = attribute.index ?? defaultConstantIndex ?? 0;
      const length = attribute.length ?? 2;
      const payload = attribute.payload ?? [(index >>> 8) & 0xff, index & 0xff];
      return { nameIndex, length, payload };
    });
    return {
      accessFlags: field.accessFlags ?? (ACC_PUBLIC | ACC_STATIC | ACC_FINAL),
      nameIndex: addUtf8(field.name),
      descriptorIndex: addUtf8(field.descriptor),
      attributes: encodedAttributes,
    };
  });

  const bytes = [];
  const u1 = (value) => bytes.push(value & 0xff);
  const u2 = (value) => bytes.push((value >>> 8) & 0xff, value & 0xff);
  const u4 = (value) => bytes.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
  const f4 = (value) => {
    const buffer = new ArrayBuffer(4);
    new DataView(buffer).setFloat32(0, value, false);
    bytes.push(...new Uint8Array(buffer));
  };
  const f8 = (value) => {
    const buffer = new ArrayBuffer(8);
    new DataView(buffer).setFloat64(0, value, false);
    bytes.push(...new Uint8Array(buffer));
  };
  const i8 = (value) => {
    const buffer = new ArrayBuffer(8);
    new DataView(buffer).setBigInt64(0, BigInt(value), false);
    bytes.push(...new Uint8Array(buffer));
  };

  u4(0xcafebabe); u2(0); u2(major); u2(constantPool.length);
  for (let index = 1; index < constantPool.length; index++) {
    const entry = constantPool[index];
    if (entry == null) continue;
    u1(entry.tag);
    if (entry.tag === 1) {
      const encoded = Buffer.from(entry.value, 'utf8');
      u2(encoded.length); bytes.push(...encoded);
    } else if (entry.tag === 3) {
      u4(entry.value);
    } else if (entry.tag === 4) {
      f4(entry.value);
    } else if (entry.tag === 5) {
      i8(entry.value);
    } else if (entry.tag === 6) {
      f8(entry.value);
    } else if (entry.tag === 7 || entry.tag === 8) {
      u2(entry.nameIndex ?? entry.stringIndex);
    } else {
      throw new TypeError(`unsupported test CP tag ${entry.tag}`);
    }
  }

  u2(classAccessFlags); u2(thisClassIndex); u2(superClassIndex); u2(0);
  u2(encodedFields.length);
  for (const field of encodedFields) {
    u2(field.accessFlags); u2(field.nameIndex); u2(field.descriptorIndex); u2(field.attributes.length);
    for (const attribute of field.attributes) {
      u2(attribute.nameIndex); u4(attribute.length); bytes.push(...attribute.payload);
    }
  }
  u2(0); // methods_count
  u2(0); // class attributes_count
  return Uint8Array.from(bytes);
}

function fieldByName(image, name) {
  const field = image.fields.find((candidate) => candidate.name === name);
  assert.ok(field, `field ${name} should be present`);
  return field;
}

test('#7409 resolves valid ConstantValue entries and retains CP provenance', () => {
  const image = parseJvm(buildConstantValueClass({
    fields: [
      { name: 'byteValue', descriptor: 'B', constant: { tag: 3, value: 7 } },
      { name: 'charValue', descriptor: 'C', constant: { tag: 3, value: 65 } },
      { name: 'shortValue', descriptor: 'S', constant: { tag: 3, value: -2 } },
      { name: 'boolValue', descriptor: 'Z', constant: { tag: 3, value: 1 } },
      { name: 'intValue', descriptor: 'I', constant: { tag: 3, value: 42 } },
      { name: 'floatValue', descriptor: 'F', constant: { tag: 4, value: 1.25 } },
      { name: 'longValue', descriptor: 'J', constant: { tag: 5, value: 0x123456789n } },
      { name: 'doubleValue', descriptor: 'D', constant: { tag: 6, value: 2.5 } },
      { name: 'stringValue', descriptor: 'Ljava/lang/String;', constant: { tag: 8, value: 'ok' } },
    ],
  }), { binaryId: 'jvm-constant-value-7409' });

  for (const [name, value, tag] of [
    ['byteValue', 7, 3], ['charValue', 65, 3], ['shortValue', -2, 3],
    ['boolValue', 1, 3], ['intValue', 42, 3], ['floatValue', 1.25, 4],
    ['longValue', 0x123456789n, 5], ['doubleValue', 2.5, 6], ['stringValue', 'ok', 8],
  ]) {
    const field = fieldByName(image, name);
    assert.deepEqual(field.constantValue, {
      constantPoolIndex: image.constantPool.findIndex((entry) => entry?.tag === tag && (
        tag === 8 ? image.constantPool[entry.stringIndex]?.value === value : Object.is(entry.value, value)
      )),
      tag,
      value,
      runtimeInitialized: true,
    });
  }
});

test('#7409 distinguishes non-static ConstantValue metadata from class initialization', () => {
  const image = parseJvm(buildConstantValueClass({
    fields: [
      { name: 'instanceValue', descriptor: 'I', accessFlags: ACC_PUBLIC, constant: { tag: 3, value: 9 } },
      { name: 'ordinary', descriptor: 'I', accessFlags: ACC_PUBLIC },
    ],
  }));
  assert.equal(fieldByName(image, 'instanceValue').constantValue.value, 9);
  assert.equal(fieldByName(image, 'instanceValue').constantValue.runtimeInitialized, false);
  assert.deepEqual(fieldByName(image, 'ordinary'), { accessFlags: ACC_PUBLIC, name: 'ordinary', descriptor: 'I' });
});

function rejects(fields, code) {
  assert.throws(() => parseJvm(buildConstantValueClass({ fields })), (error) => (
    error instanceof TypeError && error.message === code
  ));
}

test('#7409 rejects malformed, duplicated, and descriptor-incompatible ConstantValue attributes', () => {
  rejects([{ name: 'badLength', descriptor: 'I', constant: { tag: 3, value: 1 }, attributes: [{ length: 1 }] }], 'jvm-invalid-constant-value-attribute-length');
  rejects([{ name: 'badLength', descriptor: 'I', constant: { tag: 3, value: 1 }, attributes: [{ length: 3 }] }], 'jvm-invalid-constant-value-attribute-length');
  rejects([{ name: 'badIndex', descriptor: 'I', attributes: [{ index: 0 }] }], 'jvm-invalid-constant-value-index');
  rejects([{ name: 'badIndex', descriptor: 'I', attributes: [{ index: 0xffff }] }], 'jvm-invalid-constant-value-index');
  rejects([{ name: 'wrongTag', descriptor: 'J', constant: { tag: 3, value: 1 } }], 'jvm-invalid-constant-value-index');
  rejects([{ name: 'wrongDescriptor', descriptor: 'Ljava/lang/Object;', constant: { tag: 3, value: 1 } }], 'jvm-invalid-constant-value-descriptor');
  rejects([{ name: 'duplicate', descriptor: 'I', constant: { tag: 3, value: 1 }, attributes: [{}, {}] }], 'jvm-duplicate-constant-value-attribute');
});

console.log('  ok JVM ConstantValue #7409 tests passed');
