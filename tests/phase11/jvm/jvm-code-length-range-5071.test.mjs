import assert from 'node:assert/strict';
import { parseJvm } from '../../../js/managed/jvm/parser.js';

console.log('[phase11] running JVM Code.code_length range #5071 tests...');

function buildClass(codeLength, { emittedCodeLength = codeLength } = {}) {
  const bytes = [];
  const u1 = (x) => bytes.push(x & 0xff);
  const u2 = (x) => { u1(x >>> 8); u1(x); };
  const u4 = (x) => { u1(x >>> 24); u1(x >>> 16); u1(x >>> 8); u1(x); };
  const utf8 = (s) => {
    const encoded = new TextEncoder().encode(s);
    u1(1); u2(encoded.length);
    for (const b of encoded) u1(b);
  };

  u4(0xcafebabe); u2(0); u2(61);
  // #1 A, #2 Class A, #3 Object, #4 Class Object, #5 m, #6 ()V, #7 Code
  u2(8);
  utf8('A'); u1(7); u2(1);
  utf8('java/lang/Object'); u1(7); u2(3);
  utf8('m'); utf8('()V'); utf8('Code');
  u2(0x0021); u2(2); u2(4); u2(0); // public | super, no interfaces
  u2(0); // fields
  u2(1); // methods
  u2(0x0009); u2(5); u2(6); u2(1); // public static m()V, one Code attribute

  u2(7);
  // max_stack/max_locals/code_length + code + exception_table_length + attributes_count
  u4(12 + emittedCodeLength);
  u2(0); u2(0); u4(codeLength);
  for (let i = 0; i < emittedCodeLength; i++) {
    // A structurally valid code array at the supported upper bound: NOPs ending in return.
    u1(i === emittedCodeLength - 1 ? 0xb1 : 0x00);
  }
  u2(0); // exception_table_length
  u2(0); // attributes_count
  u2(0); // class attributes_count
  return Uint8Array.from(bytes);
}

assert.throws(
  () => parseJvm(buildClass(0)),
  /jvm-invalid-code-length/,
  'Code.code_length=0 must be rejected before metadata publication',
);

assert.throws(
  () => parseJvm(buildClass(65536)),
  /jvm-invalid-code-length/,
  'Code.code_length=65536 must be rejected even when all bytes are present',
);

for (const codeLength of [65536, 0xffffffff]) {
  assert.throws(
    () => parseJvm(buildClass(codeLength, { emittedCodeLength: 0 })),
    /jvm-invalid-code-length/,
    'invalid code_length must fail at the semantic range boundary before file bounds',
  );
}

for (const codeLength of [1, 65535]) {
  const image = parseJvm(buildClass(codeLength));
  assert.equal(image.methods[0].code.codeLength, codeLength);
  assert.equal(image.methods[0].code.bytecode.length, codeLength);
}

console.log('  ok JVM Code.code_length range #5071 tests passed');
