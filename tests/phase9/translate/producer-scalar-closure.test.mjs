import test from 'node:test';
import assert from 'node:assert/strict';
import { OP } from '../../../js/ir-base.js';
import { translateSemanticIR } from '../../../js/symbolic/translate/semantic-ir.js';
import { evaluateExpr } from '../../../js/symbolic/expr/index.js';
import { translateMemoryScalar } from '../../../js/symbolic/translate/memory.js';
import { createBv } from '../../../js/symbolic/expr/index.js';
import { classifyOpSupport } from '../../../js/symbolic/translate/support-matrix.js';
const literal = (id, bits, n) => ({ id, bits, const: BigInt(n) });
const instruction = (op, fields, values, bits) => {
  const dst = { id: 'result', bits };
  const inst = { id: 'operation', op, ...fields, args: values.map(value => ({ value })), dst };
  dst.def = inst;
  return inst;
};
const translated = inst => translateSemanticIR(inst);
const value = inst => { const r = translated(inst); assert.equal(r.status, 'exact', JSON.stringify(r.unsupportedEntities)); return evaluateExpr(r.expression).value; };

test('producer sub and result bits are preserved at the raw public translator', () => {
  const inst = instruction(OP.BIN, { sub: 'xor' }, [literal('a', 8, 5), literal('b', 8, 3)], 8);
  assert.equal(value(inst), 6n);
  assert.equal(translated(inst).expression.sort.width, 8);
});
test('comparison uses operand width independently of its Bool result and extra signedness', () => {
  const inst = instruction(OP.CMP, { cond: 'lt', extra: { signed: true } }, [literal('a', 8, 255), literal('b', 8, 0)], 1);
  assert.equal(value(inst), true);
});
test('casts retain source width and literal producer payload', () => {
  const source = literal('a', 8, 128);
  assert.equal(value(instruction(OP.MOV, { sub: 'sext' }, [source], 32)), 0xffffff80n);
  assert.equal(value(instruction(OP.UN, { sub: 'zext' }, [source], 32)), 128n);
  assert.equal(value(instruction(OP.CONST, { extra: { value: 257n } }, [], 8)), 1n);
});
test('raw select consumes canonical conditionValue and does not default to true', () => {
  const cond = instruction(OP.CMP, { cond: 'eq' }, [literal('a', 8, 1), literal('b', 8, 2)], 1);
  const sel = instruction(OP.SEL, { conditionValue: cond.dst }, [literal('yes', 8, 7), literal('no', 8, 9)], 8);
  assert.equal(value(sel), 9n);
  delete sel.conditionValue;
  assert.notEqual(translated(sel).status, 'exact');
});
test('anonymous constants and numeric zero IDs do not alias in translation memoization', () => {
  assert.equal(value(instruction(OP.BIN, { subOp: 'sub' }, [{ const: 7n, bits: 8 }, { const: 2n, bits: 8 }], 8)), 5n);
  assert.equal(value(instruction(OP.BIN, { subOp: 'add' }, [literal(0, 8, 3), literal(1, 8, 2)], 8)), 5n);
});
test('missing or conflicting opcodes, widths and literal declarations fail closed', () => {
  const pair = [literal('a', 8, 1), literal('b', 8, 2)];
  for (const inst of [
    instruction(OP.BIN, {}, pair, 8),
    instruction(OP.BIN, { sub: 'xor', subOp: 'add' }, pair, 8),
    instruction(OP.BIN, { sub: 'add' }, [pair[0], literal('b', 16, 2)], 8),
    instruction(OP.CONST, {}, [], 8),
    instruction(OP.CONST, { value: 1n, extra: { value: 2n } }, [], 8),
    instruction(OP.MOV, { sub: 'sext' }, [pair[0]], 4),
    instruction(OP.UN, { sub: 'not' }, [...pair], 8),
  ]) assert.notEqual(translated(inst).status, 'exact', String(inst.sub ?? inst.op));
});
test('a stale propagated .const never overrides an actual nonconstant definition', () => {
  const arg = { id: 'a', bits: 8, kind: 'arg', reg: 'x0' };
  const inst = instruction(OP.BIN, { sub: 'xor' }, [arg, literal('b', 8, 1)], 8);
  inst.dst.const = 8n;
  const r = translateSemanticIR(inst.dst);
  assert.equal(r.status, 'exact');
  assert.equal(evaluateExpr(r.expression, { arg_x0: 3n }).value, 2n);
});
test('duplicate SSA identity with different value objects cannot become exact', () => {
  const inst = instruction(OP.BIN, { sub: 'sub' }, [literal('same', 8, 1), literal('same', 8, 2)], 8);
  assert.notEqual(translated(inst).status, 'exact');
});
test('translation checks cancel and work limits before returning an exact expression', () => {
  const inst = instruction(OP.BIN, { sub: 'xor' }, [literal('a', 8, 1), literal('b', 8, 2)], 8);
  const signal = AbortSignal.abort();
  assert.notEqual(translateSemanticIR(inst, { signal }).status, 'exact');
  assert.notEqual(translateSemanticIR(inst, { maxWorkItems: 0 }).status, 'exact');
});
test('raw and executed lowering share machine division policy', () => {
  const policy = { bundleCompleteness: 'exact', operationMetadata: { divisionByZero: 'returns-zero', signedOverflow: 'not-applicable', widthBits: 32 } };
  const inst = instruction(OP.BIN, { sub: 'udiv', extra: { completeness: 'complete', attributes: { machineEffects: policy } } }, [literal('a', 32, 4), literal('b', 32, 0)], 32);
  assert.equal(value(inst), 0n);
  assert.equal(evaluateExpr(translateMemoryScalar(inst, [createBv(32, 4n), createBv(32, 0n)], 32)).value, 0n);
});

