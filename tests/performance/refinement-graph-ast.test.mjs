import test from 'node:test';
import assert from 'node:assert/strict';
import * as graph from '../../js/graph-routing.js';
import * as oldGraph from '../helpers/refinement-baseline/js/graph-routing.js';
import * as ast from '../../js/decompiler/ast/nodes.js';
import * as oldAst from '../helpers/refinement-baseline/js/decompiler/ast/nodes.js';
import {RewriteEngine} from '../../js/decompiler/rewrite/engine.js';
import {RewriteEngine as OldEngine} from '../helpers/refinement-baseline/js/decompiler/rewrite/engine.js';
const rnd=(()=>{let x=0x410249;return ()=>{x=(Math.imul(x,1664525)+1013904223)>>>0;return x;};})();
const nodes=n=>Array.from({length:n},(_,id)=>({id,title:`B${id}`,lines:Array.from({length:id%5},(_,j)=>`op${j}`)}));
function compareGraph(n,edges){assert.deepStrictEqual(graph.graphRoutingDiagnostics(nodes(n),edges),oldGraph.graphRoutingDiagnostics(nodes(n),edges));}
test('refinement: graph coordinates, ports and route order match on 150 randomized CFGs',()=>{
 for(let t=0;t<150;t++){const n=rnd()%45;const e=Array.from({length:rnd()%120},()=>({from:rnd()%(n+2),to:rnd()%(n+2),kind:rnd()%7?'jump':'back'}));compareGraph(n,e);}
});
test('refinement: large queues, dense fanout, fanin, back edges and self edges preserve geometry',()=>{
 for(const n of [0,1,20,160,1100])compareGraph(n,Array.from({length:Math.max(0,n-1)},(_,i)=>({from:0,to:i+1,kind:'jump'})));
 const n=160,e=[];for(let i=1;i<n;i++){e.push({from:0,to:i});e.push({from:i,to:n});}compareGraph(n+1,e);
 compareGraph(30,Array.from({length:30},(_,i)=>({from:i,to:i,kind:'back'})));
});
test('refinement: source identity merge preserves invalid filtering, type and zero sign',()=>{
 const vals=[null,undefined,NaN,Infinity,-1,-0,0,1,0n,1n,'','0','1',[],{},true,Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER+1];
 for(let t=0;t<100;t++){const sources=Array.from({length:3},()=>Object.fromEntries(['addresses','rows','ir','ssaDefs','ssaUses','evidence'].map(k=>[k,Array.from({length:50},()=>vals[rnd()%vals.length])])));assert.deepStrictEqual(ast.mergeSource(...sources),oldAst.mergeSource(...sources));}
});
function tree(n) {let root={kind:'var',name:'x',bits:64};for(let i=0;i<n;i++)root={kind:'binary',op:'+',left:root,right:{kind:'const',value:0n,bits:64},bits:64};return root;}
test('refinement: AST traversal preserves skewed, shared, cyclic and memory-version keys',()=>{
 for(const n of [0,1,20,5000]) {const root=tree(n);assert.equal(ast.structuralKey(root),oldAst.structuralKey(root));}
 const shared=tree(8),dag={kind:'binary',op:'*',left:shared,right:shared,bits:32};assert.equal(ast.structuralKey(dag),oldAst.structuralKey(dag));
 const cycle={kind:'unary',op:'-',bits:64};cycle.arg=cycle;assert.equal(ast.structuralKey(cycle),oldAst.structuralKey(cycle));
 for(const memoryVersion of ['m1','m2',1,1n]){const load={kind:'load',location:'x',memoryVersion,bits:32};assert.equal(ast.structuralKey(load),oldAst.structuralKey(load));}
});
function run(Engine,root,budget={},abortAt=Infinity){const calls=[];let ticks=0;
 const rules=[{name:'add-zero',phase:'fold',match(n){calls.push(`match:${n.kind}`);return n.kind==='binary'&&n.op==='+'&&n.right?.value===0n;},rewrite(n){calls.push('rewrite');return n.left;},proof:'identity'}];
 const r=new Engine(rules,{deterministic:true,...budget}).rewrite(root,{shouldAbort(){ticks++;return ticks>=abortAt;}});delete r.stats.elapsedMs;return {r,calls,ticks};}
test('refinement: rewrite proof, callback order, work limits and cancellation are unchanged',()=>{
 for(const budget of [{},{maxApplications:0},{maxApplications:3},{maxIterations:0},{maxIterations:1},{nodeBudget:8}])for(const abortAt of [Infinity,1,5,37])assert.deepStrictEqual(run(RewriteEngine,tree(12),budget,abortAt),run(OldEngine,tree(12),budget,abortAt));
});
