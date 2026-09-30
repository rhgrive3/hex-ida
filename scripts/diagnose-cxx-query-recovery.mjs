#!/usr/bin/env node
// Read-only release-only diagnosis. This is never accuracy/passing evidence.
import fs from 'node:fs';
import {openProduct} from '../tools/validation/public-benchmark/product-host.mjs';
import {recoverCxxMembersForQuery} from '../js/analysis/query/app-adapter.js';
const [binary,manifestFile]=process.argv.slice(2);
const manifest=JSON.parse(fs.readFileSync(manifestFile));
const c=manifest.cases[0];
console.log(JSON.stringify({phase:'opening',id:c.id,query:c.query}));
const product=await openProduct(binary);
console.log(JSON.stringify({phase:'opened',profile:product.profile}));
const api=product.app.analysisQueries,original=api.decompile.bind(api);
api.decompile=async(snapshot,address,options)=>{
  console.log(JSON.stringify({phase:'function-start',address:String(address),name:product.app.symbols.nameAt(address),options}));
  const start=performance.now();const result=await original(snapshot,address,options);
  console.log(JSON.stringify({phase:'function-end',address:String(address),elapsedMs:performance.now()-start}));
  return result;
};
try {
  const result=await recoverCxxMembersForQuery(product.app,c.query,{enabled:true,maxFunctions:8,maxElapsedMs:15000});
  console.log(JSON.stringify({phase:'query-end',status:result.status,elapsedMs:result.elapsedMs,attempted:result.attempted.length}));
} finally {await product.close();}
