import { buildSemanticModel } from '../../../js/blocks.js';
import { buildIR } from '../../../js/ir.js';
import { OP, MK } from '../../../js/ir-base.js';
export const identity = Object.freeze({
  queryId: 'main-route', snapshotId: 'snapshot-1', binaryId: 'binary-1',
  functionId: 'function-1', architecture: 'generic', addressSpace: 'data', semanticsVersion: '2',
});

export function partialStoreFixture() {
  const word = { id: 'word', bits: 32, const: 0x11223344n };
  const byte = { id: 'byte', bits: 8, const: 0xaan };
  const loaded = { id: 'loaded', bits: 32 };
  const loc = (address, size) => ({ kind: MK.GLOBAL, key: `global:${address}`, address, size });
  const instructions = [
    { id: 'store-word', op: OP.STORE, loc: loc(0x100n, 4), args: [{ value: word }] },
    { id: 'store-byte', op: OP.STORE, loc: loc(0x101n, 1), args: [{ value: byte }] },
    { id: 'load', op: OP.LOAD, loc: loc(0x100n, 4), args: [], dst: loaded },
    { id: 'ret', op: OP.RET, args: [{ value: loaded }] },
  ];
  instructions.forEach((inst, row) => Object.assign(inst, { row, address: BigInt(row * 4) }));
  loaded.def = instructions[2];
  return { entry: 0, blocks: [{ index: 0, insts: instructions, succ: [] }], instructions };
}


export function machineIR(lines) {
  const rows=lines.map((s,row)=>{const k=s.indexOf(' ');return {row,address:0x1000n+BigInt(row*4),mn:k<0?s:s.slice(0,k),ops:k<0?'':s.slice(k+1)};});
  const rowOfAddress=a=>Number((a-0x1000n)/4n);
  return buildIR(buildSemanticModel(rows,{startRow:0,endRow:lines.length-1,rowOfAddress}),{rowOfAddress});
}
