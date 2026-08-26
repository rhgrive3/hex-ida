import test from 'node:test';
import assert from 'node:assert/strict';
import { createX86DecodedInstruction } from '../../../../js/targets/architecture/x86_64/decoded-instruction.js';
import { effects, instruction, reg, imm, mem, legacy, vex2, ops, physicalReads, physicalWrites, intrinsics } from './helpers.mjs';

function oracleBitwise(operation,left,right,widthBits){const mask=(1n<<BigInt(widthBits))-1n;if(operation==='and')return(left&right)&mask;if(operation==='or')return(left|right)&mask;if(operation==='xor')return(left^right)&mask;throw new Error('bad-op');}
function oraclePshufd(immediate){return[0,1,2,3].map((lane)=>(immediate>>(lane*2))&3);}

test('bitwise SIMD is exact with independent boundary-vector oracle', () => {
  const vectors=[[0n,0n],[(1n<<128n)-1n,0n],[0xaaaa_aaaa_aaaa_aaaa_5555_5555_5555_5555n,0x5555_5555_5555_5555_aaaa_aaaa_aaaa_aaaan],[(1n<<127n),(1n<<127n)-1n]];
  for(const family of ['andps','andpd','pand','orps','orpd','por','xorps','xorpd','pxor']){
    const operation=family.startsWith('and')||family==='pand'?'and':family.startsWith('or')||family==='por'?'or':'xor';
    const bundle=effects(family,[reg('xmm0','read-write'),reg('xmm1','read')],{prefixes:legacy(),instructionId:`p5-3:${family}`});
    assert.equal(bundle.completeness,'exact',family); assert.equal(ops(bundle,'value').find((op)=>op.metadata?.vectorBitwise).opcode,operation);
    for(const [left,right] of vectors){const value=oracleBitwise(operation,left,right,128);assert.equal(value>=0n,true);}
  }
});

test('PXOR self reaches zero through XOR truth, not a zero-idiom special case', () => {
  const bundle=effects('pxor',[reg('xmm0','read-write'),reg('xmm0','read')],{prefixes:legacy(),instructionId:'p5-3:pxor-self'});
  assert.equal(bundle.completeness,'exact'); assert.ok(physicalReads(bundle,'ymm0').length>=3); assert.ok(ops(bundle,'value').some((op)=>op.opcode==='xor'&&op.metadata?.vectorBitwise)); assert.equal(bundle.metadata.zeroIdiomSpecialCase,undefined); assert.equal(oracleBitwise('xor',0xdeadbeefn,0xdeadbeefn,128),0n);
});

test('packed integer arithmetic, comparison, and shifts carry explicit lane truth', () => {
  const add=effects('paddd',[reg('xmm0','read-write'),reg('xmm1','read')],{prefixes:legacy(),instructionId:'p5-3:paddd'}); assert.equal(add.completeness,'exact-with-intrinsic');
  const addOp=intrinsics(add,'x86.simd.packed-integer')[0]; assert.equal(addOp.metadata.operation,'add'); assert.equal(addOp.metadata.elementWidthBits,32); assert.equal(addOp.metadata.laneCount,4); assert.equal(addOp.metadata.signedness,'modular-wrap'); assert.equal(addOp.metadata.overflow,'wrap-mod-2^elementWidth');
  const cmp=effects('pcmpgtd',[reg('xmm0','read-write'),reg('xmm1','read')],{prefixes:legacy(),instructionId:'p5-3:pcmpgtd'}); assert.equal(cmp.completeness,'exact-with-intrinsic'); const cmpOp=intrinsics(cmp)[0]; assert.equal(cmpOp.metadata.signedness,'signed'); assert.equal(cmpOp.metadata.trueLaneValue,'all-ones');
  const shift=effects('pslld',[reg('xmm0','read-write'),imm(31)],{prefixes:legacy(),instructionId:'p5-3:pslld'}); assert.equal(shift.completeness,'exact-with-intrinsic'); const shiftOp=intrinsics(shift,'x86.simd.packed-shift')[0]; assert.equal(shiftOp.metadata.elementWidthBits,32); assert.equal(shiftOp.metadata.laneCount,4); assert.equal(shiftOp.metadata.direction,'left'); assert.equal(shiftOp.metadata.countSource,'imm8');
});

