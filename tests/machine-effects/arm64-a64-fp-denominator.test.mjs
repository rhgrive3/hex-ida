import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

import { parseOperands } from '../../js/arm64.js';
import { validateMachineEffectBundle } from '../../js/semantics/effects/index.js';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';
import {
  ARM64_FP_EFFECT_MNEMONICS,
  decodeArm64FpImmediate,
} from '../../js/targets/architecture/arm64/effects/fp.js';
import {
  ARM64_A64_FP_DENOMINATOR_ID,
  ARM64_A64_FP_ENCODING_FAMILIES,
  ARM64_A64_FP_MNEMONIC_DENOMINATOR,
  arm64A64FpEncodingCases,
  classifyArm64A64FpEncoding,
  validateArm64A64FpDenominator,
} from '../../tools/validation/machine-effects/arm64-a64-fp-denominator.mjs';
import { createCapstoneArm64Session } from './helpers/arm64-capstone-session.mjs';

function bytes32(word){const value=Number(word)>>>0;return Uint8Array.of(value&255,(value>>>8)&255,(value>>>16)&255,value>>>24);}
function instruction(raw,id){return {instructionId:id,address:raw.address,mnemonic:raw.mnemonic,operands:raw.opStr,opStr:raw.opStr,ops:parseOperands(raw.opStr),mode:'a64',origin:{instructionIds:[id]}};}
function physicalId(op){
  if(op?.k!=='reg'||op.cls==='zr') return null;
  if(op.cls==='fp') return `v${op.num}`;
  if(op.cls==='gp') return `x${op.num}`;
  return null;
}
function temporaryId(value){return value?.kind==='temporary'?value.temporaryId:null;}
function assertDefined(value,defined,label){const id=temporaryId(value);if(id)assert.ok(defined.has(id),`${label}:use-before-definition:${id}`);}
function assertClosedDataflow(bundle,label){
  const defined=new Set();
  for(const operation of bundle.operations){
    if(operation.kind==='register-read'){
      const id=temporaryId(operation.value);assert.ok(id,`${label}:register-read-without-temporary`);defined.add(id);continue;
    }
    if(operation.kind==='value'){
      for(const input of operation.inputs||[])assertDefined(input,defined,`${label}:${operation.opcode}`);
      for(const output of operation.outputs||[]){const id=temporaryId(output);assert.ok(id);defined.add(id);}continue;
    }
    if(operation.kind==='intrinsic'){
      for(const input of operation.effectSummary.inputs||[])assertDefined(input,defined,`${label}:${operation.intrinsicId}`);
      for(const output of operation.effectSummary.outputs||[]){const id=temporaryId(output);assert.ok(id);defined.add(id);}continue;
    }
    if(operation.kind==='register-write')assertDefined(operation.value,defined,`${label}:register-write:${operation.register.registerId}`);
  }
}

const denominator=validateArm64A64FpDenominator();
assert.equal(denominator.denominatorId,ARM64_A64_FP_DENOMINATOR_ID);
assert.equal(denominator.encodingFamilyCount,67);
assert.equal(denominator.encodingCaseCount,8_417);
assert.equal(denominator.mnemonicCount,45);
assert.deepEqual([...ARM64_A64_FP_MNEMONIC_DENOMINATOR].sort(),[...ARM64_FP_EFFECT_MNEMONICS].sort());

