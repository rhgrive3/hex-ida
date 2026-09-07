import assert from 'node:assert/strict';
import { createX86EffectContext } from '../../js/targets/architecture/x86_64/effects/common.js';
import { createX86DecodedInstruction } from '../../js/targets/architecture/x86_64/decoded-instruction.js';
import { x86RegisterDescriptor, x86RegisterFile } from '../../js/targets/architecture/x86_64/registers.js';

function context(id) {
  return createX86EffectContext({
    address:0x900000n,
    length:1,
    rawBytes:Uint8Array.of(0x90),
    mode:'long-64',
    instructionCode:1,
    instructionFamily:'shared-state-proof',
    instructionId:id,
    detailAvailable:true,
    detailStatus:'complete',
    mnemonic:'nop',
    opStr:'',
    detail:{ operandCount:0, operands:[], prefixes:{ legacy:[], rex:null, vector:null }, implicitReads:[], implicitWrites:[], conditionCode:null },
  }, { instructionId:id });
}

{
  const zmm0=x86RegisterDescriptor('zmm0');
  assert.equal(zmm0.viewBits,512);
  assert.deepEqual(zmm0.compositeParts.map(({physicalId,bits,lsb})=>[physicalId,bits,lsb]), [
    ['ymm0',256,0], ['zmmh0',256,256],
  ]);
  const ctx=context('x86-shared-state:zmm-read-write');
  const value=ctx.readRegister('zmm0');
  assert.ok(value);
  assert.equal(ctx.operations.filter((op)=>op.kind==='register-read'&&op.register.registerId==='ymm0').length,1);
  assert.equal(ctx.operations.filter((op)=>op.kind==='register-read'&&op.register.registerId==='zmmh0').length,1);
  assert.equal(ctx.writeRegister('zmm0',value),true);
  assert.equal(ctx.operations.filter((op)=>op.kind==='register-write'&&op.register.registerId==='ymm0').length,1);
  assert.equal(ctx.operations.filter((op)=>op.kind==='register-write'&&op.register.registerId==='zmmh0').length,1);
  assert.ok(ctx.operations.some((op)=>op.kind==='value'&&op.opcode==='insert'&&op.metadata?.compositePartLsb===undefined));
}

{
  const ctx=context('x86-shared-state:opmask');
  const value=ctx.readRegister('k7');
  assert.ok(value);
  assert.equal(value.valueType.widthBits,64);
  assert.equal(ctx.writeRegister('k7',value),true);
  assert.equal(ctx.operations.some((op)=>op.kind==='register-read'&&op.register.registerId==='k7'),true);
  assert.equal(ctx.operations.some((op)=>op.kind==='register-write'&&op.register.registerId==='k7'),true);
}

{
  const st3=x86RegisterDescriptor('st(3)');
  const mm3=x86RegisterDescriptor('mm3');
  assert.equal(st3.physicalId,'x87-stack');
  assert.equal(mm3.physicalId,'x87-stack');
  assert.equal(mm3.lsb,240);
  const ctx=context('x86-shared-state:x87');
  const st=ctx.readRegister('st(3)');
  assert.ok(st);
  assert.equal(st.valueType.widthBits,80);
  assert.ok(ctx.operations.some((op)=>op.kind==='register-read'&&op.register.registerId==='x87-stack'));
  assert.ok(ctx.operations.some((op)=>op.kind==='register-read'&&op.register.registerId==='fpsw'));
  const select=ctx.operations.find((op)=>op.kind==='value'&&op.opcode==='x87-stack-select');
  assert.equal(select.metadata.logicalIndex,3);
  assert.equal(ctx.writeRegister('st(3)',st),true);
  assert.ok(ctx.operations.some((op)=>op.kind==='value'&&op.opcode==='x87-stack-insert'&&op.metadata.logicalIndex===3));
  assert.ok(ctx.operations.some((op)=>op.kind==='register-write'&&op.register.registerId==='x87-stack'));
}

{
  const ctx=context('x86-shared-state:mmx-alias');
  const mm=ctx.readRegister('mm5');
  assert.ok(mm);
  assert.equal(mm.valueType.widthBits,64);
  const extract=ctx.operations.find((op)=>op.kind==='value'&&op.opcode==='extract'&&op.metadata?.view==='mm5');
  assert.equal(extract.metadata.lsb,400);
  assert.equal(ctx.writeRegister('mm5',mm),true);
  const insert=ctx.operations.find((op)=>op.kind==='value'&&op.opcode==='insert'&&op.metadata?.view==='mm5');
  assert.equal(insert.metadata.lsb,400);
  assert.ok(ctx.operations.some((op)=>op.kind==='register-write'&&op.register.registerId==='x87-stack'));
}

const file=x86RegisterFile();
assert.equal(file.some((entry)=>entry.id==='zmmh31'&&entry.bits===256),true);
assert.equal(file.some((entry)=>entry.id==='x87-stack'&&entry.bits===640),true);
assert.equal(file.some((entry)=>entry.id==='k0'&&entry.bits===64),true);


{
  const decoded=createX86DecodedInstruction({address:0x900100n,length:6,rawBytes:Uint8Array.from([0x62,0xf1,0x65,0x49,0xfe,0xd4]),mode:'long-64',instructionCode:2,instructionFamily:'vpaddd',instructionId:'x86-shared-state:opmask-narrow',detailAvailable:true,detailStatus:'complete',detail:{operandCount:1,operands:[{type:'register',register:'k1',widthBits:16,access:'read'}],prefixes:{legacy:[],rex:null,vector:{kind:'evex',bytes:[0x62,0xf1,0x65,0x49]}},implicitReads:[],implicitWrites:[]}});
  const mask=decoded.detail.operands[0].register;
  assert.equal(mask.id,'k1');assert.equal(mask.physicalId,'k1');assert.equal(mask.physicalBits,64);assert.equal(mask.viewBits,16);assert.equal(mask.decoderNarrowView,true);
}

console.log('x86 shared register state: PASS');
