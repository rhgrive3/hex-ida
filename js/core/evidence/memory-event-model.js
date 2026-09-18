/** L04 conditional, finite event-model checker. These are explicitly named
 * mathematical subsets, NOT the ARM .cat model or a C/C++ language model.
 * Fixed unconditional, same-width atomic reads and constant writes only;
 * no dependency/RMW/fence/non-atomic/race or hardware-completeness claim.
 */
import { snapshotContractData, recordFields, exactString, exactInteger, exactEnum, contractFail } from '../identity/structured.js';
import { deepFreeze, stableStringify } from '../identity/index.js';
import { assertScopedAnalysisWork } from '../budgets/scoped-work.js';
export const MEMORY_EVENT_SCHEMA = 'scpa-memory-event-model/v1';
export const MEMORY_MODELS = Object.freeze(['sc-total-order/v1', 'coherent-acquire-release-subset/v1']);
const value = v => { if (typeof v !== 'string' || !/^(0|[1-9][0-9]{0,9})$/.test(v) || BigInt(v) > 0xffffffffn) contractFail('event-value-u32'); return v; };
function closure(ids, edges) {
  const index = new Map(ids.map((v, i) => [v, i])), n = ids.length, reach = Array.from({length:n},()=>Array(n).fill(false));
  for (const [a,b] of edges) reach[index.get(a)][index.get(b)] = true;
  for (let k=0;k<n;k++) for(let i=0;i<n;i++) if(reach[i][k]) for(let j=0;j<n;j++) reach[i][j] ||= reach[k][j];
  return { cyclic: reach.some((r,i)=>r[i]), edges: ids.flatMap((a,i)=>ids.filter((b,j)=>reach[i][j]).map(b=>[a,b])) };
}
function* permutations(a) {
  if (!a.length) { yield []; return; }
  for (let i=0;i<a.length;i++) for(const rest of permutations([...a.slice(0,i),...a.slice(i+1)])) yield [a[i],...rest];
}
export function checkMemoryEventModel(input, queryInput, {work} = {}) {
  assertScopedAnalysisWork(work); work.checkpoint();
  const m=snapshotContractData(input,{maxBytes:32768,maxNodes:1024}), q=snapshotContractData(queryInput,{maxBytes:4096,maxNodes:128});
  work.charge('residentBytes',(stableStringify(m).length+stableStringify(q).length)*2);
  recordFields(m,['schema','model','coverage','initial','events'],'event-model-fields');
  if(m.schema!==MEMORY_EVENT_SCHEMA)contractFail('event-schema');
  exactEnum(m.model,MEMORY_MODELS,'event-model-version'); exactEnum(m.coverage,['closed-events','open-events'],'event-coverage');
  if(!Array.isArray(m.initial)||m.initial.length<1||m.initial.length>4||!Array.isArray(m.events)||m.events.length>12)contractFail('event-model-size');
  const initial=m.initial.map((v,i)=>{recordFields(v,['location','value'],'event-initial-fields');exactString(v.location,'event-location',64);value(v.value);return {id:`@initial:${i}`,kind:'write',thread:null,order:'relaxed',...v};});
  const locs=new Map(initial.map(v=>[v.location,v]));if(locs.size!==initial.length)contractFail('event-duplicate-location');
  const ids=new Set(initial.map(v=>v.id)), threads=new Map(), po=[], events=[];
  for(const e of m.events){
    recordFields(e,['id','thread','kind','location','order',...(e.kind==='write'?['value']:[])],'event-fields');
    exactString(e.id,'event-id',64);exactString(e.thread,'event-thread',64);exactString(e.location,'event-location',64);
    exactEnum(e.kind,['read','write'],'event-kind');exactEnum(e.order,e.kind==='read'?['relaxed','acquire']:['relaxed','release'],'event-order');
    if(!locs.has(e.location)||ids.has(e.id)||e.id.startsWith('@'))contractFail('event-identity');
    if(e.kind==='write')value(e.value);ids.add(e.id);
    const last=threads.get(e.thread);if(last)po.push([last,e.id]);threads.set(e.thread,e.id);events.push(e);
  }
  if(threads.size>4)contractFail('event-thread-limit');
  const reads=events.filter(e=>e.kind==='read'), writes=events.filter(e=>e.kind==='write');
  if(reads.length>6||writes.length>6)contractFail('event-kind-limit');
  recordFields(q,['reads','maxCandidates','maxSearchSteps'],'event-query-fields');
  if(!q.reads||Object.getPrototypeOf(q.reads)!==Object.prototype)contractFail('event-query-reads');
  recordFields(q.reads,reads.map(r=>r.id),'event-query-read-id');
  for(const v of Object.values(q.reads))value(v);
  if(Object.keys(q.reads).length===0)contractFail('event-query-empty');
  const max=exactInteger(q.maxCandidates??4096,'event-candidate-budget',{min:1,max:8192});
  const maxSteps=exactInteger(q.maxSearchSteps??32768,'event-search-budget',{min:1,max:65536});
  const all=[...initial,...events], allIds=all.map(e=>e.id), byId=new Map(all.map(e=>[e.id,e]));
  const poAll=closure(allIds,po).edges, choices=reads.map(r=>all.filter(w=>w.kind==='write'&&w.location===r.location&&(!Object.hasOwn(q.reads,r.id)||q.reads[r.id]===w.value)));
  let candidates=0, steps=0, bounded=false, witness=null, firstRejected=null;
  const tick=()=>{work.checkpoint(); if(steps>=maxSteps){bounded=true;return false;}steps++;work.charge('workUnits');return true;};
  function examine(coLists,rfPairs){
    if(!tick())return;
    if(candidates>=max){bounded=true;return;} candidates++;
    const rf=rfPairs.map(([r,w])=>[w,r]), co=[],fr=[];
    for(const list of coLists)for(let i=0;i<list.length;i++)for(let j=i+1;j<list.length;j++)co.push([list[i],list[j]]);
    for(const [r,w] of rfPairs)for(const [a,b] of co)if(a===w)fr.push([r,b]);
    const sw=rf.filter(([w,r])=>byId.get(w).order==='release'&&byId.get(r).order==='acquire');
    const hb=closure(allIds,[...po,...sw]);
    const graph=m.model==='sc-total-order/v1'?[...po,...rf,...co,...fr]
      :[...hb.edges.filter(([a,b])=>byId.get(a).location===byId.get(b).location),...rf,...co,...fr];
    const inconsistent=hb.cyclic?'happens-before-cycle':closure(allIds,graph).cyclic?'order-or-coherence-cycle':null;
    work.charge('workUnits',allIds.length*allIds.length);
    if(inconsistent){firstRejected??={reason:inconsistent,readsFrom:rfPairs.map(([read,write])=>({read,write}))};return;}
    witness={readsFrom:rfPairs.map(([read,write])=>({read,write,value:byId.get(write).value})),modificationOrder:coLists,relations:{programOrder:poAll,synchronizesWith:sw}};
  }
  function chooseRead(i,co,rf){if(witness||bounded||!tick())return;if(i===reads.length){examine(co,rf);return;}for(const w of choices[i]){chooseRead(i+1,co,[...rf,[reads[i].id,w.id]]);if(witness||bounded)break;}}
  const locations=[...locs.keys()];
  function chooseCo(i,co){if(witness||bounded||!tick())return;if(i===locations.length){chooseRead(0,co,[]);return;}
    const loc=locations[i];for(const order of permutations(writes.filter(w=>w.location===loc).map(w=>w.id))){chooseCo(i+1,[...co,[locs.get(loc).id,...order]]);if(witness||bounded)break;}}
  chooseCo(0,[]);work.checkpoint();
  const exhaustive=!witness&&!bounded;
  return deepFreeze({schema:'scpa-memory-event-result/v1',model:m.model,status:witness?'model-witness':exhaustive&&m.coverage==='closed-events'?'forbidden-in-model':'unknown',
    witness,firstRejected,exhaustive,candidates,searchSteps:steps,cutoff:bounded?'enumeration-budget':null,
    exact:false,semanticProof:false,rewriteAuthorized:false,releaseQualified:false,
    remaining:['fixed-constant-atomic-u32-events-only','source-event-correspondence-unproved','not-ARM-cat-or-C-language-qualification',
      ...(m.coverage==='open-events'?['unmodeled-events-open']:[]),...(bounded?['search-frontier-open']:[])]});
}