const session=await createCapstoneArm64Session();
let count=0;const observed=new Set();
try{
  let batch=[];
  function verifyBatch(items){
    const bytes=new Uint8Array(items.length*4);for(let index=0;index<items.length;index++)bytes.set(bytes32(items[index].word),index*4);
    const decoded=session.decode(bytes,0x400000n+BigInt(count*4));
    assert.equal(decoded.length,items.length,`decoder rejected valid FP case at ${items[0].id}`);
    for(let index=0;index<items.length;index++){
      const item=items[index],raw=decoded[index],id=`arm64-fp-denominator:${item.id}`;
      observed.add(raw.mnemonic);
      assert.ok(ARM64_FP_EFFECT_MNEMONICS.has(raw.mnemonic),`${item.id}:unowned:${raw.mnemonic}:${raw.opStr}`);
      const decodedModel=instruction(raw,id);const effects=liftArm64MachineEffects(decodedModel);
      assert.ok(effects,`${item.id}:escaped FP ownership`);
      assert.ok(['exact','exact-with-intrinsic'].includes(effects.completeness),`${item.id}:${raw.opStr}:${effects.unknownEffects?.reason}`);
      assert.equal(effects.metadata.family,'arm64-fp',item.id);
      assert.equal(effects.operations.some((operation)=>operation.kind==='unknown'),false,item.id);
      assert.doesNotThrow(()=>validateMachineEffectBundle(effects),item.id);

      // Dataflow proof precedes cardinality assertions: every temporary input
      // must be defined by a physical read, value op, or intrinsic output.
      assertClosedDataflow(effects,item.id);
      const ops=decodedModel.ops;
      const compare=/^fcc?mpe?$/.test(raw.mnemonic);
      const sources=compare?ops:ops.slice(1);
      const reads=new Set(effects.operations.filter((operation)=>operation.kind==='register-read').map((operation)=>operation.register.registerId));
      for(const source of sources){const sourceId=physicalId(source);if(sourceId)assert.ok(reads.has(sourceId),`${item.id}:missing-source-read:${sourceId}`);}
      if(!compare){
        const destinationId=physicalId(ops[0]);
        if(destinationId){
          const writes=effects.operations.filter((operation)=>operation.kind==='register-write'&&operation.register.registerId===destinationId);
          assert.equal(writes.length,1,`${item.id}:destination-write:${destinationId}`);
          assert.equal(writes[0].register.widthBits,ops[0].cls==='fp'?128:64,`${item.id}:physical-destination-width`);
        }
      }
      for(const operation of effects.operations.filter((candidate)=>candidate.kind==='register-read')){
        if(/^v\d+$/.test(operation.register.registerId))assert.equal(operation.register.widthBits,128,`${item.id}:scalar-FP-read-not-physical`);
        if(/^x\d+$/.test(operation.register.registerId))assert.equal(operation.register.widthBits,64,`${item.id}:GP-read-not-physical`);
      }
      if(item.familyId==='fmov-immediate'){
        const type=(item.word>>>22)&3,width={0:32,1:64,3:16}[type],imm8=(item.word>>>13)&255;
        const bitcopy=effects.operations.find((operation)=>operation.kind==='value'&&operation.opcode==='arm64.fp.bitcopy');
        assert.equal(bitcopy.inputs[0].value,decodeArm64FpImmediate(imm8,width).toString(),`${item.id}:FPImm8-bit-pattern`);
      }
      if(item.familyId.endsWith('-fixed')){
        const fbits=64-((item.word>>>10)&0x3f);
        const intrinsic=effects.operations.find((operation)=>operation.kind==='intrinsic');
        assert.ok(intrinsic.effectSummary.inputs.some((value)=>value.kind==='bitvector'&&value.widthBits===7&&value.value===String(fbits)),
          `${item.id}:fixed-point-scale-value`);
      }
      if(item.familyId==='fccmp'||item.familyId==='fccmpe'){
        const intrinsic=effects.operations.find((operation)=>operation.kind==='intrinsic');
        assert.equal(intrinsic.metadata.fallbackNzcv,String(item.word&15),`${item.id}:fallback-NZCV`);
        assert.equal(intrinsic.metadata.condition,ops.find((op)=>op.k==='cond').text,`${item.id}:condition`);
      }
      count++;
    }
  }
  for(const item of arm64A64FpEncodingCases()){batch.push(item);if(batch.length===512){verifyBatch(batch);batch=[];}}
  if(batch.length)verifyBatch(batch);

  assert.deepEqual([...observed].sort(),[...ARM64_FP_EFFECT_MNEMONICS].sort(),'every registry mnemonic must be emitted by deployed Capstone');
  for(const word of [
    0x1ea22820, // scalar FP type=2 is reserved
    0x9e260020, // FMOV X,S has an invalid GP/FP width correlation
    0x1e020020, // fixed-point W conversion with scale=0 encodes fbits=64
    0x1e228820, // adjacent FNMUL is not owned by this finite family
    0x4e22d420, // vector FADD belongs to SIMD, not scalar FP
    0x1e2e1020, // damaged fixed bit in FMOV-immediate
  ])assert.equal(classifyArm64A64FpEncoding(word),null,`reserved/adjacent encoding claimed:0x${word.toString(16)}`);

  for(const [mnemonic,operands] of [
    ['fcvt','s0'],['fcsel','s0, s1, s2'],['fccmp','s0, s1, #16, eq'],
    ['fmov','s0, #0.0'],['scvtf','s0, w1, #0'],['fadd','s0, d1, s2'],['fmov','x0, s1'],
  ]){
    const malformed=liftArm64MachineEffects({instructionId:`arm64-fp-negative:${mnemonic}:${operands}`,mnemonic,ops:parseOperands(operands),mode:'a64'});
    assert.equal(malformed.completeness,'partial',`${mnemonic} ${operands} must fail closed`);
  }
  assert.equal(liftArm64MachineEffects({instructionId:'arm64-fp-unowned',mnemonic:'fnmul',ops:parseOperands('s0, s1, s2'),mode:'a64'}),null,
    'unowned F-prefixed instructions must remain in the explicit fallback gap');
}finally{session.close();}
assert.equal(count,denominator.encodingCaseCount);

const llvmMc=['/usr/bin/llvm-mc-18','/usr/bin/llvm-mc'].find((candidate)=>fs.existsSync(candidate));
assert.ok(llvmMc,'LLVM MC 18 AArch64 oracle is required');
const onePerFamily=new Map();for(const item of arm64A64FpEncodingCases())if(!onePerFamily.has(item.familyId))onePerFamily.set(item.familyId,item.word);
const oracleInput=[...onePerFamily.values()].map((word)=>[...bytes32(word)].map((byte)=>`0x${byte.toString(16).padStart(2,'0')}`).join(' ')).join('\n');
const oracle=spawnSync(llvmMc,['--disassemble','--triple=aarch64','--mattr=+fullfp16'],{input:`${oracleInput}\n`,encoding:'utf8'});
assert.equal(oracle.status,0,oracle.stderr);assert.doesNotMatch(oracle.stdout,/<unknown>/i);
for(const mnemonic of ARM64_FP_EFFECT_MNEMONICS)assert.match(oracle.stdout,new RegExp(`\\b${mnemonic}\\b`),`LLVM oracle omitted ${mnemonic}`);

const forms=spawnSync(llvmMc,['--triple=aarch64','--mattr=+fullfp16','--show-encoding'],{
  input:'fmov h0, #1.0\nfmov w0, h1\nfmov h0, w1\nscvtf d0, w1, #32\nfcvtzu x0, h1, #64\nfccmpe h0, h1, #15, nv\n',encoding:'utf8',
});
assert.equal(forms.status,0,forms.stderr);assert.equal([...forms.stdout.matchAll(/encoding: \[/g)].length,6);
assert.equal(new Set(ARM64_A64_FP_ENCODING_FAMILIES.map(({id})=>id)).size,67);
console.log(`ARM64 A64 FP denominator (${count} finite discriminator cases): PASS`);
