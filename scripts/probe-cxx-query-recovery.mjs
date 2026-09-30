#!/usr/bin/env node
// Release-only development probe. Queries are the sole selection input;
// gold, debug metadata and evaluation names are never read here.
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {openProduct} from '../tools/validation/public-benchmark/product-host.mjs';
import {recoverCxxMembersForQuery,cxxMemberIndexForApp} from '../js/analysis/query/app-adapter.js';
import {pinpointField,jevShortlist} from '../js/pinpoint.js';
import {parseGoal} from '../js/goals.js';
import {persistentWrite,sha256} from './jev-realgame-final-contract.mjs';

import {recoverySnapshot} from './jev-realgame-recovery-contract.mjs';

const [binaryPath,queriesFile,destination]=process.argv.slice(2);
if(!binaryPath||!queriesFile||!destination)throw new Error('usage: BINARY QUERIES_JSON OUTPUT');
const bytes=fs.readFileSync(binaryPath),binarySha256=sha256(bytes),queryBytes=fs.readFileSync(queriesFile);
const queries=JSON.parse(queryBytes);
if(!Array.isArray(queries)||!queries.length||queries.some(c=>!c.id||typeof c.query!=='string'))throw new Error('invalid queries');
const product=await openProduct(binaryPath);
if(product.unsupported)throw new Error(product.reason);
try {
  const rows=[];
  for(const c of queries) {
    const beforeCount=cxxMemberIndexForApp(product.app)?.fieldCount??0;
    const recovery=await recoverCxxMembersForQuery(product.app,c.query,{enabled:true,maxFunctions:8,maxElapsedMs:120000});
    const index=cxxMemberIndexForApp(product.app);
    const start=performance.now();
    const hex=await pinpointField({goal:parseGoal(c.query),fields:product.app.fields,cxxFields:index,limit:400});
    const hexLatencyMs=performance.now()-start;
    const candidates=hex.candidates.map(s=>recoverySnapshot(s,product.app.symbols,binarySha256));
    const byKey=new Map(candidates.map(s=>[s.key,s]));
    rows.push({id:c.id,query:c.query,binarySha256,beforeCount,recovery,candidateCount:candidates.length,
      verdict:hex.verdict,topKey:hex.top?.key??null,candidates,shortlist:jevShortlist(hex.candidates,{max:255}).map(s=>byKey.get(s.key)),hexLatencyMs});
    // This is a progress checkpoint, explicitly separate from accepted output.
    persistentWrite(`${destination}.checkpoint`,{complete:false,rows});
    console.log(JSON.stringify({id:c.id,planned:recovery.plan.length,attempted:recovery.attempted.length,candidates:candidates.length,
      elapsedMs:recovery.elapsedMs,status:recovery.status}));
  }
  persistentWrite(destination,{schema:'hex-cxx-query-recovery-probe/v1',productSha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
    binarySha256,queriesSha256:sha256(queryBytes),complete:true,rows});
} finally {await product.close();}
