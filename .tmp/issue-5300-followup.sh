#!/usr/bin/env bash
set -euo pipefail
BASE=9a944ba09f317763bd4d20863e3c91c344269be6
git fetch --no-tags --depth=1 origin "$BASE"
git show "$BASE":js/managed/dex/lifter-base.js > js/managed/dex/lifter-base.js
git show "$BASE":js/managed/dex/instruction-boundary.js > js/managed/dex/instruction-boundary.js
cat > js/managed/dex/control-flow.js <<'EOF'
import { decodeDexInstructionBoundary } from './instruction-boundary.js';
const PREDICATES=Object.freeze({0x32:['if-eq','eq'],0x33:['if-ne','ne'],0x34:['if-lt','lt'],0x35:['if-ge','ge'],0x36:['if-gt','gt'],0x37:['if-le','le'],0x38:['if-eqz','eq'],0x39:['if-nez','ne'],0x3a:['if-ltz','lt'],0x3b:['if-gez','ge'],0x3c:['if-gtz','gt'],0x3d:['if-lez','le']});
function target(targetPc,index,insnsSize){if(!Number.isSafeInteger(targetPc)||targetPc<0||targetPc>=insnsSize)return{reason:'dex-branch-target-out-of-range'};const targetOffset=targetPc*2;if(index.instructionOffsets.has(targetOffset))return{targetOffset};return{reason:index.scanComplete?'dex-branch-target-not-instruction-boundary':'dex-control-flow-boundary-authority-incomplete'}}
function failFlow(mnemonic,locationReads,reason){return{mnemonic,locationReads,controlEffects:[],controlEntries:[],reason}}
export function buildDexControlFlowIndex(view,insnsStart,insnsSize){const instructionOffsets=new Set(),payloads=new Map();let at=0,scanComplete=true;while(at<insnsSize){const b=decodeDexInstructionBoundary(view,insnsStart,at,insnsSize),off=at*2;if(b.kind==='instruction')instructionOffsets.add(off);else if(b.kind==='payload')payloads.set(off,{signature:b.signature,length:b.length,mnemonic:b.mnemonic});else scanComplete=false;at+=b.length;if(b.stop)break}if(at!==insnsSize)scanComplete=false;return Object.freeze({instructionOffsets,payloads,scanComplete})}
function direct(view,start,size,pc,op,fmt,index){let mnemonic,disp;if(op===0x28){mnemonic='goto';disp=fmt>=0x80?fmt-0x100:fmt}else if(op===0x29){mnemonic='goto/16';disp=view.getInt16(start+(pc+1)*2,true)}else{mnemonic='goto/32';disp=view.getInt32(start+(pc+1)*2,true)}const t=target(pc+disp,index,size);if(t.reason)return failFlow(mnemonic,[],t.reason);return{mnemonic,locationReads:[],controlEffects:[{kind:'branch',targetOffset:t.targetOffset}],controlEntries:[t.targetOffset],reason:null}}
function conditional(view,start,size,pc,op,fmt,index){const [mnemonic,predicate]=PREDICATES[op],arity=op<=0x37?2:1,t=target(pc+view.getInt16(start+(pc+1)*2,true),index,size),f=target(pc+2,index,size),reads=arity===2?[{kind:'register',index:fmt&15,bits:32},{kind:'register',index:fmt>>>4,bits:32}]:[{kind:'register',index:fmt,bits:32}];if(t.reason)return failFlow(mnemonic,reads,t.reason);if(f.reason)return failFlow(mnemonic,reads,f.reason);return{mnemonic,locationReads:reads,controlEffects:[{kind:'conditional-branch',targetOffset:t.targetOffset,falseTargetOffset:f.targetOffset,condition:{kind:'integer-comparison',predicate,signed:true,arity,compareToZero:arity===1,widthBits:32}}],controlEntries:[t.targetOffset],reason:null}}
function sw(view,start,size,pc,op,fmt,index){const packed=op===0x2b,mnemonic=packed?'packed-switch':'sparse-switch',reads=[{kind:'register',index:fmt,bits:32}],payloadPc=pc+view.getInt32(start+(pc+1)*2,true);if(!Number.isSafeInteger(payloadPc)||payloadPc<0||payloadPc>=size)return failFlow(mnemonic,reads,'dex-switch-payload-out-of-range');if((payloadPc&1)!==0)return failFlow(mnemonic,reads,'dex-switch-payload-misaligned');const payloadOffset=payloadPc*2,payload=index.payloads.get(payloadOffset);if(!payload)return failFlow(mnemonic,reads,index.scanComplete?'dex-switch-payload-not-data-boundary':'dex-control-flow-boundary-authority-incomplete');if(payload.signature!==(packed?1:2))return failFlow(mnemonic,reads,'dex-switch-payload-kind-mismatch');const p=start+payloadOffset,n=view.getUint16(p+2,true),keys=[],disps=[];if(packed){const first=view.getInt32(p+4,true);for(let i=0;i<n;i++){const key=first+i;if(key< -0x80000000||key>0x7fffffff)return failFlow(mnemonic,reads,'dex-packed-switch-key-overflow');keys.push(key);disps.push(view.getInt32(p+8+i*4,true))}}else{let prev=null;for(let i=0;i<n;i++){const key=view.getInt32(p+4+i*4,true);if(prev!=null&&key<=prev)return failFlow(mnemonic,reads,'dex-sparse-switch-keys-not-strictly-increasing');keys.push(key);prev=key}const tb=p+4+n*4;for(let i=0;i<n;i++)disps.push(view.getInt32(tb+i*4,true))}const targets=[];for(const d of disps){const t=target(pc+d,index,size);if(t.reason)return failFlow(mnemonic,reads,t.reason);targets.push(t.targetOffset)}const def=target(pc+3,index,size);if(def.reason)return failFlow(mnemonic,reads,def.reason);return{mnemonic,locationReads:reads,controlEffects:[{kind:'switch',targetOffsets:targets,defaultTargetOffset:def.targetOffset,caseValues:keys,payloadOffset,payloadKind:packed?'packed':'sparse'}],controlEntries:[...targets],reason:null}}
export function decodeDexControlFlow({view,insnsStart,insnsSize,pc,opcode,formatByte,index}){if(opcode>=0x28&&opcode<=0x2a)return direct(view,insnsStart,insnsSize,pc,opcode,formatByte,index);if(opcode===0x2b||opcode===0x2c)return sw(view,insnsStart,insnsSize,pc,opcode,formatByte,index);if(opcode>=0x32&&opcode<=0x3d)return conditional(view,insnsStart,insnsSize,pc,opcode,formatByte,index);return null}
EOF
python3 - <<'PY'
from pathlib import Path
p=Path('js/managed/dex/lifter.js'); s=p.read_text()
old="import { decodeDexInstructionBoundary, decodeDexSwitchTargets } from './instruction-boundary.js';"
new="import { decodeDexInstructionBoundary } from './instruction-boundary.js';\nimport { buildDexControlFlowIndex, decodeDexControlFlow } from './control-flow.js';"
assert old in s; s=s.replace(old,new,1)
a=s.index(' const boundaries=new Set(),controlEntries=new Set();'); b=s.index(' let exceptionRegions=',a)
repl=""" let controlIndex;try{controlIndex=buildDexControlFlowIndex(view,insnsStart,insnsSize)}catch(error){return unavailable(methodIdx,image,error?.message??'dex-invalid-instruction-boundary',options)}
 const boundaries=controlIndex.instructionOffsets,controlEntries=new Set();
 for(const byteOffset of boundaries){const at=byteOffset/2,word=view.getUint16(insnsStart+byteOffset,true),op=word&255,fmt=word>>>8;let flow;try{flow=decodeDexControlFlow({view,insnsStart,insnsSize,pc:at,opcode:op,formatByte:fmt,index:controlIndex})}catch(error){return unavailable(methodIdx,image,error?.message??'dex-invalid-control-flow',options)}for(const target of flow?.controlEntries??[])controlEntries.add(target)}
"""
s=s[:a]+repl+s[b:]
needle="  if(op>=0x01&&op<=0x09){"; assert s.count(needle)==1
overlay="""  let controlFlow=null;try{controlFlow=decodeDexControlFlow({view,insnsStart,insnsSize,pc,opcode:op,formatByte:fmt,index:controlIndex})}catch(error){controlFlow={mnemonic:b.mnemonic,locationReads:[],controlEffects:[],reason:error?.message??'dex-invalid-control-flow'}}
  if(controlFlow){b={...b,mnemonic:controlFlow.mnemonic,consumedValues:[],producedValues:[],locationReads:controlFlow.locationReads,locationWrites:[],memoryEffects:[],callEffects:[],controlEffects:controlFlow.controlEffects,completeness:controlFlow.reason?'partial':'exact',unknownEffects:controlFlow.reason?[{category:'control',categories:['control'],reason:controlFlow.reason}]:[]};}
  else if(op>=0x01&&op<=0x09){"""
