import assert from 'node:assert/strict';
import { parseJvm } from '../../../js/managed/jvm/parser.js';

console.log('[phase11] running JVM Code attribute cardinality tests...');

function buildClass({ methodFlags = 0x0009, codeCount = 1 } = {}) {
  const bytes = [];
  const u1 = (value) => bytes.push(value & 0xff);
  const u2 = (value) => bytes.push((value >>> 8) & 0xff, value & 0xff);
  const u4 = (value) => bytes.push(
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  );
  const utf8 = (text) => {
    u1(1);
    u2(text.length);
    for (const char of text) u1(char.charCodeAt(0));
  };
  const codeAttribute = () => {
    u2(5);       // attribute_name_index -> Code
    u4(13);      // attribute_length
    u2(0);       // max_stack
    u2(0);       // max_locals
    u4(1);       // code_length
    u1(0xb1);    // return
    u2(0);       // exception_table_length
    u2(0);       // attributes_count
  };

  u4(0xcafebabe);
  u2(0);
  u2(52);
  u2(6);
  utf8('A');     // #1
  u1(7); u2(1); // #2 Class A
  utf8('m');     // #3
  utf8('()V');   // #4
  utf8('Code');  // #5

  u2(0x0021); // class access
  u2(2);      // this_class
  u2(0);      // super_class (parser permits zero)
  u2(0);      // interfaces_count
  u2(0);      // fields_count
  u2(1);      // methods_count

  u2(methodFlags);
  u2(3);
  u2(4);
  u2(codeCount);
  for (let i = 0; i < codeCount; i++) codeAttribute();

  u2(0); // class attributes_count
  return Uint8Array.from(bytes);
}

const concrete = parseJvm(buildClass({ methodFlags: 0x0009, codeCount: 1 }));
assert.equal(concrete.methods[0].code.codeLength, 1);

assert.throws(
  () => parseJvm(buildClass({ methodFlags: 0x0009, codeCount: 0 })),
  /jvm-code-attribute-required/,
);

assert.throws(
  () => parseJvm(buildClass({ methodFlags: 0x0009, codeCount: 2 })),
  /jvm-duplicate-code-attribute/,
);

const abstractMethod = parseJvm(buildClass({ methodFlags: 0x0401, codeCount: 0 }));
assert.equal(abstractMethod.methods[0].code, null);

assert.throws(
  () => parseJvm(buildClass({ methodFlags: 0x0401, codeCount: 1 })),
  /jvm-code-attribute-forbidden/,
);

const nativeMethod = parseJvm(buildClass({ methodFlags: 0x0101, codeCount: 0 }));
assert.equal(nativeMethod.methods[0].code, null);

assert.throws(
  () => parseJvm(buildClass({ methodFlags: 0x0101, codeCount: 1 })),
  /jvm-code-attribute-forbidden/,
);

console.log('  ok JVM Code attribute cardinality tests passed');
