import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyAAPCS64Arguments } from '../../../js/targets/abi/aapcs64.js';

const classify = (args) => classifyAAPCS64Arguments({ callPrototype:{ args } });

test('#2110 aggregate does not split across x7 and stack', () => {
  const six = classify([...Array.from({length:6},()=>({type:'uint64_t',bits:64})),{type:'struct Pair',aggregate:true,bits:128}]);
  assert.deepEqual(six.arguments[6].regs,['x6','x7']);
  const seven = classify([...Array.from({length:7},()=>({type:'uint64_t',bits:64})),{type:'struct Pair',aggregate:true,bits:128}]);
  assert.equal(seven.arguments[7].location,'stack');
  assert.equal(seven.arguments[7].offset,0);
  assert.equal(seven.arguments[7].bytes,16);
  assert.equal(seven.srcs.some((source)=>source.reg==='x7'), false);
  const eightByte = classify([...Array.from({length:7},()=>({type:'uint64_t',bits:64})),{type:'struct One',aggregate:true,bits:64}]);
  assert.deepEqual(eightByte.arguments[7].regs,['x7']);
});

test('#2111 FP/SIMD stack fallbacks align NSAA', () => {
  const fpExhaust = Array.from({length:8},()=>({type:'double',bits:64}));
  const vector = classify([{type:'uint64_t',bits:64}, ...fpExhaust, {abiClass:'vector',bits:128}]);
  assert.equal(vector.arguments.at(-1).alignment,16);
  const double = classify([...fpExhaust,{type:'double',bits:64}]);
  assert.equal(double.arguments.at(-1).alignment,8);
  const withStackLead = classify([
    ...Array.from({length:8},()=>({type:'uint64_t',bits:64})),
    {type:'uint64_t',bits:64},
    ...fpExhaust,
    {abiClass:'vector',bits:128},
  ]);
  assert.equal(withStackLead.arguments[8].offset,0);
  assert.equal(withStackLead.arguments.at(-1).offset,16);
});
