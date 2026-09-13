import test from 'node:test';
import assert from 'node:assert/strict';
import {checkSmeCallFrame,SME_CALL_SCHEMA,SME_ABI_MODEL} from '../../js/core/evidence/sme-call-frame.js';
import {workFor} from './helpers.mjs';
const off=()=>({sm:false,za:false,tpidr2:null,zaDigest:null,zt0Digest:null,blockDigest:null});
const dormant=()=>({...off(),za:true,tpidr2:'block',zaDigest:'live-bytes',blockDigest:'unchanged-block'});
const frame=()=>({schema:SME_CALL_SCHEMA,abiModel:SME_ABI_MODEL,interface:{sm:'non-streaming',za:'private',preservesZT0:false},normalReturn:true,svlBytes:16,
  entry:dormant(),exit:dormant(),lazySave:{blockId:'block',sliceCount:3,bufferBytes:256,reservedZero:true,savedDigest:null}});
test('preserved dormant ZA keeps TPIDR2 block and live slices',t=>{const r=checkSmeCallFrame(frame(),{work:workFor(t)});assert.equal(r.status,'verified-model');assert.equal(r.semanticProof,false);assert.equal(r.zaBytes,256);});
test('committed save requires actual live-slice evidence and off return',t=>{const m=frame();m.exit=off();m.lazySave.savedDigest='live-bytes';const r=checkSmeCallFrame(m,{work:workFor(t)});assert.equal(r.status,'verified-model');assert.equal(r.restoration,'required-from-declared-save-buffer');});
for(const [label,mutate,expected] of [
 ['changed block',m=>m.exit.blockDigest='different','rejected'],['missing block evidence',m=>m.exit.blockDigest=null,'unknown'],
 ['changed live slices',m=>m.exit.zaDigest='corrupt','rejected'],['missing live slices',m=>m.exit.zaDigest=null,'unknown'],
 ['wrong save',m=>{m.exit=off();m.lazySave.savedDigest='wrong'},'rejected'],['missing save',m=>m.exit=off(),'unknown'],
 ['unrounded buffer',m=>m.lazySave.bufferBytes=48,'rejected'],['future reserved bits',m=>m.lazySave.reservedZero=false,'unknown'],
 ['streaming changed',m=>m.exit.sm=true,'rejected'],['unsupported ABI',m=>m.abiModel='future','unknown'],
 ['exception not normal',m=>m.normalReturn=false,'unknown'],['lazy save unknown',m=>m.lazySave=null,'unknown'],
 ['new token',m=>m.exit.tpidr2='other','rejected'],['private active return',m=>{m.exit.tpidr2=null;m.exit.blockDigest=null},'rejected'],
 ['off nonnull block unmodeled',m=>{m.entry.za=false;m.entry.zaDigest=null},'unknown']]) {
 test(label,t=>{const m=frame();mutate(m);assert.equal(checkSmeCallFrame(m,{work:workFor(t)}).status,expected);});
}
test('ZT0 is not implicitly covered by ZA lazy saving',t=>{const m=frame();m.entry.zt0Digest='a';m.exit.zt0Digest='b';assert.equal(checkSmeCallFrame(m,{work:workFor(t)}).status,'verified-model');m.interface.preservesZT0=true;assert.equal(checkSmeCallFrame(m,{work:workFor(t)}).status,'rejected');});
test('shared ZA is input/output, not an unchanged array',t=>{const m=frame();m.interface.za='shared';m.lazySave=null;for(const s of [m.entry,m.exit]){s.tpidr2=null;s.blockDigest=null;}m.exit.zaDigest='output';assert.equal(checkSmeCallFrame(m,{work:workFor(t)}).status,'verified-model');});
test('ordinary non-SME off boundary',t=>{const m=frame();m.entry=off();m.exit=off();m.lazySave=null;assert.equal(checkSmeCallFrame(m,{work:workFor(t)}).status,'verified-model');});
for(const mutate of [m=>m.svlBytes=17,m=>m.svlBytes=512,m=>m.lazySave.sliceCount=0,m=>m.entry.za=1,m=>m.entry.inject=true]) test('strict SME '+mutate,t=>{const m=frame();mutate(m);assert.throws(()=>checkSmeCallFrame(m,{work:workFor(t)}));});
