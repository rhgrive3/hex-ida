import assert from 'node:assert/strict';
import test from 'node:test';
import { parseELF } from '../../../js/binary/elf.js';
const PT_LOAD=1,PF_R=4;
function elf(n){const eh=64,ent=56,off=eh,data=off+ent*n,b=Buffer.alloc(data+n);b.set([127,69,76,70]);b[4]=2;b[5]=1;b[6]=1;b.writeUInt16LE(2,16);b.writeUInt16LE(62,18);b.writeUInt32LE(1,20);b.writeBigUInt64LE(BigInt(off),32);b.writeUInt16LE(eh,52);b.writeUInt16LE(ent,54);b.writeUInt16LE(n,56);for(let i=0;i<n;i++){const p=off+i*ent,v=0x400000n+BigInt(n-i-1)*0x1000n;b.writeUInt32LE(PT_LOAD,p);b.writeUInt32LE(PF_R,p+4);b.writeBigUInt64LE(BigInt(data+i),p+8);b.writeBigUInt64LE(v,p+16);b.writeBigUInt64LE(v,p+24);b.writeBigUInt64LE(1n,p+32);b.writeBigUInt64LE(1n,p+40);b.writeBigUInt64LE(1n,p+48);b[data+i]=i&255;}return b;}
test('#8665 descending disjoint PT_LOADs are accepted without quadratic topology work',()=>{const image=parseELF(elf(6000));assert.equal(image.segments.length,6000);assert.equal(image.warnings.length,0);});