s=s.replace(needle,overlay,1); p.write_text(s)
p=Path('js/managed/dex/validation-base.js'); s=p.read_text()
for old,new in [
("if (op === 0x14 || (op >= 0x6e && op <= 0x72)) return 3;","if (op === 0x14 || op === 0x2a || (op >= 0x6e && op <= 0x72)) return 3;"),
("const LOCAL_COMPLETE = new Set([0x00, 0x0e, 0x12, 0x13, 0x14, 0x16, 0x1a, 0x28, 0x29]);","const LOCAL_COMPLETE = new Set([0x00, 0x0e, 0x12, 0x13, 0x14, 0x16, 0x1a, 0x28, 0x29, 0x2a]);"),
("else if (op === 0x29 || (op >= 0x32 && op <= 0x3d)) branch = (pc + sword(1)) * 2;","else if (op === 0x29 || (op >= 0x32 && op <= 0x3d)) branch = (pc + sword(1)) * 2;\n  else if (op === 0x2a) branch = (pc + view.getInt32(start + (pc + 1) * 2, true)) * 2;"),
("last.opcode === 0x28 || last.opcode === 0x29 || (last.opcode >= 0x0e","last.opcode === 0x28 || last.opcode === 0x29 || last.opcode === 0x2a || (last.opcode >= 0x0e")]:
    assert old in s, old; s=s.replace(old,new,1)
