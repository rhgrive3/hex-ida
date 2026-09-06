import test from 'node:test';
import assert from 'node:assert/strict';
import { PdbDebugInfoProvider } from '../../../js/analysis/debug/pdb.js';
const MSF_MAGIC = 'Microsoft C/C++ MSF 7.00\r\n\u001aDS\0\0\0';
const BLOCK = 512;
const GUID = '11111111-2222-3333-4444-555555555555';
function guidBytes() { const hex=GUID.replace(/-/g,''); const out=new Uint8Array(16); for(let i=0;i<16;i++) out[i]=parseInt(hex.slice(i*2,i*2+2),16); return out; }
function msf(dbiAge) {
  const info=new Uint8Array(28), iv=new DataView(info.buffer); iv.setUint32(0,20000404,true); iv.setUint32(4,0,true); iv.setUint32(8,1,true); info.set(guidBytes(),12);
  const dbi=new Uint8Array(64), dv=new DataView(dbi.buffer); dv.setInt32(0,-1,true); dv.setUint32(4,0,true); dv.setUint32(8,dbiAge,true); dv.setUint16(20,4,true);
  const streamBlocks=[[],[3],[],[5],[]], sizes=[0,info.length,0,dbi.length,0]; const body=[sizes.length,...sizes,...streamBlocks.flat()]; const directory=new Uint8Array(body.length*4), dirv=new DataView(directory.buffer); body.forEach((v,i)=>dirv.setUint32(i*4,v,true));
  const totalBlocks=7, file=new Uint8Array(totalBlocks*BLOCK), view=new DataView(file.buffer); file.set([...MSF_MAGIC].map(ch=>ch.charCodeAt(0)&0xff),0); view.setUint32(32,BLOCK,true); view.setUint32(40,totalBlocks,true); view.setUint32(44,directory.length,true); view.setUint32(52,1,true); view.setUint32(BLOCK,2,true); file.set(directory,2*BLOCK); file.set(info,3*BLOCK); file.set(dbi,5*BLOCK); return file;
}
function image(age){ return {identity:{codeView:{guid:GUID,age:1}},pdbBytes:msf(age)}; }
test('6042 matching DBI age stays authoritative',()=>assert.equal(new PdbDebugInfoProvider().probe(image(1)).identity.verdict,'matched-authoritative'));
test('6042 foreign DBI age fails authority',()=>{const r=new PdbDebugInfoProvider().probe(image(2)); assert.equal(r.identity.verdict,'identity-mismatch'); assert.match(r.identity.detail??'',/DBI age/);});
