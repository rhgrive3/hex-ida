import assert from 'node:assert/strict';
import test from 'node:test';
import { liftDexMethod } from '../../../js/managed/dex/lifter.js';
import { captureDexValidationMetadata, validateDexMethod } from '../../../js/managed/dex/validation.js';
import { lowerVMEffectsToSemanticIr } from '../../../js/managed/shared/bridge-v2.js';
import { DexFrontend } from '../../../js/managed/dex/frontend.js';
import { buildDex, dexMethod } from '../fixtures/medium-dex.mjs';

const first = fn => fn.bundles.find(b => b.bytecodeOffset === 0);
const lift = (words, options={}) => liftDexMethod(0, dexMethod(words, { registers:8, types:['LTest;','[I','Ljava/lang/String;','[Ljava/lang/String;'], ...options }));

test('#5302 monitor/type/array allocation core ops carry explicit VM effects', () => {
  let b=first(lift([0x001d,0x000e]));
  assert.equal(b.mnemonic,'monitor-enter'); assert.equal(b.completeness,'exact'); assert.equal(b.locationReads[0].index,0);
  b=first(lift([0x001e,0x000e])); assert.equal(b.mnemonic,'monitor-exit'); assert.ok(b.possibleExceptions.includes('java/lang/IllegalMonitorStateException'));
  b=first(lift([0x001f,2,0x000e])); assert.equal(b.mnemonic,'check-cast'); assert.equal(b.metadata.typeDescriptor,'Ljava/lang/String;');
  b=first(lift([0x1020,2,0x000e])); assert.equal(b.mnemonic,'instance-of'); assert.equal(b.locationReads[0].index,1); assert.equal(b.locationWrites[0].index,0);
  b=first(lift([0x1021,0x000e])); assert.equal(b.mnemonic,'array-length'); assert.ok(b.possibleExceptions.includes('java/lang/NullPointerException'));
  b=first(lift([0x1023,1,0x000e])); assert.equal(b.mnemonic,'new-array'); assert.equal(b.metadata.arrayType,'[I'); assert.equal(b.metadata.allocationSiteId,b.operationId);
  const lowered=lowerVMEffectsToSemanticIr(lift([0x1023,1,0x000e])), ir=lowered.semanticIr;
  assert.ok(ir.nodes.some(n=>n.operator==='managed.dex.new-array'));
  assert.equal(ir.nodes.find(n=>n.operator==='managed.dex.new-array')?.attributes?.arrayType,'[I');
});

test('#5302 aget/aput variants bind array base/index/value and storage widths', () => {
  const widths=[4,8,4,1,1,2,2], exts=[null,null,null,'zero','sign','zero','sign'];
  for(let v=0;v<7;v++) for(const write of [false,true]) {
    const op=0x44+v+(write?7:0), words=[op,0x0201,0x000e], b=first(lift(words));
    assert.equal(b.completeness,'exact'); assert.equal(b.memoryEffects[0].byteWidth,widths[v]); assert.equal(b.memoryEffects[0].extension,exts[v]);
    assert.equal(b.memoryEffects[0].addressKind,'array-element'); assert.equal(b.locationReads[0].index,1); assert.equal(b.locationReads[1].index,2);
    const ir=lowerVMEffectsToSemanticIr(lift(words)).semanticIr;
    assert.ok(ir.nodes.some(n=>n.operator==='managed.dex.array-element-address'));
    const mem=ir.nodes.find(n=>n.kind===(write?'store':'load')); assert.ok(mem);
    assert.ok(mem.memory.faults.some(f=>f.kind==='null-reference')); assert.ok(mem.memory.faults.some(f=>f.kind==='array-bounds'));
  }
});

test('#5302 filled-new-array publishes implicit result and range register sequence without monitor effects', () => {
  let fn=lift([0x2024,3,0x0010,0x000c,0x000e]);
  let b=first(fn); assert.equal(b.mnemonic,'filled-new-array'); assert.deepEqual(b.locationReads.map(r=>r.index),[0,1]); assert.deepEqual(b.controlEffects,[]);
  const move=fn.bundles.find(x=>x.bytecodeOffset===6); assert.equal(move.mnemonic,'move-result-object'); assert.equal(move.completeness,'exact');
  const meta=captureDexValidationMetadata(0,dexMethod([0x2024,3,0x0010,0x000c,0x000e],{registers:8,types:['LTest;','[I','Ljava/lang/String;','[Ljava/lang/String;']}));
  const checked=validateDexMethod({...fn,metadata:{...fn.metadata,dexValidation:meta}}); assert.equal(checked.errors.some(e=>e.code==='dex-move-result-without-producer'),false);
  fn=lift([0x0225,3,4,0x000c,0x000e],{registers:8}); b=first(fn); assert.equal(b.mnemonic,'filled-new-array/range'); assert.deepEqual(b.locationReads.map(r=>r.index),[4,5]); assert.deepEqual(b.controlEffects,[]);
});

test('#5302 fill-array-data validates payload identity/alignment and stays fail-closed as bulk summary', () => {
  const valid=[0x0026,4,0,0x000e,0x0300,1,3,0,0x0201,0x0003];
  let b=first(lift(valid)); assert.equal(b.mnemonic,'fill-array-data'); assert.equal(b.completeness,'partial'); assert.equal(b.memoryEffects[0].elementCount,3); assert.equal(b.unknownEffects[0].reason,'dex-fill-array-data-bulk-write-summary');
  let ir=lowerVMEffectsToSemanticIr(lift(valid)).semanticIr; assert.ok(ir.nodes.some(n=>n.operator==='managed.dex.fill-array-data-payload')); assert.ok(ir.nodes.some(n=>n.kind==='store'));
  b=first(lift([0x0026,3,0,0x000e,0x0300,1,0,0])); assert.equal(b.completeness,'partial'); assert.equal(b.unknownEffects[0].reason,'dex-fill-array-data-payload-misaligned'); assert.deepEqual(b.memoryEffects,[]);
});

test('#5302 validator scans array/type op widths and full DEX pipeline reaches array MemorySSA', async () => {
  const meta=captureDexValidationMetadata(0,dexMethod([0x0044,0x0201,0x000e],{registers:3}));
  assert.equal(meta.facts[0].opcode,0x44); assert.equal(meta.facts[0].width,2);
  const built=buildDex({fields:[],classNames:['LTest;'],methods:[{classType:'LTest;',name:'get',returnType:'I',params:['[I','I'],flags:9,registers:3,ins:2,words:[0x0044,0x0201,0x000f]}]});
  const frontend=new DexFrontend(), image=await frontend.open(built.bytes,{binaryId:'issue-5302'}), methods=[];
  for await(const m of frontend.enumerateMethods(image))methods.push(m);
  const decoded=await frontend.decodeMethod(methods[0],{image}); const validation=await frontend.validateMethod(decoded,{image}); assert.notEqual(validation.status,'invalid');
  const lowered=lowerVMEffectsToSemanticIr(decoded); assert.ok(lowered.ssa); assert.ok(lowered.semanticIr.nodes.some(n=>n.kind==='load'&&n.memory?.addressSpace==='array-element')); assert.ok(lowered.semanticIr.nodes.some(n=>n.operator==='managed.dex.array-element-address'));
});
