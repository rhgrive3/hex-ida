import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createX86DecodedInstruction } from '../../js/targets/architecture/x86_64/decoded-instruction.js';
import { liftX86AtomicEffects } from '../../js/targets/architecture/x86_64/effects/atomic.js';
import { liftX86MachineEffects } from '../../js/targets/architecture/x86_64/effects/index.js';
import { liftX86MemoryEffects } from '../../js/targets/architecture/x86_64/effects/memory.js';
import { createCapstoneX86Session } from '../phase5/helpers/capstone-session.mjs';
import { decoded, imm, mem, reg } from '../phase5/effects/memory/helpers.mjs';
import {
  X86_LONG64_MEMORY_ATOMIC_EXCLUSIONS,
  x86Long64MemoryAddressCases,
  x86Long64MemoryDenominatorIdentity,
  x86Long64MemoryMoffsCases,
  x86Long64MemorySemanticCases,
} from '../../tools/validation/machine-effects/x86-long64-memory-denominator.mjs';

const identity=x86Long64MemoryDenominatorIdentity();
assert.deepEqual({
  address:identity.addressEncodingCaseCount,
  semantic:identity.semanticCaseCount,
  moffs:identity.moffsCaseCount,
  owner:identity.owner,
},{address:100992,semantic:7231,moffs:16,owner:'memory'});
assert.deepEqual(identity.ownership.atomicExcludedFamilies,['xchg','xadd','cmpxchg','cmpxchg8b','cmpxchg16b']);

const REG64=['rax','rcx','rdx','rbx','rsp','rbp','rsi','rdi','r8','r9','r10','r11','r12','r13','r14','r15'];
const REG32=['eax','ecx','edx','ebx','esp','ebp','esi','edi','r8d','r9d','r10d','r11d','r12d','r13d','r14d','r15d'];
const REG_VALUES=Object.fromEntries([
  ...REG64.map((name,i)=>[name,0x1122334455667788n+BigInt(i)*0x0101010101010101n]),
  ...REG32.map((name,i)=>[name,0x88776655n+BigInt(i)*0x01010101n]),
]);
const mask=(bits)=>(1n<<BigInt(bits))-1n;
function signedLE(bytes){let v=0n;for(let i=0;i<bytes.length;i++)v|=BigInt(bytes[i])<<BigInt(i*8);if(!bytes.length)return 0n;const bits=BigInt(bytes.length*8),sign=1n<<(bits-1n);return v&sign?v-(1n<<bits):v;}

// Independent byte oracle: parses ModRM/SIB directly and never calls the production addressing helper.
function oracleAddress(bytes,pc){
  let p=0,addressSizeBits=64;if(bytes[p]===0x67){addressSizeBits=32;p++;}
  const rex=bytes[p++];assert.ok(rex>=0x48&&rex<=0x4f);assert.equal(bytes[p++],0x8b);
  const modrm=bytes[p++],mod=modrm>>>6,rm=modrm&7;assert.ok(mod<3);
  const rexX=(rex>>>1)&1,rexB=rex&1,names=addressSizeBits===32?REG32:REG64;
  let base=null,index=null,scale=1,dispSize=mod===1?1:mod===2?4:0;
  if(rm===4){const sib=bytes[p++],rawIndex=(sib>>>3)&7,rawBase=sib&7;scale=1<<(sib>>>6);if(!(rawIndex===4&&rexX===0))index=names[rawIndex|(rexX<<3)];if(mod===0&&rawBase===5)dispSize=4;else base=names[rawBase|(rexB<<3)];}
  else if(mod===0&&rm===5){base=addressSizeBits===32?'eip':'rip';dispSize=4;}
  else base=names[rm|(rexB<<3)];
  const displacement=signedLE(bytes.subarray(p,p+dispSize));assert.equal(p+dispSize,bytes.length);
  const m=mask(addressSizeBits);let value=0n;
  if(base==='rip'||base==='eip')value=(BigInt(pc)+BigInt(bytes.length))&m;else if(base)value=REG_VALUES[base]&m;
  if(index)value=(value+(REG_VALUES[index]&m)*BigInt(scale))&m;
  return {addressSizeBits,base,index,scale,displacement,value:(value+displacement)&m};
}
function evalAddress(node){
  switch(node?.kind){
    case'x86-effective-address':return evalAddress(node.calculation)&mask(64);
    case'bitvector':return BigInt(node.value);
    case'register':{const value=REG_VALUES[node.view]??REG_VALUES[node.registerId];assert.notEqual(value,undefined);return BigInt(value)&mask(node.widthBits);}
    case'next-instruction-address':return BigInt(node.value);
    case'scaled-index':return evalAddress(node.calculation);
    case'add':return(evalAddress(node.left)+evalAddress(node.right))&mask(node.widthBits);
    case'wrap':return evalAddress(node.value)&mask(node.widthBits);
    case'zero-extend':return evalAddress(node.value)&mask(node.fromWidthBits);
    case'shift-left':return(evalAddress(node.value)<<BigInt(node.amount))&mask(node.widthBits);
    default:throw new TypeError(`address-oracle-node:${node?.kind}`);
  }
}
function exact(effects,label){assert.ok(effects,label);assert.ok(['exact','exact-with-intrinsic'].includes(effects.completeness),`${label}:${effects.completeness}:${effects.unknownEffects?.reason}`);assert.equal(effects.unknownEffects,undefined);}
function faultDirections(effects){return effects.possibleFaults.map((fault)=>fault.condition?.direction).filter(Boolean).sort();}
function executable(candidates){for(const candidate of candidates.filter(Boolean)){const p=spawnSync(candidate,['--version'],{stdio:'ignore'});if(!p.error&&p.status===0)return candidate;}return null;}

