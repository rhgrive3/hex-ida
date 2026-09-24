import assert from 'node:assert/strict';
import { parseClassicBindings } from '../js/binary/macho-dyld.js';

function reader(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const leb = (p, end) => {
    let value = 0n, shift = 0n;
    for (let count = 0; p < end && count < 10; count++, shift += 7n) {
      const b = bytes[p++]; value |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) return { value, next:p };
    }
    throw new Error('truncated uleb');
  };
  return { length:bytes.length, bytes, u8:(o)=>view.getUint8(o), u64:(o)=>view.getBigUint64(o,true), uleb:(p,_m,e)=>leb(p,e), sleb:(p,_m,e)=>leb(p,e), slice:(p,n)=>bytes.slice(p,p+n) };
}
function run(stream) {
  const bytes = Uint8Array.from(stream);
  const segment = { address:0x100000n, size:0x3000n };
  const image = { bits:64, metadata:{}, warnings:[], imports:[], libraries:['libA'], addressToOffset:(a)=>a>=segment.address&&a<segment.address+segment.size?a-segment.address:null };
  const status = parseClassicBindings(reader(bytes), { offset:0, size:bytes.length }, image, [segment], 'bind');
  return { status, image, segment };
}
const neg18 = [0xe8,0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff,0x01];
const neg20 = [0xe0,0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff,0x01];
const prefix = [0x11,0x40,0x5f,0x62,0x00,0x51];

{
  const { status, image, segment } = run([...prefix,0x70,0x98,0x20,0x80,...neg18,0x90,0x00]);
  assert.equal(status.complete, true, image.warnings.join('; '));
  assert.equal(image.imports.length, 1);
  assert.equal(image.imports[0].sites[0].address, segment.address + 0x1000n);
}
{
  const { status, image, segment } = run([...prefix,0x70,0x98,0x20,0xa0,...neg20,0x90,0x00]);
  assert.equal(status.complete, true, image.warnings.join('; '));
  assert.equal(image.imports.length, 2);
  assert.equal(image.imports[0].sites[0].address, segment.address + 0x1018n);
  assert.equal(image.imports[1].sites[0].address, segment.address + 0x1000n);
}
console.log('issue #9625 classic bind uint64 wrap: PASS');
