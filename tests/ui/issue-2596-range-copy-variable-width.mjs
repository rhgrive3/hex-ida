import assert from 'node:assert/strict';
import { buildText } from '../../js/rangecopy.js';

function variableApp({ region, rows, architecture }) {
  let fetches = 0;
  const values = new Map([['currentRegion', region], ['hexJoined', false], ['canDisassemble', true]]);
  const app = {
    store:{ get:(key) => values.get(key) },
    backend:{
      platformInfo:{ capability:region.capability },
      async fetchChunk() { fetches++; throw new Error('variable-width copy must not use fixed chunk grid'); },
    },
    viewer:{ isVariableAsm:() => true, architectureId:() => architecture, rowData:(row) => rows[row] || null },
    symbols:{ gen:0, nameAt:() => null },
    setBusy() {},
  };
  return { app, values, fetches:() => fetches };
}

const x86Region = { id:'x86-text', vmAddr:0x1000n, fileOffset:0x400n, size:0x100n, disasm:true,
  capability:{ architecture:'x86_64', fixedInstructionSize:null, capabilities:{ decode:'exact' } } };
const x86Rows = [
  { row:0, address:0x1000n, bytes:'55', mnemonic:'push', operands:'rbp', length:1 },
  { row:1, address:0x1001n, bytes:'48 89 E5', mnemonic:'mov', operands:'rbp, rsp', length:3 },
  { row:2, address:0x1004n, bytes:'48 83 EC 20', mnemonic:'sub', operands:'rsp, 0x20', length:4 },
  { row:3, address:0x1008n, bytes:'E8 11 22 33 44', mnemonic:'call', operands:'0x4433321e', length:5 },
];
const x86 = variableApp({ region:x86Region, rows:x86Rows, architecture:'x86_64' });
const x86Sel = { start:1, end:3, count:3, startAddress:0x1001n, endAddress:0x1008n, endLength:5, endExclusive:0x100dn };
const x86All = await buildText(x86.app, x86Region, x86Sel, 'all', true);
const x86Lines = x86All.split('\n');
assert.equal(x86Lines.length, 3);
assert.match(x86Lines[0], /1001/i); assert.match(x86Lines[0], /48 89 E5/i); assert.match(x86Lines[0], /mov rbp, rsp/i);
assert.match(x86Lines[1], /1004/i); assert.match(x86Lines[1], /48 83 EC 20/i); assert.match(x86Lines[1], /sub rsp, 0x20/i);
assert.match(x86Lines[2], /1008/i); assert.match(x86Lines[2], /E8 11 22 33 44/i); assert.match(x86Lines[2], /call 0x4433321e/i);
assert.equal(x86.fetches(), 0);
const x86Explained = await buildText(x86.app, x86Region, { start:1, end:1, count:1 }, 'explained', true);
assert.match(x86Explained, /mov\s+rbp, rsp/i);
assert.doesNotMatch(x86Explained, /;/, 'x86 must not receive fabricated ARM64 explanation');
x86.values.set('hexJoined', true);
assert.equal(await buildText(x86.app, x86Region, { start:1, end:1, count:1 }, 'hex', false), '4889E5');
x86.values.set('currentRegion', { ...x86Region, id:'other' });
await assert.rejects(() => buildText(x86.app, x86Region, { start:1, end:1, count:1 }, 'all', true), /.+/);

const rvRegion = { id:'rv-text', vmAddr:0x2000n, fileOffset:0x800n, size:0x100n, disasm:true,
  capability:{ architecture:'rv64imc', fixedInstructionSize:null, capabilities:{ decode:'exact' } } };
const rvRows = [
  { row:0, address:0x2000n, bytes:'01 00', mnemonic:'c.nop', operands:'', length:2 },
  { row:1, address:0x2002n, bytes:'13 05 15 00', mnemonic:'addi', operands:'a0, a0, 1', length:4 },
  { row:2, address:0x2006n, bytes:'01 A0', mnemonic:'c.j', operands:'0x2006', length:2 },
];
const rv = variableApp({ region:rvRegion, rows:rvRows, architecture:'rv64imc' });
const rvAll = await buildText(rv.app, rvRegion, { start:0, end:2, count:3 }, 'all', true);
const rvLines = rvAll.split('\n');
assert.match(rvLines[0], /2000/i); assert.match(rvLines[0], /01 00/i); assert.match(rvLines[0], /c\.nop/i);
assert.match(rvLines[1], /2002/i); assert.match(rvLines[1], /13 05 15 00/i); assert.match(rvLines[1], /addi a0, a0, 1/i);
assert.match(rvLines[2], /2006/i); assert.match(rvLines[2], /01 A0/i); assert.match(rvLines[2], /c\.j 0x2006/i);
assert.equal(rv.fetches(), 0);
assert.doesNotMatch(await buildText(rv.app, rvRegion, { start:1, end:1, count:1 }, 'explained', true), /;/,
  'RV64 must not receive fabricated ARM64 explanation');

const armRegion = { id:'arm-text', vmAddr:0x3000n, fileOffset:0xC00n, size:8n, disasm:true,
  capability:{ architecture:'arm64', fixedInstructionSize:4, capabilities:{ decode:'exact' } } };
let armFetches = 0;
const armValues = new Map([['currentRegion', armRegion], ['hexJoined', false], ['canDisassemble', true]]);
const armApp = {
  store:{ get:(key) => armValues.get(key) },
  backend:{
    platformInfo:{ capability:armRegion.capability },
    async fetchChunk() {
      armFetches++;
      return {
        bytes:new Uint8Array([0x1f,0x20,0x03,0xd5, 0xc0,0x03,0x5f,0xd6]),
        mn:['nop','ret'], ops:['',''],
      };
    },
  },
  viewer:{ isVariableAsm:() => false, architectureId:() => 'arm64', fixedInstructionSize:() => 4,
    rowAddress:(row) => armRegion.vmAddr + BigInt(row) * 4n },
  symbols:{ gen:0, nameAt:() => null }, setBusy() {},
};
const armAll = await buildText(armApp, armRegion, { start:0, end:1, count:2 }, 'all', true);
assert.match(armAll, /3000/i); assert.match(armAll, /1F 20 03 D5/i); assert.match(armAll, /nop/i);
assert.match(armAll, /3004/i); assert.match(armAll, /C0 03 5F D6/i); assert.match(armAll, /ret/i);
assert.equal(armFetches, 1, 'ARM64 fixed-width path must retain chunked bulk fetch');

console.log('issue-2596 variable-width range-copy regression passed');