function bitfieldInstruction(mode, bits, lsb, width, source, prior = 0n, sourceBits = bits) {
  const insert = ['bfi','bfxil'].includes(mode);
  return instruction(insert ? OP.BFI : OP.BFX, { sub:insert ? 'insert' : 'extract',
    extra:{ lsb,width,...(insert ? {bitfieldKind:mode} : {
      toward:mode.startsWith('insert-zero') ? 'left' : 'right',signed:mode.endsWith('-signed'),
    }) } }, insert ? [literal('prior',bits,prior),literal('source',sourceBits,source)] : [literal('source',sourceBits,source)], bits);
}
function expectedBitfield(mode, bits, lsb, width, source, prior = 0n) {
  const fieldMask=(1n<<BigInt(width))-1n,offset=BigInt(lsb);
  if(mode==='bfi')return BigInt.asUintN(bits,(prior&~(fieldMask<<offset))|((source&fieldMask)<<offset));
  if(mode==='bfxil')return BigInt.asUintN(bits,(prior&~fieldMask)|((source>>offset)&fieldMask));
  const left=mode.startsWith('insert-zero');
  const field=left ? (source&fieldMask)<<offset : (source>>offset)&fieldMask;
  return BigInt.asUintN(bits,mode.endsWith('-signed') ? BigInt.asIntN(left ? width+lsb : width,field) : field);
}
function checkBitfield(inst, expected) {
  assert.equal(classifyOpSupport(inst.op,inst),'exact');
  const raw=translated(inst);
  assert.equal(raw.status,'exact',JSON.stringify({op:inst.op,extra:inst.extra,unsupported:raw.unsupportedEntities}));
  assert.equal(raw.expression.sort.width,inst.dst.bits);
  assert.equal(evaluateExpr(raw.expression).value,expected);
  const args=inst.args.map(arg=>createBv(arg.value.bits,arg.value.const));
  const executed=translateMemoryScalar(inst,args,inst.dst.bits);
  assert.equal(executed.sort.width,inst.dst.bits);
  assert.equal(evaluateExpr(executed).value,expected);
}

test('C4-04 canonical bitfield variants agree across raw and executed width boundaries', t => {
  let cells=0;
  const modes=['extract-unsigned','extract-signed','insert-zero-unsigned','insert-zero-signed','bfi','bfxil'];
  for(const bits of [1,2,3,4,8,16,32,64]){
    const mask=(1n<<BigInt(bits))-1n,sign=1n<<BigInt(bits-1);
    const values=bits<=4 ? Array.from({length:2**bits},(_,index)=>BigInt(index)) : [0n,1n,mask,mask-1n,sign,sign-1n];
    const spans=[...new Set([[0,1],[bits-1,1],[0,bits],[Math.floor(bits/3),Math.max(1,Math.floor(bits/2))]].map(pair=>pair.join(':')))]
      .map(pair=>pair.split(':').map(Number));
    for(const mode of modes)for(const [lsb,width] of spans)for(const source of values){
      for(const prior of ['bfi','bfxil'].includes(mode) ? values : [0n]){
        checkBitfield(bitfieldInstruction(mode,bits,lsb,width,source,prior),expectedBitfield(mode,bits,lsb,width,source,prior));
        cells++;
      }
    }
  }
  assert.equal(cells,4640);
  t.diagnostic(JSON.stringify({schema:'c4-04-bitfield-raw-executed-v1',cells,comparisons:cells*2,widths:[1,2,3,4,8,16,32,64],variants:6}));
});

