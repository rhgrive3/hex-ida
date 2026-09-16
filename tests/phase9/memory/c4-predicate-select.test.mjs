import test from 'node:test';
import assert from 'node:assert/strict';
import { OP } from '../../../js/ir-base.js';
import { createBv, createBool, evaluateExpr } from '../../../js/symbolic/expr/index.js';
import { lowerScalarInstruction, scalarOperationSupported } from '../../../js/symbolic/translate/scalar.js';
import { symbolicExecute } from '../../../js/symbolic/index.js';
import { identity, machineIR } from './main-fixtures.mjs';

test('C4 equal-bool preserves the BV1 carrier over its complete truth table', () => {
  const inst = { op:OP.BIN, sub:'eq', dst:{bits:1}, args:[{value:{bits:1}},{value:{bits:1}}] };
  assert.equal(scalarOperationSupported(inst), true);
  for (const a of [0n,1n]) for (const b of [0n,1n]) {
    const result = lowerScalarInstruction(inst, [createBv(1,a),createBv(1,b)], 1);
    assert.deepEqual(result.sort, createBv(1,0n).sort);
    assert.equal(evaluateExpr(result).value, a === b ? 1n : 0n);
  }
  for (const width of [2,8,32,64]) {
    assert.equal(lowerScalarInstruction(inst,[createBv(width,0n),createBv(width,0n)],1).reason,
      'boolean-equality-contract');
    assert.equal(lowerScalarInstruction(inst,[createBv(1,0n),createBv(1,0n)],width).reason,
      'boolean-equality-contract');
    assert.equal(scalarOperationSupported({...inst,dst:{bits:width}}),false);
  }
});

test('C4 select accepts Bool and BV1 conditions but never wider integer truthiness', () => {
  const inst = {op:OP.SEL};
  const args = [createBv(8,7n),createBv(8,9n)];
  for (const yes of [false,true]) for (const condition of [createBool(yes),createBv(1,yes ? 1n : 0n)]) {
    assert.equal(evaluateExpr(lowerScalarInstruction(inst,args,8,condition)).value,yes ? 7n : 9n);
  }
  for (const width of [2,8,32,64]) {
    assert.equal(lowerScalarInstruction(inst,args,8,createBv(width,1n)).reason,
      'memory-select-needs-canonical-condition');
  }
});

test('C4 byte execution consumes the explicit BV1 SSA condition and rejects extra operands', () => {
  for (const bit of [0n,1n]) {
    const condition = {id:'condition',bits:1,const:bit};
    const output = {id:'selected',bits:8};
    const select = {op:OP.SEL,dst:output,conditionValue:condition,
      args:[{value:{id:'yes',bits:8,const:7n}},{value:{id:'no',bits:8,const:9n}}]};
    output.def = select;
    const ret = {op:OP.RET,args:[{value:output}]};
    const ir = {entry:0,instructions:[select,ret],blocks:[{index:0,insts:[select,ret],succ:[]}]};
    const run = () => symbolicExecute(ir,{byteMemory:{identity,addressBits:8}});
    const result = run();
    assert.equal(result.status,'complete',result.reason);
    assert.equal(result.paths[0].returnValue.value,bit ? 7n : 9n);
    select.args.push({value:{id:'unproved-display',bits:1,const:0n}});
    assert.equal(run().status,'partial');
  }
});

test('C4 native csel keeps its authenticated display carrier separate from data selection', () => {
  const ir = machineIR(['cmp x0, x1', 'csel x2, x3, x4, lt', 'ret']);
  const selected = ir.values.find(value => value.reg === 'x2');
  const ret = ir.instructions.at(-1);
  ret.args = [{value:selected}];
  for (const [x0, x1, expected] of [[1n,2n,3n],[2n,1n,4n],[1n,1n,4n]]) {
    const result = symbolicExecute(ir, {byteMemory:{identity:{...identity,addressSpace:'memory'},addressBits:64},
      symbolicArgs:{x0,x1,x3:3n,x4:4n,x30:4096n}});
    assert.equal(result.status,'complete',`${x0}/${x1}: ${result.reason}`);
    assert.equal(result.paths[0].returnValue.value,expected);
  }
  const select = ir.instructions.find(instruction => instruction.op === OP.SEL);
  assert.equal(select.args.length,3);
  select.args[2] = {value:{id:'forged-carrier',bits:1,const:0n}};
  const forged = symbolicExecute(ir, {byteMemory:{identity:{...identity,addressSpace:'memory'},addressBits:64},
    symbolicArgs:{x0:1n,x1:2n,x3:3n,x4:4n,x30:4096n}});
  assert.equal(forged.status,'partial');
  assert.deepEqual(forged.paths,[]);
  const carrier = ir.instructions.find(instruction => instruction.extra?.semanticComparisonCarrier);
  for (const mutate of [
    instruction => { instruction.extra.completeness = 'partial'; },
    instruction => { instruction.extra.semanticNodeId = 'forged-source'; },
    instruction => { instruction.dst.machineType = {kind:'integer',widthBits:1}; },
  ]) {
    const clean = carrier.extra.completeness;
    const source = carrier.extra.semanticNodeId;
    const machineType = carrier.dst.machineType;
    mutate(carrier);
    const rejected = symbolicExecute(ir, {byteMemory:{identity:{...identity,addressSpace:'memory'},addressBits:64},
      symbolicArgs:{x0:1n,x1:2n,x3:3n,x4:4n,x30:4096n}});
    assert.equal(rejected.status,'partial');
    carrier.extra.completeness = clean;
    carrier.extra.semanticNodeId = source;
    carrier.dst.machineType = machineType;
  }
});
