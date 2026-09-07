import assert from 'node:assert/strict';
import { parseJvm } from '../../../js/managed/jvm/parser.js';

console.log('[phase11] running JVM Code attribute boundary #3732 tests...');

function buildClass({ firstCodeInfo, secondMethod = false } = {}) {
  const bytes=[];
  const u1=x=>bytes.push(x&0xff);
  const u2=x=>{u1(x>>>8);u1(x);};
  const u4=x=>{u1(x>>>24);u1(x>>>16);u1(x>>>8);u1(x);};
  const utf8=s=>{const x=new TextEncoder().encode(s);u1(1);u2(x.length);for(const b of x)u1(b);};

  u4(0xcafebabe);u2(0);u2(61);
  // #1 A, #2 Class A, #3 Object, #4 Class Object, #5 m, #6 ()V, #7 Code, #8 Nested
  u2(9);
  utf8('A');u1(7);u2(1);
  utf8('java/lang/Object');u1(7);u2(3);
  utf8('m');utf8('()V');utf8('Code');utf8('Nested');
  u2(0x0421);u2(2);u2(4);u2(0); // abstract class, no interfaces
  u2(0); // fields
  u2(secondMethod?2:1);

  u2(0x0009);u2(5);u2(6);u2(1); // public static m()V, one Code attribute
  u2(7);u4(firstCodeInfo.length);
  for(const b of firstCodeInfo)u1(b);

  if(secondMethod){
    // The first three bytes are 00 00 00 so the pre-fix parser can read them
    // outside the first Code attribute as code byte + exception_table_length=0.
    u2(0x0000);u2(5);u2(6);u2(0);
  }

  u2(0); // class attributes
  return Uint8Array.from(bytes);
}

function validCodeInfo({ nested = false, exception = false } = {}) {
  const b=[];
  const u1=x=>b.push(x&0xff);
  const u2=x=>{u1(x>>>8);u1(x);};
  const u4=x=>{u1(x>>>24);u1(x>>>16);u1(x>>>8);u1(x);};
  u2(0);u2(0);u4(1);u1(0xb1);
  if(exception){
    // one valid entry: start_pc=0 end_pc=1 handler_pc=0 catch_type=#2 (Class A)
    u2(1);u2(0);u2(1);u2(0);u2(2);
    u2(0); // no nested attributes
    return b;
  }
  u2(0); // no exceptions
  if(!nested){u2(0);return b;} // no nested attributes
  u2(1);u2(8);u4(0); // one unknown nested attr, valid Utf8 name, empty body
  return b;
}

const valid = parseJvm(buildClass({ firstCodeInfo: validCodeInfo() }));
assert.equal(valid.methods[0].code.codeLength,1);
assert.deepEqual([...valid.methods[0].code.bytecode],[0xb1]);

const validException = parseJvm(buildClass({ firstCodeInfo: validCodeInfo({ exception:true }) }));
assert.deepEqual(validException.methods[0].code.exceptionTable,[
  { startPc:0, endPc:1, handlerPc:0, catchType:'A' },
]);

const validNested = parseJvm(buildClass({ firstCodeInfo: validCodeInfo({ nested:true }) }));
assert.equal(validNested.methods[0].code.codeLength,1);

// Issue counterexample: attribute_length=8 contains only Code fixed header;
// code_length=1 forces the old parser to consume the next method_info bytes.
const truncatedHeaderOnly = [0,0, 0,0, 0,0,0,1];
assert.throws(
  () => parseJvm(buildClass({ firstCodeInfo: truncatedHeaderOnly, secondMethod:true })),
  /jvm-truncated-code-bytes/,
);

const missingNestedCount = validCodeInfo().slice(0,-2);
assert.throws(
  () => parseJvm(buildClass({ firstCodeInfo: missingNestedCount })),
  /jvm-truncated-code-attributes-count/,
);

const truncatedNested=[];
{
  const u1=x=>truncatedNested.push(x&0xff);
  const u2=x=>{u1(x>>>8);u1(x);};
  const u4=x=>{u1(x>>>24);u1(x>>>16);u1(x>>>8);u1(x);};
  u2(0);u2(0);u4(1);u1(0xb1);u2(0);
  u2(1);u2(8);u4(2);u1(0xaa); // declares 2-byte nested body, provides 1
}
assert.throws(
  () => parseJvm(buildClass({ firstCodeInfo: truncatedNested })),
  /jvm-truncated-code-attribute/,
);

const extraTail=[...validCodeInfo(),0xff];
assert.throws(
  () => parseJvm(buildClass({ firstCodeInfo: extraTail })),
  /jvm-invalid-code-attribute-length/,
);

console.log('  ok JVM Code attribute boundary #3732 tests passed');
