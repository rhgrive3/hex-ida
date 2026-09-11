import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCil as parseCilBase } from '../../../js/managed/cil/parser-base.js';

function catchFixture(classTokenOrFilter) {
  const bytes = new Uint8Array(0x900), view = new DataView(bytes.buffer);
  bytes.set([0x4d,0x5a]); view.setUint32(0x3c,0x80,true); bytes.set([0x50,0x45,0,0],0x80);
  view.setUint16(0x86,1,true); view.setUint16(0x94,0xe0,true);
  const opt=0x98; view.setUint16(opt,0x10b,true); view.setUint32(opt+92,16,true);
  view.setUint32(opt+96+14*8,0x2000,true); view.setUint32(opt+100+14*8,72,true);
  const section=opt+0xe0; view.setUint32(section+8,0x700,true); view.setUint32(section+12,0x2000,true);
  view.setUint32(section+16,0x700,true); view.setUint32(section+20,0x200,true);
  view.setUint32(0x200,72,true); view.setUint32(0x208,0x2100,true); view.setUint32(0x20c,0x200,true);

  const metadata=0x300; view.setUint32(metadata,0x424a5342,true); view.setUint16(metadata+4,1,true); view.setUint16(metadata+6,1,true);
  const version=new TextEncoder().encode('v4.0.30319\0\0'); view.setUint32(metadata+12,version.length,true); bytes.set(version,metadata+16);
  const flags=(metadata+16+version.length+3)&~3; view.setUint16(flags+2,1,true);
  view.setUint32(flags+4,0x80,true); view.setUint32(flags+8,0x80,true); bytes.set(new TextEncoder().encode('#~\0'),flags+12);
  const tables=metadata+0x80; view.setUint32(tables+8,1<<6,true); let pos=tables+24;
  view.setUint32(pos,1,true); pos+=4; view.setUint32(pos,0x2300,true); // one MethodDef row; other columns zero

  const method=0x500; view.setUint16(method,0x300b,true); view.setUint16(method+2,8,true); view.setUint32(method+4,16,true);
  const code=method+12; bytes.fill(0,code,code+16); bytes[code+15]=0x2a;
  const extra=(code+16+3)&~3; bytes[extra]=0x41; bytes[extra+1]=28;
  const clause=extra+4; view.setUint32(clause,0,true); view.setUint32(clause+4,0,true); view.setUint32(clause+8,4,true);
  view.setUint32(clause+12,8,true); view.setUint32(clause+16,4,true); view.setUint32(clause+20,classTokenOrFilter,true);
  return bytes;
}

test('#7606 catch ClassToken cannot name a MethodDef row', () => {
  assert.throws(() => parseCilBase(catchFixture(0x06000001)), /cil-invalid-catch-token-kind/);
});
