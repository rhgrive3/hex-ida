import test from 'node:test';
import assert from 'node:assert/strict';
import { liftX86MachineEffects } from '../../../../js/targets/architecture/x86_64/effects/index.js';
import { decoded,mem,operations,reg } from './helpers.mjs';
function lift(input){const instruction=decoded(input),bundle=liftX86MachineEffects(instruction);assert.ok(bundle,`expected MachineEffects for ${input.family}`);return{instruction,bundle};}
const reads=(b)=>operations(b,'memory-read'),writes=(b)=>operations(b,'memory-write');
function assertAtomicPair(bundle){assert.equal(reads(bundle).length,1);assert.equal(writes(bundle).length,1);assert.equal(reads(bundle)[0].access.atomic,true);assert.equal(writes(bundle)[0].access.atomic,true);assert.equal(reads(bundle)[0].access.ordering,'seq-cst');assert.equal(writes(bundle)[0].access.ordering,'seq-cst');assert.deepEqual(reads(bundle)[0].access.addressExpr,writes(bundle)[0].access.addressExpr);assert.equal(reads(bundle)[0].metadata.rmwId,writes(bundle)[0].metadata.rmwId);}
test('LOCK ADD maps proven locked ordering to generic seq-cst',()=>{const{bundle}=lift({family:'add',prefixes:[0xf0],operands:[mem({base:'rax',widthBits:64,access:'read-write'}),reg('rbx',64,'read')]});assert.equal(bundle.completeness,'exact-with-intrinsic');assertAtomicPair(bundle);assert.equal(bundle.metadata.orderingMapping,'seq-cst');assert.match(bundle.metadata.orderingAuthority,/Intel SDM Vol\.3/);assert.equal(bundle.metadata.orderingScope,'proven-atomic-rmw-only');});
test('memory XCHG implicit atomicity maps to generic seq-cst',()=>{const{bundle}=lift({family:'xchg',operands:[mem({base:'rax',widthBits:64,access:'read-write'}),reg('rcx',64,'read-write')]});assert.equal(bundle.completeness,'exact');assertAtomicPair(bundle);assert.equal(bundle.metadata.implicitAtomicWithoutLock,true);assert.equal(bundle.metadata.explicitLockPrefix,false);assert.equal(bundle.metadata.orderingMapping,'seq-cst');assert.ok(operations(bundle,'register-write').some((op)=>op.register.registerId==='rcx'));});
test('register XCHG is exact and snapshots both values before writing',()=>{
  const {bundle}=lift({family:'xchg',operands:[reg('rax',64,'read-write'),reg('rbx',64,'read-write')]});
  assert.equal(bundle.completeness,'exact');
  assert.equal(bundle.metadata.registerExchange,true);
  assert.equal(bundle.metadata.atomic,false);
  assert.equal(reads(bundle).length,0);
  assert.equal(writes(bundle).length,0);
  const registerReads=operations(bundle,'register-read');
  const registerWrites=operations(bundle,'register-write');
  assert.deepEqual(registerReads.map((op)=>op.register.registerId),['rax','rbx']);
  assert.deepEqual(registerWrites.map((op)=>op.register.registerId),['rax','rbx']);
  assert.deepEqual(registerWrites.map((op)=>op.value.temporaryId),[registerReads[1].value.temporaryId,registerReads[0].value.temporaryId]);
});
test('register XCHG preserves original overlapping byte views',()=>{
  const {bundle}=lift({family:'xchg',operands:[reg('al',8,'read-write'),reg('ah',8,'read-write')]});
  assert.equal(bundle.completeness,'exact');
  const registerReads=operations(bundle,'register-read');
  const registerWrites=operations(bundle,'register-write');
  assert.deepEqual(registerReads.slice(0,2).map((op)=>op.metadata.view),['al','ah']);
  assert.deepEqual(registerWrites.map((op)=>op.metadata.view),['al','ah']);
  assert.deepEqual(registerWrites.map((op)=>op.value.kind),['temporary','temporary']);
});
test('register XCHG rejects mismatched-width and LOCK-prefixed register forms',()=>{
  const mismatched=liftX86MachineEffects(decoded({family:'xchg',operands:[reg('rax',64,'read-write'),reg('ecx',32,'read-write')]}));
  assert.equal(mismatched.completeness,'partial');
  assert.equal(mismatched.unknownEffects.reason,'x86-xchg-register-shape-unmodelled');
  const locked=liftX86MachineEffects(decoded({family:'xchg',prefixes:[0xf0],operands:[reg('rax',64,'read-write'),reg('rbx',64,'read-write')]}));
  assert.equal(locked.completeness,'partial');
  assert.equal(locked.unknownEffects.reason,'x86-lock-prefix-without-memory-operand');
});
test('XADD without LOCK preserves old destination in source without ordering overclaim',()=>{const{bundle}=lift({family:'xadd',operands:[mem({base:'rax',widthBits:32,access:'read-write'}),reg('ecx',32,'read-write')]});assert.equal(reads(bundle)[0].access.atomic,false);assert.equal(writes(bundle)[0].access.atomic,false);assert.equal(reads(bundle)[0].access.ordering,undefined);assert.equal(writes(bundle)[0].access.ordering,undefined);assert.equal(bundle.metadata.sourceReceivesOldDestination,true);const sourceWrite=operations(bundle,'register-write').find((op)=>op.metadata.view==='ecx');assert.ok(sourceWrite);const transfer=operations(bundle,'value').find((op)=>op.opcode==='zext'&&op.metadata.fromBits===32&&op.metadata.toBits===64&&op.inputs?.[0]?.temporaryId===reads(bundle)[0].value.temporaryId);assert.ok(transfer);assert.deepEqual(sourceWrite.value,transfer.outputs[0]);assert.ok(operations(bundle,'flag-write').length>=6);});
test('LOCK XADD same-address atomic RMW uses generic seq-cst',()=>{const{bundle}=lift({family:'xadd',prefixes:[0xf0],operands:[mem({base:'rdi',displacement:8n,widthBits:64,access:'read-write'}),reg('rax',64,'read-write')]});assert.equal(bundle.completeness,'exact-with-intrinsic');assertAtomicPair(bundle);assert.equal(bundle.metadata.orderingMapping,'seq-cst');assert.equal(bundle.metadata.sourceReceivesOldDestination,true);});
test('CMPXCHG exact contract models the architectural write cycle and accumulator state',()=>{
  const {bundle}=lift({family:'cmpxchg',implicitReads:['rax'],operands:[mem({base:'rdi',widthBits:64,access:'read-write'}),reg('rcx',64,'read')]});
  assert.equal(bundle.completeness,'exact-with-intrinsic');
  assert.equal(bundle.unknownEffects,undefined);
  assert.equal(bundle.metadata.conditional,true);
  assert.equal(bundle.metadata.atomic,false);
  assert.equal(bundle.metadata.implicitAccumulator,'rax');
  const success=operations(bundle,'value').find((op)=>op.metadata.semantic==='x86-cmpxchg-success');
  const memoryResult=operations(bundle,'value').find((op)=>op.metadata.semantic==='x86-cmpxchg-memory-result');
  const acc=operations(bundle,'value').find((op)=>op.metadata.semantic==='x86-cmpxchg-accumulator-physical-result');
  assert.ok(success&&memoryResult&&acc);
  assert.equal(memoryResult.metadata.successPath,'source-to-destination');
  assert.equal(memoryResult.metadata.failurePath,'old-destination-written-back');
  assert.equal(acc.metadata.failurePath,'old-destination-to-accumulator-view');
  assert.equal(writes(bundle)[0].metadata.conditionalValue,true);
  assert.equal(writes(bundle)[0].metadata.failurePathArchitecturalWrite,true);
  assert.equal(writes(bundle)[0].metadata.failurePathWritesOldDestination,true);
  assert.equal(writes(bundle)[0].metadata.architecturalWriteCycleRegardlessOfComparison,true);
});
test('LOCK CMPXCHG exact contract maps the proven atomic RMW to seq-cst',()=>{
  const {bundle}=lift({family:'cmpxchg',prefixes:[0xf0],implicitReads:['eax'],operands:[mem({base:'rdi',widthBits:32,access:'read-write'}),reg('ecx',32,'read')]});
  assert.equal(bundle.completeness,'exact-with-intrinsic');
  assert.equal(bundle.unknownEffects,undefined);
  assertAtomicPair(bundle);
  assert.equal(bundle.metadata.conditional,true);
  assert.equal(bundle.metadata.atomic,true);
  assert.equal(bundle.metadata.implicitAccumulator,'eax');
  assert.equal(writes(bundle)[0].metadata.architecturalWriteCycleRegardlessOfComparison,true);
});
test('CMPXCHG without structured implicit accumulator remains fail-closed',()=>{
  const {bundle}=lift({family:'cmpxchg',operands:[mem({base:'rdi',widthBits:64,access:'read-write'}),reg('rcx',64,'read')]});
  assert.equal(bundle.completeness,'partial');
  assert.equal(bundle.metadata.structuredImplicitAccumulatorMissing,true);
  assert.match(bundle.unknownEffects.reason,/conditional-store-not-fully-representable/);
});
test('invalid LOCK register form not ignored',()=>{const{bundle}=lift({family:'add',prefixes:[0xf0],operands:[reg('rax',64,'read-write'),reg('rbx',64,'read')]});assert.equal(bundle.completeness,'partial');assert.equal(bundle.metadata.lockIgnored,false);assert.match(bundle.unknownEffects.reason,/lock-prefix-without-memory/);});
test('unsupported LOCK family remains conservative',()=>{const{bundle}=lift({family:'bts',prefixes:[0xf0],operands:[mem({base:'rax',widthBits:64,access:'read-write'}),reg('rcx',64,'read')]});assert.equal(bundle.completeness,'partial');assert.equal(bundle.metadata.lockIgnored,false);assert.match(bundle.unknownEffects.reason,/lock-prefixed-family-not-modelled/);});
test('atomic RMW identity and provenance survive',()=>{const{instruction,bundle}=lift({family:'xchg',operands:[reg('rax',64,'read-write'),mem({base:'rdi',index:'rcx',scale:8,displacement:-32n,widthBits:64,access:'read-write'})]});assertAtomicPair(bundle);assert.ok(bundle.origin.instructionIds.includes(instruction.instructionId));for(const op of bundle.operations)assert.equal(op.metadata.originInstructionId,instruction.instructionId);assert.equal(reads(bundle)[0].access.addressExpr.originInstructionId,instruction.instructionId);});
for(const family of ['cmpxchg8b','cmpxchg16b'])test(`${family}: structured wide atomic is one exact intrinsic RMW`,()=>{
  const is16=family==='cmpxchg16b';
  const widthBits=is16?128:64;
  const implicitReads=is16?['rax','rbx','rcx','rdx']:['eax','ebx','ecx','edx'];
  const implicitWrites=is16?['rax','rdx','rflags']:['eax','edx','rflags'];
  const {bundle}=lift({family,prefixes:[0xf0],implicitReads,implicitWrites,operands:[mem({base:'rax',widthBits,access:'read-write'})]});
  assert.equal(bundle.completeness,'exact-with-intrinsic');
  assert.equal(bundle.unknownEffects,undefined);
  assert.equal(bundle.metadata.exactWideAtomicClaim,true);
  assert.equal(bundle.metadata.atomic,true);
  assert.equal(bundle.metadata.orderingMapping,'seq-cst');
  assert.equal(reads(bundle).length,0);
  assert.equal(writes(bundle).length,0);
  const intrinsic=operations(bundle,'intrinsic').find((op)=>op.intrinsicId===`x86.atomic.${family}`);
  assert.ok(intrinsic);
  const readAccess=intrinsic.effectSummary.memoryRead.accesses[0];
  const writeAccess=intrinsic.effectSummary.memoryWrite.accesses[0];
  assert.deepEqual(readAccess.addressExpr,writeAccess.addressExpr);
  assert.equal(readAccess.widthBits,widthBits);
  assert.equal(writeAccess.widthBits,widthBits);
  assert.equal(readAccess.atomic,true);
  assert.equal(writeAccess.atomic,true);
  assert.equal(readAccess.ordering,'seq-cst');
  assert.equal(writeAccess.ordering,'seq-cst');
  if(is16){
    assert.equal(readAccess.alignment,16);
    assert.ok(bundle.possibleFaults.some((fault)=>fault.kind==='general-protection'&&fault.condition?.requiredAlignment===16));
    assert.ok(bundle.possibleFaults.some((fault)=>fault.kind==='invalid-opcode'&&fault.condition?.feature==='cx16'));
  }
});
for(const family of ['cmpxchg8b','cmpxchg16b'])test(`${family}: missing structured wide implicit pairs remain fail-closed`,()=>{
  const widthBits=family==='cmpxchg16b'?128:64;
  const {bundle}=lift({family,prefixes:[0xf0],operands:[mem({base:'rax',widthBits,access:'read-write'})]});
  assert.equal(bundle.completeness,'partial');
  assert.equal(bundle.unknownEffects.detail.expectedMemoryWidthBits,widthBits);
  assert.equal(bundle.metadata.exactWideAtomicClaim,false);
});
