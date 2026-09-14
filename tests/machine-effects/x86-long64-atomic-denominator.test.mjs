import assert from 'node:assert/strict';

import { createX86DecodedInstruction } from '../../js/targets/architecture/x86_64/decoded-instruction.js';
import { liftX86AtomicEffects } from '../../js/targets/architecture/x86_64/effects/atomic.js';
import { liftX86MachineEffects } from '../../js/targets/architecture/x86_64/effects/index.js';
import { createCapstoneX86Session } from '../phase5/helpers/capstone-session.mjs';
import {
  x86Long64AtomicDenominatorCases,
  x86Long64AtomicDenominatorIdentity,
  x86Long64AtomicNegativeEncodings,
} from '../../tools/validation/machine-effects/x86-long64-atomic-denominator.mjs';

const identity = x86Long64AtomicDenominatorIdentity();
assert.equal(identity.denominatorId,'x86_64:long-64:effect-family:atomic');
assert.equal(identity.semanticCaseCount,89);
assert.deepEqual(identity.scalarWidths,[8,16,32,64]);
assert.ok(identity.oracleIds.some((id) => id.includes('intel-sdm')));
assert.ok(identity.oracleIds.some((id) => id.includes('amd64')));
assert.ok(identity.oracleIds.some((id) => id.includes('capstone')));
assert.equal(x86Long64AtomicNegativeEncodings().length,14);

const operation = (bundle,kind) => bundle.operations.filter((item) => item.kind === kind);
const ids = (registers) => registers.map((register) => register.id);
const hasFault = (bundle,kind,predicate = () => true) => bundle.possibleFaults.some((fault) => fault.kind === kind && predicate(fault));

function assertExact(bundle,id) {
  assert.ok(bundle,`atomic family escaped ownership: ${id}`);
  assert.ok(['exact','exact-with-intrinsic'].includes(bundle.completeness),`${id}: ${bundle.completeness}:${bundle.unknownEffects?.reason ?? ''}`);
  assert.equal(bundle.unknownEffects,undefined,`${id}: exact closure retained unknown effects`);
  assert.equal(bundle.metadata.family,'atomic',`${id}: wrong effect family`);
}
function assertScalarMemory(caseItem,bundle) {
  const reads = operation(bundle,'memory-read');
  const writes = operation(bundle,'memory-write');
  assert.equal(reads.length,1,`${caseItem.id}: one RMW read`);
  assert.equal(writes.length,1,`${caseItem.id}: one RMW write`);
  assert.deepEqual(reads[0].access.addressExpr,writes[0].access.addressExpr,`${caseItem.id}: RMW address identity`);
  assert.equal(reads[0].access.widthBits,caseItem.widthBits);
  assert.equal(writes[0].access.widthBits,caseItem.widthBits);
  assert.equal(reads[0].access.atomic,caseItem.expectedAtomic);
  assert.equal(writes[0].access.atomic,caseItem.expectedAtomic);
  assert.equal(reads[0].access.ordering,caseItem.expectedOrdering ?? undefined);
  assert.equal(writes[0].access.ordering,caseItem.expectedOrdering ?? undefined);
  assert.equal(reads[0].metadata.rmwId,writes[0].metadata.rmwId);
  assert.ok(hasFault(bundle,'memory-access-fault',(fault) => fault.condition?.direction === 'read-write' && fault.condition?.widthBits === caseItem.widthBits),`${caseItem.id}: read-write fault contract`);
  if (caseItem.family === 'xchg') {
    assert.equal(bundle.metadata.implicitAtomicWithoutLock,true,`${caseItem.id}: memory XCHG must be implicit atomic`);
    assert.equal(bundle.metadata.orderingMapping,'seq-cst');
  } else if (caseItem.locked) {
    assert.equal(bundle.metadata.orderingMapping,'seq-cst',`${caseItem.id}: locked ordering`);
    assert.equal(bundle.metadata.orderingContract,'x86-locked-rmw-seq-cst/v1');
  } else {
    assert.notEqual(bundle.metadata.orderingMapping,'seq-cst',`${caseItem.id}: unlocked scalar must not overclaim ordering`);
  }
  if (caseItem.family === 'cmpxchg') {
    assert.equal(writes[0].metadata.architecturalWriteCycleRegardlessOfComparison,true,`${caseItem.id}: CMPXCHG write cycle`);
    assert.equal(writes[0].metadata.failurePathArchitecturalWrite,true,`${caseItem.id}: failure writes old value back`);
    assert.equal(bundle.metadata.implicitAccumulator,caseItem.implicitReads[0]);
  }
}
function assertWide(caseItem,bundle) {
  assert.equal(bundle.metadata.exactWideAtomicClaim,true,caseItem.id);
  assert.equal(bundle.metadata.expectedPair,caseItem.expectedPair);
  assert.equal(bundle.metadata.replacementPair,caseItem.replacementPair);
  assert.equal(bundle.metadata.requiredFeature,caseItem.requiredFeature);
  assert.equal(bundle.metadata.atomic,caseItem.expectedAtomic);
  assert.equal(bundle.metadata.orderingMapping,caseItem.expectedOrdering ? 'seq-cst' : 'not-applicable');
  const intrinsic = operation(bundle,'intrinsic').find((item) => item.intrinsicId === `x86.atomic.${caseItem.family}`);
  assert.ok(intrinsic,`${caseItem.id}: wide RMW must be one semantic intrinsic, not load+store pretending to be exact`);
  assert.equal(operation(bundle,'memory-read').length,0,`${caseItem.id}: no split top-level wide load`);
  assert.equal(operation(bundle,'memory-write').length,0,`${caseItem.id}: no split top-level wide store`);
  assert.equal(intrinsic.metadata.exactArchitecturalSummary,true);
  assert.equal(intrinsic.metadata.unaffectedFlags.length,5);
  const readAccess = intrinsic.effectSummary.memoryRead.accesses[0];
  const writeAccess = intrinsic.effectSummary.memoryWrite.accesses[0];
  assert.deepEqual(readAccess.addressExpr,writeAccess.addressExpr,`${caseItem.id}: same wide RMW address`);
  assert.equal(readAccess.widthBits,caseItem.widthBits);
  assert.equal(writeAccess.widthBits,caseItem.widthBits);
  assert.equal(readAccess.atomic,caseItem.expectedAtomic);
  assert.equal(writeAccess.atomic,caseItem.expectedAtomic);
  assert.equal(readAccess.ordering,caseItem.expectedOrdering ?? undefined);
  assert.equal(writeAccess.ordering,caseItem.expectedOrdering ?? undefined);
  assert.equal(readAccess.alignment,caseItem.alignmentBytes ?? undefined);
  assert.equal(writeAccess.alignment,caseItem.alignmentBytes ?? undefined);
  assert.deepEqual(operation(bundle,'register-read').map((item) => item.register.registerId),['rax','rdx','rbx','rcx']);
  assert.deepEqual(operation(bundle,'register-write').map((item) => item.register.registerId),['rax','rdx']);
  assert.deepEqual(operation(bundle,'flag-write').map((item) => item.flag.flagId),['RFLAGS.ZF']);
  assert.ok(hasFault(bundle,'memory-access-fault',(fault) => fault.condition?.direction === 'read-write' && fault.condition?.widthBits === caseItem.widthBits));
  if (caseItem.family === 'cmpxchg16b') {
    assert.ok(hasFault(bundle,'general-protection',(fault) => fault.condition?.requiredAlignment === 16),`${caseItem.id}: alignment #GP`);
    assert.ok(hasFault(bundle,'invalid-opcode',(fault) => fault.condition?.feature === 'cx16'),`${caseItem.id}: CX16 feature #UD`);
  }
}

