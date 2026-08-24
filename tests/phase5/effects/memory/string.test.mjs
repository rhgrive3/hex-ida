import test from 'node:test';
import assert from 'node:assert/strict';
import { liftX86MachineEffects } from '../../../../js/targets/architecture/x86_64/effects/index.js';
import { liftX86StringEffects } from '../../../../js/targets/architecture/x86_64/effects/string.js';
import { decoded,mem,operations,reg } from './helpers.mjs';
function stringFixture(input){
  if (input.operands?.length) return input;
  const family=String(input.family||'').toLowerCase(),kind=family.slice(0,4),suffix=family.at(-1);
  const widthBits=({b:8,w:16,d:32,q:64})[suffix],addressBits=input.addressSizeBits??64;
  if (!widthBits || !['movs','stos','lods','cmps','scas'].includes(kind)) return input;
  const source=addressBits===32?'esi':'rsi',destination=addressBits===32?'edi':'rdi',acc=({8:'al',16:'ax',32:'eax',64:'rax'})[widthBits];
  const operands=kind==='movs'?[mem({base:destination,widthBits,access:'write'}),mem({base:source,widthBits,access:'read'})]
    :kind==='stos'?[mem({base:destination,widthBits,access:'write'}),reg(acc,widthBits,'read')]
    :kind==='lods'?[reg(acc,widthBits,'write'),mem({base:source,widthBits,access:'read'})]
    :kind==='cmps'?[mem({base:source,widthBits,access:'read'}),mem({base:destination,widthBits,access:'read'})]
    :[reg(acc,widthBits,'read'),mem({base:destination,widthBits,access:'read'})];
  const implicitReads=new Set(['rflags']),implicitWrites=new Set();
  if(['movs','lods','cmps'].includes(kind)){implicitReads.add('rsi');implicitWrites.add('rsi');}
  if(['movs','stos','cmps','scas'].includes(kind)){implicitReads.add('rdi');implicitWrites.add('rdi');}
  if(kind==='stos'||kind==='scas')implicitReads.add(acc);
  if(kind==='lods')implicitWrites.add(acc);
  if(kind==='cmps'||kind==='scas')implicitWrites.add('rflags');
  if((input.prefixes||[]).some((prefix)=>prefix===0xf2||prefix===0xf3)){implicitReads.add('rcx');implicitWrites.add('rcx');}
  for(const name of input.implicitReads||[])implicitReads.add(name);
  for(const name of input.implicitWrites||[])implicitWrites.add(name);
  return{...input,operands,implicitReads:[...implicitReads],implicitWrites:[...implicitWrites]};
}
function lift(input){const instruction=decoded(stringFixture(input)),bundle=liftX86MachineEffects(instruction);assert.ok(bundle,`expected MachineEffects for ${input.family}`);return{instruction,bundle};}
const reads=(b)=>operations(b,'memory-read'),writes=(b)=>operations(b,'memory-write'),ambiguous=['rsi','rdi'];
test('MOVS single element',()=>{const{bundle}=lift({family:'movsb',length:1,bytes:[0xa4]});assert.equal(bundle.completeness,'exact');assert.equal(reads(bundle).length,1);assert.equal(writes(bundle).length,1);assert.equal(reads(bundle)[0].access.widthBits,8);assert.ok(operations(bundle,'register-write').some((op)=>op.register.registerId==='rsi'));assert.ok(operations(bundle,'register-write').some((op)=>op.register.registerId==='rdi'));});
test('STOS',()=>{const{bundle}=lift({family:'stosq',length:2,bytes:[0x48,0xab]});assert.equal(reads(bundle).length,0);assert.equal(writes(bundle).length,1);assert.equal(writes(bundle)[0].access.widthBits,64);assert.ok(operations(bundle,'register-read').some((op)=>op.metadata.view==='rax'));});
test('LODS',()=>{const{bundle}=lift({family:'lodsd',length:1,bytes:[0xad]});assert.equal(reads(bundle).length,1);assert.equal(reads(bundle)[0].access.widthBits,32);assert.ok(operations(bundle,'register-write').some((op)=>op.register.registerId==='rax'&&op.metadata.view==='eax'));});
test('CMPS',()=>{const{bundle}=lift({family:'cmpsd',length:1,bytes:[0xa7],implicitReads:ambiguous,implicitWrites:ambiguous});assert.equal(reads(bundle).length,2);assert.equal(writes(bundle).length,0);assert.ok(operations(bundle,'value').some((op)=>op.opcode==='sub'&&op.metadata.semantic==='x86-cmps'));assert.ok(operations(bundle,'flag-write').length>=6);});
test('SCAS',()=>{const{bundle}=lift({family:'scasb',length:1,bytes:[0xae]});assert.equal(reads(bundle).length,1);assert.ok(operations(bundle,'register-read').some((op)=>op.metadata.view==='al'));assert.ok(operations(bundle,'flag-write').length>=6);});
test('DF=0/1 pointer movement is explicit',()=>{const{bundle}=lift({family:'movsq',length:2,bytes:[0x48,0xa5]});assert.ok(operations(bundle,'flag-read').some((op)=>op.flag.flagId==='RFLAGS.DF'));const selects=operations(bundle,'value').filter((op)=>op.metadata.semantic==='x86-string-direction-select');assert.equal(selects.length,2);for(const op of selects){assert.equal(op.metadata.condition,'DF');assert.equal(op.metadata.falsePath,'increment');assert.equal(op.metadata.truePath,'decrement');assert.equal(op.metadata.elementBytes,8);}assert.equal(bundle.metadata.dfZeroDelta,8);assert.equal(bundle.metadata.dfOneDelta,-8);});
test('32-bit address-size pointer state',()=>{const{bundle}=lift({family:'movsb',addressSizeBits:32,prefixes:[0x67],length:2,bytes:[0x67,0xa4]});assert.equal(bundle.metadata.addressSizeBits,32);const selects=operations(bundle,'value').filter((op)=>op.metadata.semantic==='x86-string-direction-select');assert.ok(selects.every((op)=>op.outputs[0].valueType.widthBits===32));});
test('FS MOVS source remains TLS',()=>{const{bundle}=lift({family:'movsb',prefixes:[0x64],length:2,bytes:[0x64,0xa4]});assert.equal(reads(bundle)[0].access.space,'tls');assert.equal(reads(bundle)[0].metadata.segment,'fs');assert.equal(writes(bundle)[0].access.space,'memory');assert.equal(writes(bundle)[0].metadata.segment,'es');});
test('REP exact summarized effect',()=>{const{bundle}=lift({family:'movsb',prefixes:[0xf3],length:2,bytes:[0xf3,0xa4]});assert.equal(bundle.completeness,'exact-with-intrinsic');assert.equal(bundle.metadata.repeatKind,'rep');assert.equal(bundle.metadata.exactRepeatedSummary,true);assert.ok(bundle.operations.length<20);assert.equal(reads(bundle).length,0);assert.equal(writes(bundle).length,0);const i=operations(bundle,'intrinsic')[0];assert.equal(i.metadata.boundedSummary,true);assert.equal(i.metadata.exactArchitecturalSummary,true);assert.equal(i.effectSummary.memoryRead.scope,'all');assert.equal(i.effectSummary.memoryWrite.scope,'all');assert.equal(i.metadata.termination.entry,'count != 0');assert.match(i.metadata.termination.zeroCount,/no data-memory access/);});
for(const[prefix,expected,condition]of[[0xf3,'repe','updated ZF == 1'],[0xf2,'repne','updated ZF == 0']])test(`${expected}: condition semantics`,()=>{const{bundle}=lift({family:'cmpsd',prefixes:[prefix],length:2,bytes:[prefix,0xa7],implicitReads:ambiguous,implicitWrites:ambiguous});const i=operations(bundle,'intrinsic')[0];assert.equal(bundle.completeness,'exact-with-intrinsic');assert.equal(i.metadata.repeatKind,expected);assert.match(i.metadata.termination.continuation,new RegExp(condition));assert.equal(i.metadata.termination.initialConditionFlagUsedBeforeFirstIteration,false);assert.ok(bundle.operations.length<=20);});
test('unsupported F2 MOVS is partial',()=>{const{bundle}=lift({family:'movsb',prefixes:[0xf2],length:2,bytes:[0xf2,0xa4]});assert.equal(bundle.completeness,'partial');assert.match(bundle.unknownEffects.reason,/f2-repeat-prefix/);});
test('REP operation count is independent of runtime RCX',()=>{for(const input of [{family:'stosb',prefixes:[0xf3],length:2,bytes:[0xf3,0xaa]},{family:'stosq',prefixes:[0xf3],length:3,bytes:[0xf3,0x48,0xab]}]){const b=lift(input).bundle;assert.ok(b.operations.length<20);assert.equal(operations(b,'intrinsic').length,1);}});
test('SIMD MOVSD not stolen by string lifter',()=>{const instruction=decoded({family:'movsd',operands:[reg('xmm0',128,'write'),reg('xmm1',128,'read')],length:4,bytes:[0xf2,0x0f,0x10,0xc1]});assert.equal(liftX86StringEffects(instruction),null);});
