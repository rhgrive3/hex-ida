import assert from 'node:assert/strict';
import { parseJvm } from '../../../js/managed/jvm/parser.js';

console.log('[phase11] running JVM modified UTF-8 regression #3745...');

function buildClassWithUtf8(payload) {
  const bytes = [];
  const u1 = (value) => bytes.push(value & 0xff);
  const u2 = (value) => bytes.push((value >>> 8) & 0xff, value & 0xff);
  const u4 = (value) => bytes.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
  const utf8 = (value) => {
    const encoded = new TextEncoder().encode(value);
    u1(1); u2(encoded.length); bytes.push(...encoded);
  };

  u4(0xcafebabe); u2(0); u2(52);
  u2(6);
  utf8('A');
  u1(7); u2(1);
  utf8('java/lang/Object');
  u1(7); u2(3);
  u1(1); u2(payload.length); bytes.push(...payload);
  u2(0x0021); u2(2); u2(4);
  u2(0); // interfaces_count
  u2(0); // fields_count
  u2(0); // methods_count
  u2(0); // attributes_count
  return Uint8Array.from(bytes);
}

function decode(payload) {
  return parseJvm(buildClassWithUtf8(payload), { binaryId: 'issue-3745' }).constantPool[5].value;
}

assert.equal(decode([0x68, 0x65, 0x6c, 0x6c, 0x6f]), 'hello');
assert.equal(decode([0xc0, 0x80]), '\0');
assert.equal(decode([0xc2, 0xa2]), '¢');
assert.equal(decode([0xe3, 0x81, 0x82]), 'あ');
assert.equal(decode([0xed, 0xa0, 0xbd, 0xed, 0xb8, 0x80]), '😀');

for (const payload of [
  [0x00],
  [0xc2, 0x41],
  [0xc2],
  [0xe3, 0x81],
  [0xc1, 0x81],
  [0xe0, 0x81, 0x81],
  [0xf0, 0x9f, 0x98, 0x80],
]) {
  assert.throws(() => decode(payload), /jvm-invalid-modified-utf8/);
}

console.log('  ok JVM modified UTF-8 regression #3745 passed');
