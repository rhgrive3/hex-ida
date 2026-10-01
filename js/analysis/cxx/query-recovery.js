// Explicit interactive recovery planning. This module does not recover,
// publish, prove ownership, read binary bytes or call an external model.
import { analyzeFunctionSymbol } from './object-evidence.js';
import { createPrimaryOwnerResolver } from './primary-owner.js';
import { createCppTypedArgumentEvidence } from './typed-argument.js';
import { buildCppClassTypeIndex } from './class-type.js';

const STOP = new Set('a an and are as at be being by current field find for from has have in is it member of on or stored that the this to used value what where which with'.split(' '));
export function cxxQueryTokens(text) {
  const words=String(text??'').slice(0,4096).replace(/([a-z0-9])([A-Z])/g,'$1 $2').toLowerCase().match(/[a-z][a-z0-9]*/g)??[];
  return [...new Set(words.filter(w=>w.length>1&&!STOP.has(w)).map(w=>w.length>4&&w.endsWith('s')&&!w.endsWith('ss')?w.slice(0,-1):w))];
}

// Keep the published V2 tokenizer stable for historical replay. Recovery V3
// also separates acronym boundaries in release symbols (SDLDevice -> SDL Device).
export function cxxRecoveryTokens(text) {
  return cxxQueryTokens(String(text??'').replace(/([A-Z]+)([A-Z][a-z])/g,'$1 $2'));
}

