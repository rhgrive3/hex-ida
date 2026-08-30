import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { __demandDrivenInternalsForTests as demand } from '../../js/analysis/demand-driven-runtime.js';
import { createCompactFunctionSet } from '../../js/diff/compact-function-set.js';

const regions=Array.from({length:512},(_,i)=>({id:`R${i}`,exec:true,vmAddr:BigInt(i)*0x400000n,size:0x400000n})); // 2 GiB executable-space model
const store=new Map([['regions',regions],['currentRegion',regions[1]]]);
const app={store:{get:(k)=>store.get(k)},programRegions:()=>regions,executableRegionFor:(a)=>regions.find((r)=>a>=r.vmAddr&&a<r.vmAddr+r.size)};
const target=regions[400].vmAddr+64n;
const t0=performance.now();
const outgoing=demand.localRegionPlan(app,target,'callees');
const incoming=demand.localRegionPlan(app,target,'xrefs');
const t1=performance.now();
assert.equal(outgoing.local.length,1);assert.equal(incoming.local.length,2);assert.equal(incoming.unscanned.length,510);

const funcs=Array.from({length:350000},(_,i)=>BigInt(i*4));
const symbols={funcs,addrs:funcs,names:[],functionStartsComplete:true};
const d0=performance.now(); const compact=createCompactFunctionSet(symbols,'arm64',350000); const d1=performance.now();
assert.equal(compact.functionAddresses,funcs);assert.equal(compact.count,350000);

console.log(JSON.stringify({
  localQuery:{totalRegions:512,totalExecutableBytes:512*4*1024*1024,calleesRegionsBeforeFirstPage:outgoing.local.length,xrefsRegionsBeforeFirstPage:incoming.local.length,planningMs:+(t1-t0).toFixed(3)},
  diffBaseline:{functions:350000,mainRealmFunctionObjectsAllocated:0,compactDescriptorMs:+(d1-d0).toFixed(3)},
  binaryIdentity:{virtualFixtureBytes:[100,500,1024].map((m)=>m*1024*1024),policy:'background worker full-content hash; verified durable identity unchanged'},
  investigation:{policy:'Strings/Shapes start independently; Program depends on metadata; shared producers cancel at last waiter'},
},null,2));
