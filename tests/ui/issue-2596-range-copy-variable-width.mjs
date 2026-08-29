import assert from 'node:assert/strict';
import { buildText } from '../../js/rangecopy.js';

const region = { id:'text', vmAddr:0x1000n, fileOffset:0x400n, size:0x100n, disasm:true, capability:{ architecture:'x86_64', fixedInstructionSize:null, capabilities:{ decode:'exact' } } };
const rows = [
  { row:0, address:0x1000n, bytes:'55', mnemonic:'push', operands:'rbp', length:1 },
  { row:1, address:0x1001n, bytes:'48 89 E5', mnemonic:'mov', operands:'rbp, rsp', length:3 },
  { row:2, address:0x1004n, bytes:'48 83 EC 20', mnemonic:'sub', operands:'rsp, 0x20', length:4 },
  { row:3, address:0x1008n, bytes:'E8 11 22 33 44', mnemonic:'call', operands:'0x4433321e', length:5 },
];
let fetches=0;
const values=new Map([['currentRegion',region],['hexJoined',false],['canDisassemble',true]]);
const app={
  store:{ get:(key)=>values.get(key) },
  backend:{ platformInfo:{ capability:region.capability }, async fetchChunk(){fetches++;throw new Error('variable-width copy must not use fixed chunk grid');} },
  viewer:{ isVariableAsm:()=>true, architectureId:()=> 'x86_64', rowData:(row)=>rows[row]||null },
  symbols:{ gen:0, nameAt:()=>null }, setBusy(){},
};
const sel={ start:1,end:3,count:3,startAddress:0x1001n,endAddress:0x1008n,endLength:5,endExclusive:0x100dn };
const all=await buildText(app,region,sel,'all',true), lines=all.split('\n');
assert.equal(lines.length,3);
assert.match(lines[0],/1001/i); assert.match(lines[0],/48 89 E5/i); assert.match(lines[0],/mov rbp, rsp/i);
assert.match(lines[1],/1004/i); assert.match(lines[1],/48 83 EC 20/i); assert.match(lines[1],/sub rsp, 0x20/i);
assert.match(lines[2],/1008/i); assert.match(lines[2],/E8 11 22 33 44/i); assert.match(lines[2],/call 0x4433321e/i);
assert.equal(fetches,0);
const explained=await buildText(app,region,{start:1,end:1,count:1},'explained',true);
assert.match(explained,/mov\s+rbp, rsp/i); assert.doesNotMatch(explained,/;/);
values.set('hexJoined',true);
assert.equal(await buildText(app,region,{start:1,end:1,count:1},'hex',false),'4889E5');
values.set('currentRegion',{...region,id:'other'});
await assert.rejects(()=>buildText(app,region,{start:1,end:1,count:1},'all',true),/.+/);
console.log('issue-2596 variable-width range-copy regression passed');