export function createCxxQueryPlanner({symbols,classEvidence,isExecutable=()=>false,planningPolicy='legacy'}={}) {
  if(!['legacy','value-accessor-v3'].includes(planningPolicy))throw new Error('unknown C++ recovery planning policy');
  const valueAccessors=planningPolicy==='value-accessor-v3';
  const tokensFor=valueAccessors?cxxRecoveryTokens:cxxQueryTokens;
  const typedClassNames=new Set((classEvidence?.classes??[]).map(cls=>cls.className).filter(Boolean));
  if(valueAccessors)for(const name of buildCppClassTypeIndex({symbols,snapshotId:'planning-only'}).keys())typedClassNames.add(name);
  const extentFor=address=>{
    if(!valueAccessors)return null;
    const end=symbols?.declaredFunctionEnd?.(address);
    return typeof end==='bigint'&&end>address?end-address:null;
  };
  const starts=new Set(Array.from(symbols?.funcs??[],String));
  const primaryOwnerFor=createPrimaryOwnerResolver(classEvidence?.classes??[]);
  const owners=new Map();
  for(const cls of classEvidence?.classes??[]) {
    if(!cls.className)continue;
    for(const slot of cls.slots??[]) {
      if(slot.address==null||slot.unresolved||!starts.has(String(slot.address)))continue;
      const key=String(slot.address);const names=owners.get(key)??new Set();names.add(cls.className);owners.set(key,names);
    }
  }
  const records=new Map(),blocked=new Set(),argumentAliases=new Map();
  for(let i=0;i<(symbols?.names?.length??0);i++) {
    const address=symbols.addrs[i];if(address==null||!starts.has(String(address)))continue;
    if(blocked.has(String(address)))continue;
    const argumentProof=valueAccessors?createCppTypedArgumentEvidence({symbol:symbols.names[i],functionAddress:BigInt(address)}):null;
    if(valueAccessors) {
      const key=String(address),kind=argumentProof?.className??null;
      if(argumentAliases.has(key)&&argumentAliases.get(key)!==kind&&(kind||argumentAliases.get(key))) {
        blocked.add(key);records.delete(key);continue;
      }
      argumentAliases.set(key,kind);
    }
    const info=analyzeFunctionSymbol(symbols.names[i]);const names=owners.get(String(address));
    // Planning never resolves conflicting ownership or treats an ordinary
    // qualified symbol as proof that a method is non-static.
    const declaringOwner=names?.size>1&&!info.isAdjustedThunk?primaryOwnerFor(BigInt(address),info.className):null;
    if(info.isAdjustedThunk||names?.size>1&&!declaringOwner){blocked.add(String(address));records.delete(String(address));continue;}
    const symbolProof=info.isConstructor||info.isDestructor||info.isConstMember;
    if(!symbolProof&&names?.size!==1&&!declaringOwner&&!argumentProof)continue;
    const className=declaringOwner?.className??(names?.size===1?[...names][0]:argumentProof?.className??info.className);
    if(!className||info.className&&info.className!==className||!isExecutable(address)){blocked.add(String(address));records.delete(String(address));continue;}
    const methodName=argumentProof?.functionName??info.methodName??'';
    const row={address:BigInt(address),className,methodName,symbolName:symbols.names[i],
      proof:argumentProof?'release-typed-object-argument':declaringOwner?'declaring-primary-vtable-owner':symbolProof?'non-static-symbol':'unique-vtable-owner',
      classTokens:tokensFor(className),methodTokens:info.isConstructor||info.isDestructor?[]:tokensFor(methodName),
      declaredSizeBytes:extentFor(BigInt(address))};
    const previous=records.get(String(address));
    if(previous&&previous.className!==className){blocked.add(String(address));records.delete(String(address));continue;}
    records.set(String(address),row);
  }
  // Slots with no symbol can still be planned by their unique proven owner.
  for(const [key,names] of owners) {
    if(records.has(key)||blocked.has(key)||names.size!==1||!isExecutable(BigInt(key)))continue;
    const className=[...names][0];records.set(key,{address:BigInt(key),className,methodName:'',symbolName:null,
      proof:'unique-vtable-owner',classTokens:tokensFor(className),methodTokens:[],declaredSizeBytes:extentFor(BigInt(key))});
  }
  const rows=[...records.values()].map(row=>Object.freeze({...row,
    classTokens:Object.freeze(row.classTokens),methodTokens:Object.freeze(row.methodTokens)}))
    .filter(row=>row.proof!=='release-typed-object-argument'
      ||typedClassNames.has(row.className));
  const scoreRows=phrase=>{
    const tokens=new Set(tokensFor(phrase));
    return rows.map(row=>{
      const classHits=row.classTokens.filter(t=>tokens.has(t));const methodHits=row.methodTokens.filter(t=>tokens.has(t)&&!row.classTokens.includes(t));
      const leaf=row.className.split('::').at(-1);
      const exactObject=tokensFor(leaf).length===1&&tokens.has(leaf.toLowerCase());
      return {...row,score:2*classHits.length+4*methodHits.length+(exactObject?2:0),classHits,methodHits,
        specificity:classHits.length/Math.max(1,row.classTokens.length)};
    }).sort((a,b)=>{
      const score=b.score-a.score;
      if(score)return score;
      const method=b.methodHits.length-a.methodHits.length;
      const owner=b.specificity-a.specificity;
      const relevance=valueAccessors?method||owner:owner||method;
      if(relevance)return relevance;
      // A smaller independently declared extent is cheaper to attempt. Unknown
      // or large functions stay eligible; this is scheduling, never ownership.
      if(valueAccessors&&a.declaredSizeBytes!==b.declaredSizeBytes) {
        if(a.declaredSizeBytes==null)return 1;
        if(b.declaredSizeBytes==null)return -1;
        return a.declaredSizeBytes<b.declaredSizeBytes?-1:1;
      }
      return a.address<b.address?-1:a.address>b.address?1:0;
    });
  };
  return Object.freeze({
    functionCount:rows.length,
    planningPolicy,
    // Existing release functions only. Round-robin owners prevent one large
    // class from consuming the external selector's entire 255-choice budget.
    choices(phrase,{maxChoices=255}={}) {
      if(!Number.isSafeInteger(maxChoices)||maxChoices<1||maxChoices>255)throw new Error('C++ recovery choice budget must be 1..255');
      const groups=new Map();
      for(const row of scoreRows(phrase)) {
        const group=groups.get(row.className)??[];group.push(row);groups.set(row.className,group);
      }
      const result=[];
      for(let depth=0;result.length<maxChoices;depth++) {
        let added=false;
        for(const group of groups.values()) {
          if(group[depth]){result.push(Object.freeze(group[depth]));added=true;}
          if(result.length===maxChoices)break;
        }
        if(!added)break;
      }
      return Object.freeze(result);
    },
    planOwner(phrase,className,{maxFunctions=8,firstAddress=null}={}) {
      if(!Number.isSafeInteger(maxFunctions)||maxFunctions<1||maxFunctions>32)throw new Error('C++ recovery function budget must be 1..32');
      const selected=scoreRows(phrase).filter(row=>row.className===className);
      const first=selected.find(row=>row.address===firstAddress);
      if(first)selected.splice(selected.indexOf(first),1);
      return Object.freeze((first?[first,...selected]:selected).slice(0,maxFunctions).map(Object.freeze));
    },
    plan(phrase,{maxFunctions=8}={}) {
      if(!Number.isSafeInteger(maxFunctions)||maxFunctions<1||maxFunctions>32)throw new Error('C++ recovery function budget must be 1..32');
      return Object.freeze(scoreRows(phrase).filter(row=>row.score>0).slice(0,maxFunctions).map(Object.freeze));
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
  if(now()-started>=maxElapsedMs)status='budget-exhausted';
  return {status,attempted,elapsedMs:now()-started};
}

export function cxxRecoveryMadeProgress(result) {
  return result?.attempted?.some(r=>r.pseudocode===true)===true
    &&Number.isSafeInteger(result.beforeRevision)&&Number.isSafeInteger(result.afterRevision)
    &&result.afterRevision>result.beforeRevision;
}
