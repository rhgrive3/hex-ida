import assert from 'node:assert/strict';
import { parseMachO } from '../js/binary/macho.js';

function uleb(value) {
  let v = BigInt(value), out = [];
  do {
    let b = Number(v & 0x7fn); v >>= 7n;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return out;
}

function fixture(deltas, { terminator = true } = {}) {
  const bytes = new Uint8Array(0x400);
  const v = new DataView(bytes.buffer);
  const u32=(o,x)=>v.setUint32(o,x,true), i32=(o,x)=>v.setInt32(o,x,true), u64=(o,x)=>v.setBigUint64(o,BigInt(x),true);
  bytes.set([0xcf,0xfa,0xed,0xfe],0);
  i32(4,0x0100000c); i32(8,0); u32(12,2); u32(16,3); u32(20,160); u32(24,0); u32(28,0);
  function segment(off,name,address,size,fileOff,fileSize,prot) {
    u32(off,0x19); u32(off+4,72);
    bytes.set(new TextEncoder().encode(name).slice(0,16),off+8);
    u64(off+24,address); u64(off+32,size); u64(off+40,fileOff); u64(off+48,fileSize);
    i32(off+56,prot); i32(off+60,prot); u32(off+64,0); u32(off+68,0);
  }
  segment(32,'__TEXT',0x1000n,0x1000n,0n,0x200n,5);
  segment(104,'__TEXT2',0x4000n,0x1000n,0x200n,0x100n,5);
  const lc=176; u32(lc,0x26); u32(lc+4,16); u32(lc+8,0x300); 
  const stream=deltas.flatMap(uleb); if (terminator) stream.push(0);
  u32(lc+12,stream.length); bytes.set(stream,0x300);
  return bytes;
}

{
  const image=parseMachO(fixture([4n]));
  assert.equal(image.metadata.functionStarts.complete,true);
  assert.ok(image.functions.some(f=>f.source==='function_starts' && f.address===0x1004n));
}
{
  const image=parseMachO(fixture([0x2000n,0x1000n]));
  assert.equal(image.metadata.functionStarts.complete,false);
  assert.equal(image.metadata.functionStarts.partialReason,'invalid-entry');
  assert.ok(!image.functions.some(f=>f.source==='function_starts' && f.address===0x4000n), 'must not recover after corrupt cumulative state');
}
{
  const image=parseMachO(fixture([2n]));
  assert.equal(image.metadata.functionStarts.complete,false);
  assert.equal(image.metadata.functionStarts.partialReason,'invalid-entry');
}
{
  const image=parseMachO(fixture([4n],{terminator:false}));
  assert.equal(image.metadata.functionStarts.complete,false);
  assert.equal(image.metadata.functionStarts.partialReason,'missing-terminator');
}
console.log('issue #2389 function-start soundness regression: ok');
