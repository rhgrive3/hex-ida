// Explicit interactive recovery planning. This module does not recover,
// publish, prove ownership, read binary bytes or call an external model.
import { analyzeFunctionSymbol } from './object-evidence.js';

const STOP = new Set('a an and are as at be being by current field find for from has have in is it member of on or stored that the this to used value what where which with'.split(' '));
export function cxxQueryTokens(text) {
  const words=String(text??'').slice(0,4096).replace(/([a-z0-9])([A-Z])/g,'$1 $2').toLowerCase().match(/[a-z][a-z0-9]*/g)??[];
  return [...new Set(words.filter(w=>w.length>1&&!STOP.has(w)).map(w=>w.length>4&&w.endsWith('s')&&!w.endsWith('ss')?w.slice(0,-1):w))];
}

export function createCxxQueryPlanner({symbols,classEvidence,isExecutable=()=>false}={}) {
  const starts=new Set(Array.from(symbols?.funcs??[],String));
  const owners=new Map();
  for(const cls of classEvidence?.classes??[]) {
    if(!cls.className)continue;
    for(const slot of cls.slots??[]) {
      if(slot.address==null||slot.unresolved||!starts.has(String(slot.address)))continue;
      const key=String(slot.address);const names=owners.get(key)??new Set();names.add(cls.className);owners.set(key,names);
    }
  }
  const records=new Map(),blocked=new Set();
  for(let i=0;i<(symbols?.names?.length??0);i++) {
    const address=symbols.addrs[i];if(address==null||!starts.has(String(address)))continue;
    const info=analyzeFunctionSymbol(symbols.names[i]);const names=owners.get(String(address));
    // Planning never resolves conflicting ownership or treats an ordinary
    // qualified symbol as proof that a method is non-static.
    if(info.isAdjustedThunk||names?.size>1){blocked.add(String(address));continue;}
    const symbolProof=info.isConstructor||info.isDestructor||info.isConstMember;
    if(!symbolProof&&names?.size!==1)continue;
    const className=names?.size===1?[...names][0]:info.className;
    if(!className||info.className&&info.className!==className||!isExecutable(address)){blocked.add(String(address));continue;}
    const row={address:BigInt(address),className,methodName:info.methodName??'',symbolName:symbols.names[i],
      proof:symbolProof?'non-static-symbol':'unique-vtable-owner',
      classTokens:cxxQueryTokens(className),methodTokens:info.isConstructor||info.isDestructor?[]:cxxQueryTokens(info.methodName)};
    records.set(String(address),row);
  }
  // Slots with no symbol can still be planned by their unique proven owner.
  for(const [key,names] of owners) {
    if(records.has(key)||blocked.has(key)||names.size!==1||!isExecutable(BigInt(key)))continue;
    const className=[...names][0];records.set(key,{address:BigInt(key),className,methodName:'',symbolName:null,
      proof:'unique-vtable-owner',classTokens:cxxQueryTokens(className),methodTokens:[]});
  }
  const rows=[...records.values()];
  return Object.freeze({
    functionCount:rows.length,
    plan(phrase,{maxFunctions=8}={}) {
      if(!Number.isSafeInteger(maxFunctions)||maxFunctions<1||maxFunctions>32)throw new Error('C++ recovery function budget must be 1..32');
      const tokens=new Set(cxxQueryTokens(phrase));
      return Object.freeze(rows.map(row=>{
        const classHits=row.classTokens.filter(t=>tokens.has(t));const methodHits=row.methodTokens.filter(t=>tokens.has(t));
        const leaf=row.className.split('::').at(-1);
        const exactObject=cxxQueryTokens(leaf).length===1&&tokens.has(leaf.toLowerCase());
        return {...row,score:2*classHits.length+4*methodHits.length+(exactObject?2:0),classHits,methodHits,
          specificity:classHits.length/Math.max(1,row.classTokens.length)};
      }).filter(row=>row.score>0).sort((a,b)=>b.score-a.score||b.methodHits.length-a.methodHits.length
        ||b.specificity-a.specificity
        ||(a.address<b.address?-1:a.address>b.address?1:0)).slice(0,maxFunctions).map(Object.freeze));
    },
  });
}

// Reuses the existing scoped Fast decompiler. Callers supply the bound query
// owner; no model or evidence is forged here. Default is off, even with a plan.
export async function recoverCxxQueryMembers({enabled=false,plan=[],snapshot,decompile,signal,
  maxFunctions=8,maxElapsedMs=15000,now=()=>performance.now(),onProgress=()=>{}}={}) {
  if(!enabled)return {status:'disabled',attempted:[],elapsedMs:0};
  if(!snapshot||typeof decompile!=='function')throw new Error('bound C++ recovery query required');
  if(!Number.isSafeInteger(maxFunctions)||maxFunctions<1||maxFunctions>32
    ||!Number.isFinite(maxElapsedMs)||maxElapsedMs<=0||maxElapsedMs>120000)throw new Error('invalid C++ recovery budget');
  const started=now(),attempted=[],seen=new Set();let status='complete';
  for(const entry of plan) {
    if(signal?.aborted)throw signal.reason instanceof Error?signal.reason:new DOMException('Aborted','AbortError');
    if(attempted.length>=maxFunctions||now()-started>=maxElapsedMs){status='budget-exhausted';break;}
    const key=String(entry.address);if(seen.has(key))continue;seen.add(key);
    // The scoped owner must enforce snapshot binding, cancellation and the
    // ordinary decompiler budgets. A stale snapshot is not a recoverable miss.
    const result=await decompile(snapshot,entry.address,{profile:'fast',signal,decompilerTimeBudgetMs:1500});
    attempted.push({address:key,className:entry.className,status:result?.status??null,
      pseudocode:Boolean(result?.value?.pseudocode)});
    onProgress({phase:'cxx-query-recovery',done:attempted.length,all:Math.min(plan.length,maxFunctions)});
  }
  return {status,attempted,elapsedMs:now()-started};
}