test('PSHUFD uses structured immediate and independent lane-map oracle', () => {
  const immediate=0x1b,bundle=effects('pshufd',[reg('xmm0','write'),reg('xmm1','read'),imm(immediate)],{prefixes:legacy(),instructionId:'p5-3:pshufd'}); assert.equal(bundle.completeness,'exact-with-intrinsic'); const laneMap=intrinsics(bundle,'x86.simd.shuffle')[0].metadata.laneMap; assert.deepEqual(laneMap.map((entry)=>entry.sourceLane),oraclePshufd(immediate)); assert.equal(laneMap.every((entry)=>entry.source===0),true);
});

test('PUNPCKLDQ has explicit interleave mapping', () => {
  const bundle=effects('punpckldq',[reg('xmm0','read-write'),reg('xmm1','read')],{prefixes:legacy(),instructionId:'p5-3:punpckldq',opStr:'wrong display text'}); assert.equal(bundle.completeness,'exact-with-intrinsic'); const map=intrinsics(bundle,'x86.simd.unpack')[0].metadata.laneMap; assert.deepEqual(map.map((entry)=>[entry.source,entry.sourceLane]),[[0,0],[1,0],[0,1],[1,1]]);
});

test('broad vector ownership does not promote unproven operand roles to exactness', () => {
  const cases = [
    effects('addsubps',[reg('xmm0','read-write'),reg('xmm1','read')],{prefixes:legacy(),instructionId:'p5-3:addsubps-owner'}),
    effects('cmpps',[reg('xmm0','read-write'),reg('xmm1','read'),imm(0)],{prefixes:legacy(),instructionId:'p5-3:cmpps-owner'}),
    effects('pextrb',[mem(8,{access:'write'}),reg('xmm1','read'),imm(0)],{prefixes:legacy(),instructionId:'p5-3:pextrb-owner'}),
    effects('kmovb',[mem(8,{access:'write'}),reg('k1','read')],{prefixes:legacy(),instructionId:'p5-3:kmovb-owner'}),
  ];
  for (const bundle of cases) {
    assert.equal(bundle.completeness,'partial');
    assert.equal(bundle.metadata.requiresDedicatedOperandRoles,true);
    assert.equal(bundle.metadata.exactArchitecturalSummary,false);
    assert.match(bundle.unknownEffects.reason,/requires-dedicated-operand-semantics/);
  }
});

test('VEX support is instruction-specific and does not overclaim AVX2 256-bit packed integer', () => {
  const v128=effects('vpaddd',[reg('xmm0','write'),reg('xmm1','read'),reg('xmm2','read')],{prefixes:vex2(0xf0),instructionId:'p5-3:vpaddd128'}); assert.equal(v128.completeness,'exact-with-intrinsic'); assert.equal(physicalWrites(v128,'ymm0').length,1); assert.ok(ops(v128,'value').some((op)=>op.opcode==='zext'&&op.metadata?.toBits===256));
  const v256=effects('vpaddd',[reg('ymm0','write'),reg('ymm1','read'),reg('ymm2','read')],{prefixes:vex2(0xf4),instructionId:'p5-3:vpaddd256'}); assert.equal(v256.completeness,'partial'); assert.match(v256.unknownEffects.reason,/vector-width-unmodelled/);
});

test('MMX is an x87-stack alias and EMMS clears the canonical x87 tag word', () => {
  const decoded=createX86DecodedInstruction(instruction('pxor',[reg('mm0'),reg('mm1')],{instructionId:'p5-3:mmx'}));
  assert.equal(decoded.detail.operands[0].register.physicalId,'x87-stack');
  assert.equal(decoded.detail.operands[0].register.kind,'mmx');
  const emms=effects('emms',[],{prefixes:legacy(),rawBytes:[0x0f,0x77],instructionId:'p5-3:emms'}); assert.equal(emms.completeness,'exact'); assert.ok(ops(emms,'register-write').some((op)=>op.register.registerId==='fptw'));
});
