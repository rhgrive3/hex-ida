import assert from 'node:assert/strict';
import { parseJvm } from '../../../js/managed/jvm/parser.js';

const u2 = (out, value) => out.push((value >>> 8) & 255, value & 255);
const u4 = (out, value) => out.push((value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255);
const utf8 = (text) => {
  const bytes = [...Buffer.from(text, 'utf8')];
  const out = [1];
  u2(out, bytes.length);
  out.push(...bytes);
  return out;
};
const cpClass = (nameIndex) => [7, (nameIndex >>> 8) & 255, nameIndex & 255];
const cpNameAndType = (nameIndex, descriptorIndex) => [
  12,
  (nameIndex >>> 8) & 255, nameIndex & 255,
  (descriptorIndex >>> 8) & 255, descriptorIndex & 255,
];
const cpMemberRef = (tag, classIndex, nameAndTypeIndex) => [
  tag,
  (classIndex >>> 8) & 255, classIndex & 255,
  (nameAndTypeIndex >>> 8) & 255, nameAndTypeIndex & 255,
];

function buildMemberRef(tag, name, descriptor) {
  const entries = [
    utf8('A'), cpClass(1),
    utf8('java/lang/Object'), cpClass(3),
    utf8(name), utf8(descriptor), cpNameAndType(5, 6), cpMemberRef(tag, 2, 7),
  ];
  const out = [];
  u4(out, 0xcafebabe);
  u2(out, 0);
  u2(out, 61);
  u2(out, entries.length + 1);
  for (const entry of entries) out.push(...entry);
  u2(out, 0x0021);
  u2(out, 2);
  u2(out, 4);
  u2(out, 0);
  u2(out, 0);
  u2(out, 0);
  u2(out, 0);
  return Uint8Array.from(out);
}

console.log('[phase11] running JVM CP member-name regression #7615...');

assert.doesNotThrow(() => parseJvm(buildMemberRef(9, 'x', 'I')));
assert.doesNotThrow(() => parseJvm(buildMemberRef(9, '<x>', 'I')));
for (const name of ['', 'a/b', 'a.b', 'a;b', 'a[b']) {
  assert.throws(
    () => parseJvm(buildMemberRef(9, name, 'I')),
    /jvm-invalid-cp-memberref-name/,
    `Fieldref name ${JSON.stringify(name)} must be rejected`,
  );
}

for (const tag of [10, 11]) {
  assert.doesNotThrow(() => parseJvm(buildMemberRef(tag, 'm', '()V')));
  for (const name of ['', 'a/b', 'a.b', 'a;b', 'a[b', 'a<b>', '<other>']) {
    assert.throws(
      () => parseJvm(buildMemberRef(tag, name, '()V')),
      /jvm-invalid-cp-memberref-name/,
      `method memberref tag ${tag} name ${JSON.stringify(name)} must be rejected`,
    );
  }
}

assert.doesNotThrow(() => parseJvm(buildMemberRef(10, '<init>', '()V')));
assert.throws(
  () => parseJvm(buildMemberRef(10, '<clinit>', '()V')),
  /jvm-invalid-cp-memberref-name/,
);
for (const name of ['<init>', '<clinit>']) {
  assert.throws(
    () => parseJvm(buildMemberRef(11, name, '()V')),
    /jvm-invalid-cp-memberref-name/,
    `InterfaceMethodref ${name} must be rejected`,
  );
}

console.log('  ok JVM CP member-name regression #7615 passed');