const session = await createCapstoneX86Session();
let count = 0;
try {
  for (const caseItem of x86Long64AtomicDenominatorCases()) {
    const decoded = session.decode(caseItem.bytes,0x400000n + BigInt(count) * 0x20n);
    assert.equal(decoded.length,1,`${caseItem.id}: independent Capstone rejected denominator encoding`);
    const raw = decoded[0];
    assert.equal(raw.length,caseItem.bytes.length,`${caseItem.id}: encoding not consumed exactly`);
    assert.equal(raw.instructionFamily,caseItem.family,`${caseItem.id}: family drift`);
    assert.equal(raw.detail.operands[0]?.widthBits,caseItem.widthBits,`${caseItem.id}: width drift`);
    assert.equal(raw.detail.operands[0]?.type,caseItem.destinationKind,`${caseItem.id}: destination-kind drift`);
    assert.equal([...raw.detail.prefixes.legacy].includes(0xf0),caseItem.locked,`${caseItem.id}: LOCK decode drift`);
    for (const register of caseItem.implicitReads) assert.ok(raw.detail.implicitReads.includes(register),`${caseItem.id}: missing implicit read ${register}`);
    for (const register of caseItem.implicitWrites) assert.ok(raw.detail.implicitWrites.includes(register),`${caseItem.id}: missing implicit write ${register}`);

    const instruction = createX86DecodedInstruction({...raw,instructionId:`x86-atomic-denominator:${caseItem.id}`});
    assert.deepEqual(ids(instruction.detail.implicitReads),raw.detail.implicitReads,`${caseItem.id}: structured implicit read normalization`);
    assert.deepEqual(ids(instruction.detail.implicitWrites),raw.detail.implicitWrites,`${caseItem.id}: structured implicit write normalization`);
    const bundle = liftX86MachineEffects(instruction);
    assertExact(bundle,caseItem.id);
    assert.equal(bundle.metadata.operation,caseItem.family);

    if (caseItem.family === 'cmpxchg8b' || caseItem.family === 'cmpxchg16b') assertWide(caseItem,bundle);
    else if (caseItem.destinationKind === 'memory') assertScalarMemory(caseItem,bundle);
    else {
      assert.equal(operation(bundle,'memory-read').length,0,`${caseItem.id}: register form memory read`);
      assert.equal(operation(bundle,'memory-write').length,0,`${caseItem.id}: register form memory write`);
      assert.equal(bundle.metadata.atomic,false,`${caseItem.id}: register form cannot be atomic memory RMW`);
      if (caseItem.family === 'cmpxchg') assert.equal(bundle.metadata.implicitAccumulator,caseItem.implicitReads[0]);
    }
    count++;
  }

  for (const negative of x86Long64AtomicNegativeEncodings()) {
    assert.equal(session.decode(negative.bytes,0x500000n).length,0,`${negative.id}: illegal encoding reached structured atomic ownership`);
  }

  const realCmpxchg = session.decode(Uint8Array.of(0x48,0x0f,0xb1,0x08),0x600000n)[0];
  const missingAccumulator = createX86DecodedInstruction({
    ...realCmpxchg,
    instructionId:'x86-atomic-negative:missing-accumulator',
    detail:{...realCmpxchg.detail,implicitReads:[]},
  });
  const missingAccumulatorBundle = liftX86MachineEffects(missingAccumulator);
  assert.equal(missingAccumulatorBundle.completeness,'partial');
  assert.equal(missingAccumulatorBundle.metadata.structuredImplicitAccumulatorMissing,true);

  const realWide = session.decode(Uint8Array.of(0x48,0x0f,0xc7,0x08),0x600100n)[0];
  const wrongPair = createX86DecodedInstruction({
    ...realWide,
    instructionId:'x86-atomic-negative:wrong-wide-pair',
    detail:{...realWide.detail,implicitReads:['rax','rbx','rcx','r8'],implicitWrites:realWide.detail.implicitWrites},
  });
  const wrongPairBundle = liftX86MachineEffects(wrongPair);
  assert.equal(wrongPairBundle.completeness,'partial');
  assert.equal(wrongPairBundle.metadata.exactWideAtomicClaim,false);

  const invalidWidth = createX86DecodedInstruction({
    instructionId:'x86-atomic-negative:invalid-width',instructionCode:900001,instructionFamily:'xadd',address:0x700000n,length:1,rawBytes:Uint8Array.of(0x90),mode:'long-64',detailAvailable:true,detailStatus:'complete',
    detail:{prefixes:{legacy:[]},operands:[{type:'memory',widthBits:128,access:'read-write',memory:{base:'rax'}},{type:'register',register:'rcx',widthBits:64,access:'read-write'}],implicitReads:[],implicitWrites:[]},
  });
  assert.equal(liftX86AtomicEffects(invalidWidth).completeness,'partial');

  const malformed = createX86DecodedInstruction({
    instructionId:'x86-atomic-negative:malformed',instructionCode:900002,instructionFamily:'xchg',address:0x700010n,length:1,rawBytes:Uint8Array.of(0x90),mode:'long-64',detailAvailable:true,detailStatus:'complete',
    detail:{prefixes:{legacy:[]},operands:[{type:'memory',widthBits:64,access:'read-write',memory:{base:'rax'}}],implicitReads:[],implicitWrites:[]},
  });
  assert.equal(liftX86AtomicEffects(malformed).completeness,'partial');

  const badWideWidth = createX86DecodedInstruction({
    instructionId:'x86-atomic-negative:bad-wide-width',instructionCode:900003,instructionFamily:'cmpxchg16b',address:0x700020n,length:1,rawBytes:Uint8Array.of(0x90),mode:'long-64',detailAvailable:true,detailStatus:'complete',
    detail:{prefixes:{legacy:[]},operands:[{type:'memory',widthBits:64,access:'read-write',memory:{base:'rax'}}],implicitReads:['rax','rbx','rcx','rdx'],implicitWrites:['rax','rdx','rflags']},
  });
  assert.equal(liftX86AtomicEffects(badWideWidth).completeness,'partial');

  const unavailable = createX86DecodedInstruction({
    instructionId:'x86-atomic-negative:no-detail',instructionCode:900004,instructionFamily:'cmpxchg',address:0x700030n,length:1,rawBytes:Uint8Array.of(0x90),mode:'long-64',detailAvailable:false,detailStatus:'unavailable',
    detail:{prefixes:{legacy:[]},operands:[],implicitReads:[],implicitWrites:[]},
  });
  assert.equal(liftX86MachineEffects(unavailable),null,'missing structured detail must not fabricate exact ownership');
} finally {
  session.close();
}

assert.equal(count,identity.semanticCaseCount);
console.log(`x86 long-64 atomic denominator (${count} semantic discriminators): PASS`);