p.write_text(s)
PY
cat > tests/phase11/dex/issue-5300-dex-switch-control-flow.test.mjs <<'EOF'
import assert from 'node:assert/strict';
import test from 'node:test';
import { liftDexMethod } from '../../../js/managed/dex/lifter.js';
import { captureDexValidationMetadata, validateDexMethod } from '../../../js/managed/dex/validation.js';
import { decompileManagedMethod, lowerVMEffectsToSemanticIr } from '../../../js/managed/shared/bridge-v2.js';
import { buildDex, dexMethod } from '../fixtures/medium-dex.mjs';
import { DexFrontend } from '../../../js/managed/dex/frontend.js';
const P=new Map([[0x32,['if-eq','eq',2]],[0x33,['if-ne','ne',2]],[0x34,['if-lt','lt',2]],[0x35,['if-ge','ge',2]],[0x36,['if-gt','gt',2]],[0x37,['if-le','le',2]],[0x38,['if-eqz','eq',1]],[0x39,['if-nez','ne',1]],[0x3a,['if-ltz','lt',1]],[0x3b,['if-gez','ge',1]],[0x3c,['if-gtz','gt',1]],[0x3d,['if-lez','le',1]]);
const lift=(words,o={})=>liftDexMethod(0,dexMethod(words,{registers:4,...o}));const first=fn=>fn.bundles.find(b=>b.bytecodeOffset===0);
test('#5300 direct branches and goto/32 verifier authority',()=>{for(const [w,m,t] of [[[0x0228,0,0x000e],'goto',4],[[0x0029,3,0,0x000e],'goto/16',6],[[0x002a,4,0,0,0x000e],'goto/32',8]]){const b=first(lift(w));assert.equal(b.mnemonic,m);assert.equal(b.completeness,'exact');assert.deepEqual(b.controlEffects,[{kind:'branch',targetOffset:t}])}const image=dexMethod([0x002a,1,0,0x0013,1,0x000e],{registers:4}),fn=liftDexMethod(0,image),meta=captureDexValidationMetadata(0,image),v=validateDexMethod({...fn,metadata:{...fn.metadata,dexValidation:meta}});assert.ok(v.errors.some(x=>x.code==='dex-branch-target-not-instruction-boundary'))});
test('#5300 every if family carries predicate and explicit false edge',()=>{for(const [op,[m,p,a]] of P){const fmt=a===2?0x10:0,b=first(lift([(fmt<<8)|op,3,0x000e,0x000e]));assert.equal(b.mnemonic,m);assert.equal(b.completeness,'exact');assert.deepEqual(b.controlEffects[0],{kind:'conditional-branch',targetOffset:6,falseTargetOffset:4,condition:{kind:'integer-comparison',predicate:p,signed:true,arity:a,compareToZero:a===1,widthBits:32}})}assert.match(decompileManagedMethod(lowerVMEffectsToSemanticIr(lift([0x0039,3,0x000e,0x000e]))).pseudocode,/register_0 != 0/)});
test('#5300 aligned packed/sparse switch preserve keys and CFG edges',()=>{for(const [kind,words,keys,targets] of [['packed',[0x002b,4,0,0x000e,0x0100,2,10,0,12,0,13,0,0x000e,0x000e],[10,11],[24,26]],['sparse',[0x002c,4,0,0x000e,0x0200,2,0xfffe,0xffff,7,0,14,0,15,0,0x000e,0x000e],[-2,7],[28,30]]]){const fn=lift(words),c=first(fn).controlEffects[0];assert.equal(c.payloadKind,kind);assert.deepEqual(c.caseValues,keys);assert.deepEqual(c.targetOffsets,targets);assert.equal(c.defaultTargetOffset,6);assert.ok(lowerVMEffectsToSemanticIr(fn).ssa)}});
test('#5300 malformed branch/switch never publish exact edges',()=>{for(const [words,reason] of [[[0x0228,0x0013,1,0x000e],'dex-branch-target-not-instruction-boundary'],[[0x002b,3,0,0x000e,0x0100,0],'dex-switch-payload-misaligned'],[[0x002c,4,0,0x000e,0x0200,2,7,0,0xfffe,0xffff,14,0,15,0,0x000e,0x000e],'dex-sparse-switch-keys-not-strictly-increasing']]){const b=first(lift(words));assert.equal(b.completeness,'partial');assert.deepEqual(b.controlEffects,[]);assert.equal(b.unknownEffects[0]?.reason,reason)}});
test('#5300 aligned packed-switch survives full frontend to decompiler',async()=>{const bytes=buildDex({fields:[],methods:[{classType:'LTest;',name:'flow',returnType:'I',params:['I'],flags:9,registers:3,ins:1,words:[0x002b,6,0,0x1012,0x000f,0,0x0100,2,0,0,3,0,4,0]}]}).bytes,frontend=new DexFrontend(),image=await frontend.open(bytes,{binaryId:'issue-5300'}),methods=[];for await(const m of frontend.enumerateMethods(image))methods.push(m);const decoded=await frontend.decodeMethod(methods[0],{image}),validation=await frontend.validateMethod(decoded,{image});assert.notEqual(validation.status,'invalid');const low=lowerVMEffectsToSemanticIr(decoded);assert.ok(low.ssa);assert.match(decompileManagedMethod(low).pseudocode,/switch_dispatch\(register_0,/)});
EOF
timeout 90s node --test tests/phase11/dex/issue-5300-dex-switch-control-flow.test.mjs
timeout 60s node tests/phase11/dex/issue-1136-dex-arithmetic-produced-value.test.mjs
timeout 60s node tests/phase11/dex/issue-7981-receiver-null-npe.test.mjs
timeout 60s node tests/phase11/dex/issue-8977-dex-field-memory-overlay-index.test.mjs
timeout 120s npm run module-boundaries:test
timeout 180s npm run lint
rm .github/workflows/tmp-issue-5300-followup.yml .tmp/issue-5300-followup.sh
git add -A
git config user.name 'github-actions[bot]'
git config user.email '41898282+github-actions[bot]@users.noreply.github.com'
git commit -m 'fix(dex): preserve current contracts in #5300 control flow follow-up'
git push origin HEAD:fix/issue-5300-current-contract-followup-20260917
