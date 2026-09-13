#!/usr/bin/env node
import { openProduct } from './product-host.mjs';
const binary=process.argv[2];if(!binary){console.error('subject requires binary');process.exit(2)}let p;
try{
  p=await openProduct(binary);
  if(p.unsupported){console.log(JSON.stringify({schema:'hex-public-benchmark-subject/v1',state:'UNSUPPORTED',reason:p.reason,functions:[]}));process.exitCode=2;}
  else{
    const snapshot=await p.query.snapshot();let offset=0;const discovered=[];
    while(true){const list=await p.query.functions(snapshot,{}, {offset,limit:1000});discovered.push(...(list.value??[]));if(list.page?.next==null)break;offset=list.page.next;}
    const functions=[];
    for(const f of discovered){try{const s=await p.query.snapshot(),r=await p.query.decompile(s,f.address),v=r?.value;const completeness=r?.status?.completeness??r?.completeness??'unknown';functions.push({address:String(f.address),name:f.name??null,end:f.end==null?null:String(f.end),state:v?(completeness==='complete'?'PASS':String(completeness).toUpperCase()):'UNSUPPORTED',completeness,pseudocode:v?.pseudocode??v?.code??null});}catch(e){functions.push({address:String(f.address),name:f.name??null,state:e?.name==='AbortError'?'TIMEOUT':'CRASH',reason:String(e?.message||e),pseudocode:null});}}
    console.log(JSON.stringify({schema:'hex-public-benchmark-subject/v1',state:'PASS',inputSha256:p.sha,productRoute:p.app.backend.analysisRouteInfo(),functionDiscoveryComplete:p.app.symbols.functionStartsComplete===true,functions}));
  }
}catch(e){console.log(JSON.stringify({schema:'hex-public-benchmark-subject/v1',state:'CRASH',reason:String(e?.stack||e),functions:[]}));process.exitCode=1;}finally{await p?.close?.();}
