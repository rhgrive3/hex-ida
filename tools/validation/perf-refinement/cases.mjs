/** Complementary component benchmarks; not a replacement for the fixed end-to-end sum. */
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
export async function createCases(rootArg) {
const root=path.resolve(rootArg),load=p=>import(pathToFileURL(path.join(root,p)));
const {fnv64Bytes,fnv64ByteView}=await load('js/core/identity/fnv64.js');
const {stableStringify,stableDigest,deepFreeze,jsonSafe}=await load('js/core/identity/index.js');
const origin=await load('js/core/identity/origin.js');
const graph=await load('js/graph-routing.js');
const ast=await load('js/decompiler/ast/nodes.js');
const {RewriteEngine}=await load('js/decompiler/rewrite/engine.js');
const rows=[];
function bench(id,iterations,fn){rows.push({id,iterations,fn});}
for(const [n,iterations] of [[0,8000],[32,8000],[4095,250],[4096,250],[4194304,2]]) {
 const data=Uint8Array.from({length:n},(_,i)=>(i*179+i%31)&255);
 bench(`bytes-${n}`,iterations,()=>fnv64Bytes(data));
 if(n===4194304)bench('byte-view-4MiB',2,()=>fnv64ByteView(data));
}
const raw=Array.from({length:32},(_,j)=>({instructionIds:Array.from({length:64},(_,i)=>`i${i+j*31}`),operationIds:[`o${j}`],sourceLocations:[{file:'file.c',line:j}]}));
const sets=raw.map(origin.createOriginSet);
bench('origin-create-small',200,()=>origin.createOriginSet({instructionIds:['a','b','a'],sourceLocations:[{line:1}]}));
bench('origin-merge-two',100,()=>origin.mergeOriginSets(sets[0],sets[1]));
bench('origin-merge-32',8,()=>origin.mergeOriginSets(...sets));
const document=deepFreeze({tag:'sample',rows:Array.from({length:128},(_,i)=>({index:i,id:`r${i}`,flags:[true,false],value:BigInt(i)}))});
bench('identity-cold',150,i=>stableDigest({tag:`doc${i}`,value:[{a:17n,b:3},{x:'abc',y:[1,2,3]}]}));
bench('identity-warm',150,()=>stableDigest(document));
for(const n of [8,128,4096]){const text='x'.repeat(n);bench(`identity-text-${n}`,200,()=>stableDigest(text));}
bench('json-fresh-copy',100,()=>jsonSafe(document));
const graphInputs=[];
for(const [kind,n,iterations]of [['small',16,50],['chain',512,2],['fanout',512,2],['mixed',128,2]]){
 const nodes=Array.from({length:n},(_,id)=>({id,title:`B${id}`,lines:[`op${id}`,`value${id}`]}));
 const edges=[];
 if(kind==='fanout')for(let i=1;i<n;i++)edges.push({from:0,to:i,kind:'jump'});
 else for(let i=0;i<n-1;i++){edges.push({from:i,to:i+1,kind:'jump'});if(kind==='mixed'&&i%3===0){edges.push({from:0,to:i,kind:'jump'});edges.push({from:i,to:Math.max(0,i-4),kind:'back'});}}
 graphInputs.push([kind,nodes,edges,iterations]);
}
for(const[kind,nodes,edges,iterations]of graphInputs)bench(`graph-${kind}`,iterations,()=>graph.graphRoutingDiagnostics(nodes,edges));
function tree(depth){return depth===0?{kind:'var',name:'x',bits:64}:{kind:'binary',op:'+',left:tree(depth-1),right:tree(depth-1),bits:64};}
for(const[d,iterations]of [[2,2000],[8,40]]){const root=tree(d);bench(`ast-key-depth-${d}`,iterations,()=>ast.structuralKey(root));}
const sources=Array.from({length:8},(_,j)=>({ir:Array.from({length:128},(_,i)=>`i${i+j*50}`),rows:Array.from({length:128},(_,i)=>i+j*31)}));
bench('ast-source-merge',50,()=>ast.mergeSource(...sources));
const rewriteRoot=tree(6),engine=new RewriteEngine([{name:'noop',phase:'fold',match:()=>false,rewrite:n=>n,proof:'identity'}],{deterministic:true});
bench('rewrite-traversal',20,()=>{const r=engine.rewrite(rewriteRoot);delete r.stats.elapsedMs;return r;});
return rows;
}