test('C4-04 bitfields preserve distinct source, field and destination widths and consistent producer aliases', () => {
  for(const [mode,bits,sourceBits,lsb,width] of [
    ['extract-unsigned',8,32,24,8],['extract-signed',32,8,4,4],
    ['extract-signed',16,64,48,16],['insert-zero-signed',32,8,16,8],
    ['bfi',32,8,16,8],['bfi',8,32,2,4],['bfxil',16,64,48,16],
  ]){
    const source=(1n<<BigInt(sourceBits))-1n,prior=0x55n;
    checkBitfield(bitfieldInstruction(mode,bits,lsb,width,source,prior,sourceBits),expectedBitfield(mode,bits,lsb,width,source,prior));
  }
  for(const [mode,alias] of [['extract-unsigned','ubfx'],['extract-signed','sbfx'],
    ['insert-zero-unsigned','ubfiz'],['insert-zero-signed','sbfiz'],['bfi','bfi'],['bfxil','bfxil']]){
    for(const sub of [undefined,alias]){
      const inst=bitfieldInstruction(mode,8,2,4,0xffn,0xa5n);inst.sub=sub;
      checkBitfield(inst,expectedBitfield(mode,8,2,4,0xffn,0xa5n));
    }
  }
});

test('C4-04 bitfield metadata, arity, widths and contradictory variants never become exact', () => {
  const cases=[
    ['extract-unsigned',inst=>{delete inst.extra.width;}],
    ['extract-unsigned',inst=>{inst.extra.width=0;}],
    ['extract-unsigned',inst=>{inst.extra.width=9;}],
    ['extract-unsigned',inst=>{inst.extra.lsb=-1;}],
    ['extract-unsigned',inst=>{inst.extra.lsb='2';}],
    ['extract-unsigned',inst=>{inst.extra.lsb=8;}],
    ['extract-unsigned',inst=>{inst.extra.signed='false';}],
    ['extract-unsigned',inst=>{inst.extra.toward='diagonal';}],
    ['extract-unsigned',inst=>{inst.subOp='insert';}],
    ['extract-unsigned',inst=>{inst.args=[];}],
    ['extract-unsigned',inst=>{inst.args.push({value:literal('extra',8,1)});}],
    ['extract-unsigned',inst=>{inst.dst.bits=2;}],
    ['extract-unsigned',inst=>{inst.extra.bitfieldKind='bfxil';}],
    ['extract-unsigned',inst=>{inst.sub='sbfx';}],
    ['extract-unsigned',inst=>{inst.sub='ubfiz';}],
    ['bfi',inst=>{inst.extra.bitfieldKind='unknown';}],
    ['bfi',inst=>{inst.extra.toward='left';}],
    ['bfi',inst=>{inst.sub='bfxil';}],
    ['bfi',inst=>{inst.args.pop();}],
    ['bfi',inst=>{inst.args[0].value.bits=4;}],
    ['bfi',inst=>{inst.args[1].value.bits=2;}],
    ['bfi',inst=>{inst.extra.lsb=6;}],
    ['bfxil',inst=>{inst.extra.lsb=6;}],
  ];
  for(const [mode,configure] of cases){
    const inst=bitfieldInstruction(mode,8,2,4,0xffn,0xa5n);configure(inst);
    assert.equal(classifyOpSupport(inst.op,inst),'unsupported',mode);
    assert.notEqual(translated(inst).status,'exact',mode);
    const executed=translateMemoryScalar(inst,inst.args.map(arg=>createBv(arg.value.bits,arg.value.const)),inst.dst.bits);
    assert.equal(executed.kind,'unknown_semantic',mode);
  }
});

test('C4-04 bitfield classifier requires a matching complete integer descriptor',()=>{
  for(const op of [OP.BFX,OP.BFI])assert.equal(classifyOpSupport(op),'unsupported');
  for(const mode of ['extract-unsigned','bfi']){
    for(const configure of [inst=>{delete inst.args[0];},inst=>{inst.extra.bitfieldKind={};},
      inst=>{inst.extra.float=true;},inst=>{inst.dst.float=true;},inst=>{inst.args[0].value.bits=0;}]){
      const inst=bitfieldInstruction(mode,8,2,4,0xffn,0xa5n);configure(inst);
      assert.equal(classifyOpSupport(inst.op,inst),'unsupported',mode);
    }
    const inst=bitfieldInstruction(mode,8,2,4,0xffn,0xa5n);
    assert.equal(classifyOpSupport(inst.op===OP.BFX?OP.BFI:OP.BFX,inst),'unsupported');
  }
});
