import assert from 'node:assert/strict';
import { scanStrings } from '../../js/binary/strings.js';
import { scanSourceStrings } from '../../js/bytesource/strings.js';

function makeImage(bytes) {
  return {
    bytes,
    endian:'little',
    sections:[{
      name:'.rodata',
      fileOffset:0n,
      fileSize:BigInt(bytes.length),
      perms:{ execute:false },
    }],
    segments:[],
    offsetToAddress(offset) { return 0x1000n + offset; },
  };
}

function asciiFixture() {
  return new TextEncoder().encode('AAAA\0BBBB\0CCCC\0');
}

async function assertResidentSourceCount(bytes, options, expected) {
  const image=makeImage(bytes);
  const resident=scanStrings(image,options);
  const streamed=(await scanSourceStrings(image,bytes,options)).results;
  assert.equal(resident.length,expected,`resident count for limit ${String(options.limit)}`);
  assert.equal(streamed.length,expected,`source count for limit ${String(options.limit)}`);
  return { resident, streamed };
}

{
  const bytes=asciiFixture();
  const one=await assertResidentSourceCount(bytes,{ minLength:4, utf16:false, limit:1 },1);
  assert.deepEqual(one.resident.map((item)=>item.text),['AAAA']);
  assert.deepEqual(one.streamed.map((item)=>item.text),['AAAA']);

  const two=await assertResidentSourceCount(bytes,{ minLength:4, utf16:false, limit:2 },2);
  assert.deepEqual(two.resident.map((item)=>item.text),['AAAA','BBBB']);
  assert.deepEqual(two.streamed.map((item)=>item.text),['AAAA','BBBB']);
}

for (const { limit, expected } of [
  { limit:0, expected:1 },
  { limit:-7, expected:1 },
  { limit:1.9, expected:1 },
  { limit:Number.NaN, expected:3 },
  { limit:Number.POSITIVE_INFINITY, expected:3 },
  { limit:'1', expected:3 },
]) {
  await assertResidentSourceCount(asciiFixture(),{ minLength:4, utf16:false, limit },expected);
}

{
  const bytes=Uint8Array.from([
    0x41,0x41,0x41,0x41,0x00,0x00,0x00,0x00,
    0x57,0x00,0x58,0x00,0x59,0x00,0x5a,0x00,0x00,0x00,
  ]);
  const { resident, streamed }=await assertResidentSourceCount(bytes,{ minLength:4, utf16:'le', limit:2 },2);
  assert.deepEqual(resident.map((item)=>[item.text,item.encoding]),[
    ['AAAA','utf8'],
    ['WXYZ','utf16le'],
  ]);
  assert.deepEqual(streamed.map((item)=>[item.text,item.encoding]),[
    ['AAAA','utf8'],
    ['WXYZ','utf16le'],
  ]);
}

console.log('issue-3682 resident string result limit regression: PASS');