const session=await createCapstoneX86Session();
try{
  let addressCount=0,batch=[];
  function verifyBatch(items){
    const bytes=new Uint8Array(items.reduce((n,item)=>n+item.bytes.length,0));let off=0;for(const item of items){bytes.set(item.bytes,off);off+=item.bytes.length;}
    const raws=session.decode(bytes,0x400000n+BigInt(addressCount)*16n);assert.equal(raws.length,items.length,`address decode drift:${items[0].id}`);
    for(let i=0;i<items.length;i++){
      const item=items[i],raw=raws[i];assert.equal(raw.length,item.bytes.length,item.id);assert.equal(raw.instructionFamily,'mov',item.id);
      const instruction=createX86DecodedInstruction({...raw,instructionId:`memory-address:${item.id}`});
      const memory=instruction.detail.operands.find((operand)=>operand.type==='memory');assert.ok(memory,item.id);
      const expected=oracleAddress(item.bytes,raw.address);
      assert.deepEqual({addressSizeBits:instruction.detail.addressSizeBits,base:memory.memory.base?.id??null,index:memory.memory.index?.id??null,scale:memory.memory.scale,displacement:memory.memory.displacement},{addressSizeBits:expected.addressSizeBits,base:expected.base,index:expected.index,scale:expected.scale,displacement:expected.displacement},item.id);
      const effects=liftX86MemoryEffects(instruction);exact(effects,item.id);assert.equal(liftX86AtomicEffects(instruction),null,item.id);
      const read=effects.operations.find((op)=>op.kind==='memory-read');assert.ok(read,item.id);assert.equal(evalAddress(read.access.addressExpr),expected.value,item.id);assert.equal(read.access.widthBits,64,item.id);addressCount++;
    }
  }
  for(const item of x86Long64MemoryAddressCases()){batch.push(item);if(batch.length===1024){verifyBatch(batch);batch=[];}}if(batch.length)verifyBatch(batch);
  assert.equal(addressCount,identity.addressEncodingCaseCount);

  let semanticCount=0;
  for(const item of x86Long64MemorySemanticCases()){
    const raws=session.decode(item.bytes,0x800000n+BigInt(semanticCount)*32n);assert.equal(raws.length,1,item.caseId);const raw=raws[0];assert.equal(raw.length,item.bytes.length,item.caseId);assert.equal(raw.instructionFamily,item.family,item.caseId);
    const instruction=createX86DecodedInstruction({...raw,instructionId:`memory-semantic:${item.caseId}`}),owned=liftX86MemoryEffects(instruction);exact(owned,item.caseId);exact(liftX86MachineEffects(instruction),`top:${item.caseId}`);
    const atomic=liftX86AtomicEffects(instruction);if(item.locked){assert.equal(atomic?.completeness,'partial',item.caseId);assert.equal(atomic?.unknownEffects?.reason,'x86-lock-prefixed-family-not-modelled-in-p5-2',item.caseId);}else assert.equal(atomic,null,item.caseId);
    assert.deepEqual(faultDirections(owned),[...item.faultDirections].sort(),item.caseId);
    if(item.explicitMemory){const address=owned.metadata.address??owned.metadata.sourceAddress;assert.ok(address,item.caseId);assert.equal(address.addressSizeBits,item.addressSizeBits,item.caseId);assert.equal(address.segment,item.segment.id==='default'?null:item.segment.id,item.caseId);assert.equal(address.segmentBaseRule,item.segment.baseRule,item.caseId);}
    if(item.access==='read-write'){
      const read=owned.operations.find((op)=>op.kind==='memory-read');const write=owned.operations.find((op)=>op.kind==='memory-write');const conditional=owned.operations.find((op)=>op.kind==='intrinsic'&&op.intrinsicId==='x86.memory.conditional-rmw-write');const address=write?.access?.addressExpr??conditional?.effectSummary?.memoryWrite?.accesses?.[0]?.addressExpr;assert.ok(read&&address,item.caseId);assert.deepEqual(address,read.access.addressExpr,item.caseId);
    }
    for(const fault of owned.possibleFaults.filter((f)=>f.kind==='memory-access-fault'))assert.deepEqual(fault.detail?.causes,['segment','non-canonical-address','page','protection','alignment-check'],item.caseId);
    if(item.locked){const accesses=owned.operations.filter((op)=>op.kind==='memory-read'||op.kind==='memory-write');assert.ok(accesses.length,item.caseId);assert.ok(accesses.every((op)=>op.access.atomic===true&&op.access.ordering==='seq-cst'),item.caseId);assert.equal(owned.metadata.orderingContract,'x86-locked-rmw-seq-cst/v1',item.caseId);}
    if(/-(cl)-/.test(item.id)){const conditional=owned.operations.find((op)=>op.kind==='intrinsic'&&op.intrinsicId==='x86.memory.conditional-rmw-write');assert.equal(conditional?.effectSummary?.memoryWrite?.scope,'accesses',item.caseId);assert.equal(conditional?.effectSummary?.memoryWrite?.accesses?.length,1,item.caseId);assert.equal(owned.operations.some((op)=>op.kind==='memory-write'),false,item.caseId);}
    semanticCount++;
  }
  assert.equal(semanticCount,identity.semanticCaseCount);

  let moffsCount=0;for(const item of x86Long64MemoryMoffsCases()){const [raw,...extra]=session.decode(item.bytes,0xa00000n+BigInt(moffsCount)*32n);assert.ok(raw,item.id);assert.equal(extra.length,0,item.id);assert.equal(raw.length,item.bytes.length,item.id);const effects=liftX86MemoryEffects(createX86DecodedInstruction({...raw,instructionId:`memory:${item.id}`}));exact(effects,item.id);assert.equal(effects.metadata.address.addressSizeBits,item.addressSizeBits,item.id);assert.equal(faultDirections(effects)[0],item.direction,item.id);moffsCount++;}assert.equal(moffsCount,16);

  for(const [bytes,destBits,memoryBits] of [[[0x66,0x63,0x00],16,16],[[0x63,0x00],32,32],[[0x48,0x63,0x00],64,32]]){const [raw]=session.decode(Uint8Array.from(bytes),0xb00000n+BigInt(destBits));const instruction=createX86DecodedInstruction({...raw,instructionId:`movsxd:${destBits}`}),effects=liftX86MemoryEffects(instruction);exact(effects,`movsxd:${destBits}`);assert.equal(effects.operations.find((op)=>op.kind==='memory-read').access.widthBits,memoryBits);assert.equal(effects.metadata.memoryWidthBits,memoryBits);if(destBits===16){assert.equal(instruction.detail.operands[1].widthBits,32);assert.ok(effects.operations.some((op)=>op.kind==='register-read'&&op.register.registerId==='rax'));}}
  const inconsistent=liftX86MemoryEffects(decoded({family:'movsxd',operands:[reg('ax',16,'write'),mem({base:'rax',widthBits:32,access:'read'})],prefixes:[]}));assert.equal(inconsistent.completeness,'partial');assert.equal(inconsistent.metadata.failClosed,true);
  for(const [bytes,view,policy] of [[[0x8a,0x00],'al','preserve-unaffected'],[[0x66,0x8b,0x00],'ax','preserve-unaffected'],[[0x8b,0x00],'eax','zero-extend-32']]){const [raw]=session.decode(Uint8Array.from(bytes),0xb10000n);const effects=liftX86MemoryEffects(createX86DecodedInstruction({...raw,instructionId:`partial:${view}`}));exact(effects,view);const write=effects.operations.filter((op)=>op.kind==='register-write').at(-1);assert.equal(write?.metadata?.view,view);assert.equal(write?.metadata?.writePolicy,policy);}

  for(const item of X86_LONG64_MEMORY_ATOMIC_EXCLUSIONS){const [raw]=session.decode(item.bytes,0xd00000n);assert.ok(raw,item.id);const instruction=createX86DecodedInstruction({...raw,instructionId:`atomic:${item.id}`});assert.equal(liftX86MemoryEffects(instruction),null,item.id);assert.ok(liftX86AtomicEffects(instruction),item.id);}
  assert.equal(session.decode(Uint8Array.of(0x48,0x8b),0xe00000n).length,0);assert.equal(session.decode(Uint8Array.of(0x48,0x8b,0x04),0xe00010n).length,0);
  const [validRaw]=session.decode(Uint8Array.of(0x48,0x8b,0x00),0xe00100n);assert.equal(liftX86MachineEffects({...validRaw,instructionId:'missing-detail',detailAvailable:false,detailStatus:'unavailable',detail:null}),null);
  const deferred=liftX86MachineEffects(decoded({family:'mov',operands:[reg('rax',64),{type:'invalid',access:'unknown'}]}));assert.equal(deferred.completeness,'partial');assert.equal(deferred.metadata.failClosed,true);
  assert.throws(()=>decoded({family:'mov',operands:[reg('rax',64),mem({base:'rax',widthBits:64,scale:3})]}),/x86-decoded-instruction-invalid-memory-scale/);
  for(const malformed of [decoded({family:'mov',operands:[reg('rax',64),mem({base:'rax',widthBits:24})]}),decoded({family:'mov',operands:[reg('rax',64),mem({base:'rax',widthBits:64,addressSizeBits:16})],addressSizeBits:16}),decoded({family:'mov',operands:[reg('rax',64),mem({base:'rax',widthBits:64,segment:'bogus'})]}),decoded({family:'mov',operands:[mem({base:'rax',widthBits:64}),mem({base:'rbx',widthBits:64})]})]){const effects=liftX86MemoryEffects(malformed);assert.equal(effects.completeness,'partial');assert.equal(effects.metadata.failClosed,true);}
  for(const illegal of [decoded({family:'mov',operands:[reg('rax',64),mem({base:'rax',widthBits:64})],prefixes:[0xf0]}),decoded({family:'add',operands:[reg('rax',64),mem({base:'rax',widthBits:64})],prefixes:[0xf0]}),decoded({family:'shl',operands:[mem({base:'rax',widthBits:64}),imm(1,8,8)],prefixes:[0xf0]}),decoded({family:'cmp',operands:[mem({base:'rax',widthBits:64}),imm(1,64,8)],prefixes:[0xf0]})]){const effects=liftX86MemoryEffects(illegal);assert.equal(effects.completeness,'partial');assert.equal(effects.metadata.invalidOrUnsupportedLock,true);}

  // Independent disassembly oracle when LLVM is available on this runner. The byte-level oracle above is always mandatory.
  const clang=executable([process.env.CLANG,'/usr/bin/clang-18','clang-18','/usr/bin/clang','clang']);
  const llvmObjdump=executable([process.env.LLVM_OBJDUMP,'/usr/bin/llvm-objdump-18','llvm-objdump-18','/usr/bin/llvm-objdump','llvm-objdump']);
  if(clang&&llvmObjdump){const dir=mkdtempSync(join(tmpdir(),'x86-memory-denominator-'));try{const source=join(dir,'oracle.s'),object=join(dir,'oracle.o');writeFileSync(source,`.text\n.globl movsxd16\nmovsxd16: .byte 0x66,0x63,0x00\n.globl movsxd32a32\nmovsxd32a32: .byte 0x67,0x63,0x00\n.globl shiftcl\nshiftcl: .byte 0x48,0xd3,0x20\n.globl lockadd\nlockadd: .byte 0xf0,0x48,0x83,0x00,0x01\n`);execFileSync(clang,['-c','-target','x86_64-unknown-linux-gnu',source,'-o',object],{stdio:'pipe'});const llvm=execFileSync(llvmObjdump,['-d',object],{encoding:'utf8'});assert.match(llvm,/movslq[^\n]*%ax/);assert.match(llvm,/movslq[^\n]*\(%eax\), %eax/);assert.match(llvm,/shlq[^\n]*%cl/);assert.match(llvm,/\tlock\n/);assert.match(llvm,/\taddq\t/);}finally{rmSync(dir,{recursive:true,force:true});}}
  else console.log('x86 long-64 memory denominator: LLVM sample skipped (tool unavailable; byte oracle remains mandatory)');
}finally{session.close();}
console.log(`x86 long-64 memory denominator: PASS (${identity.addressEncodingCaseCount} address + ${identity.semanticCaseCount} semantic + ${identity.moffsCaseCount} moffs cases)`);
