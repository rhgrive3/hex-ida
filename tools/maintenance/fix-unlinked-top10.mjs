import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const write = (p, s) => { const f=path.join(root,p); fs.mkdirSync(path.dirname(f),{recursive:true}); fs.writeFileSync(f,s); };
function replaceOnce(file, from, to) {
  let text = read(file);
  const count = text.split(from).length - 1;
  if (count !== 1) throw new Error(`${file}: expected one anchor, found ${count}: ${from.slice(0,120)}`);
  text = text.replace(from, to);
  write(file, text);
}

// #2674 — preserve ProgramIndex completeness metadata at the Agent evidence boundary.
replaceOnce('js/agent/tools.js',
`function programQuery(ctx, method, args) {
  const fn = ctx.program && ctx.program[method];
  if (typeof fn !== 'function') return { supported: false, results: [] };
  try { return { supported: true, results: fn.apply(ctx.program, args) || [] }; }
  catch (error) { throw new AgentToolError('tool-failed', \`${'${method}'} failed\`, { method, cause: String(error && error.message || error) }); }
}
`,
`function programQuery(ctx, method, args) {
  const fn = ctx.program && ctx.program[method];
  if (typeof fn !== 'function') return { supported: false, results: [] };
  try { return { supported: true, results: fn.apply(ctx.program, args) || [] }; }
  catch (error) { throw new AgentToolError('tool-failed', \`${'${method}'} failed\`, { method, cause: String(error && error.message || error) }); }
}
function programPageState(rows, localComplete, fallbackReason = 'result-limit') {
  const source = Array.isArray(rows) ? rows : [];
  const hasExplicitComplete = Object.prototype.hasOwnProperty.call(source, 'complete');
  const upstreamComplete = hasExplicitComplete
    ? source.complete === true
    : !(source.capped === true || source.queryLimited === true || source.incompleteReason);
  const complete = localComplete === true && upstreamComplete;
  const reason = complete ? null
    : source.incompleteReason || (source.queryLimited === true ? 'query-limit' : source.capped === true ? 'source-capped' : fallbackReason);
  return {
    complete,
    reason,
    capped: source.capped === true,
    queryLimited: source.queryLimited === true,
  };
}
`);
replaceOnce('js/agent/tools.js',
`      const complete = raw.length < request || offset + results.length >= raw.length;
      const total = raw.length < request ? raw.length : null;
      return { tool: 'get_callers', address: addr, supported:q.supported, results, offset, returned:results.length, total, complete, truncated:!complete, reason:complete ? null : 'result-limit', cost:{ functions:0, disassembly:0 } };
`,
`      const localComplete = raw.length < request || offset + results.length >= raw.length;
      const state = programPageState(raw, localComplete);
      const total = state.complete && raw.length < request ? raw.length : null;
      return { tool: 'get_callers', address: addr, supported:q.supported, results, offset, returned:results.length, total, complete:state.complete, truncated:!state.complete, reason:state.reason, capped:state.capped, queryLimited:state.queryLimited, cost:{ functions:0, disassembly:0 } };
`);
replaceOnce('js/agent/tools.js',
`      const complete = raw.length < request || offset + results.length >= raw.length;
      const total = raw.length < request ? raw.length : null;
      return { tool: 'get_callees', address: addr, supported:q.supported, results, offset, returned:results.length, total, complete, truncated:!complete, reason:complete ? null : 'result-limit', cost:{ functions:0, disassembly:0 } };
`,
`      const localComplete = raw.length < request || offset + results.length >= raw.length;
      const state = programPageState(raw, localComplete);
      const total = state.complete && raw.length < request ? raw.length : null;
      return { tool: 'get_callees', address: addr, supported:q.supported, results, offset, returned:results.length, total, complete:state.complete, truncated:!state.complete, reason:state.reason, capped:state.capped, queryLimited:state.queryLimited, cost:{ functions:0, disassembly:0 } };
`);
replaceOnce('js/agent/tools.js',
`      const sitesComplete = rawSites.length < request || offset + siteRows.length >= rawSites.length;
      const functionsComplete = rawFunctions.length < request || offset + functionRows.length >= rawFunctions.length;
      const complete = sitesComplete && functionsComplete;
      const siteTotal = rawSites.length < request ? rawSites.length : null;
      const functionTotal = rawFunctions.length < request ? rawFunctions.length : null;
      return { tool: 'get_xrefs', address: addr, supported:{sites:sites.supported,functions:functions.supported}, sites:siteRows, functions:functionRows, offset, returned:Math.max(siteRows.length, functionRows.length), total:siteTotal != null && functionTotal != null ? Math.max(siteTotal, functionTotal) : null, totals:{sites:siteTotal,functions:functionTotal}, complete, truncated:!complete, reason:complete ? null : 'result-limit', cost:{ functions:0, disassembly:0 } };
`,
`      const sitesState = programPageState(rawSites, rawSites.length < request || offset + siteRows.length >= rawSites.length);
      const functionsState = programPageState(rawFunctions, rawFunctions.length < request || offset + functionRows.length >= rawFunctions.length);
      const complete = sitesState.complete && functionsState.complete;
      const siteTotal = sitesState.complete && rawSites.length < request ? rawSites.length : null;
      const functionTotal = functionsState.complete && rawFunctions.length < request ? rawFunctions.length : null;
      return { tool: 'get_xrefs', address: addr, supported:{sites:sites.supported,functions:functions.supported}, sites:siteRows, functions:functionRows, offset, returned:Math.max(siteRows.length, functionRows.length), total:siteTotal != null && functionTotal != null ? Math.max(siteTotal, functionTotal) : null, totals:{sites:siteTotal,functions:functionTotal}, complete, truncated:!complete, reason:complete ? null : (sitesState.reason || functionsState.reason || 'result-limit'), capped:sitesState.capped || functionsState.capped, queryLimited:sitesState.queryLimited || functionsState.queryLimited, cost:{ functions:0, disassembly:0 } };
`);

// #2561 — bind arbitrary-address Script operations to the owning executable region.
replaceOnce('js/script.js',
`  const region = () => app.codeRegion();
  const architecture = () => String(
    app.store.get('architecture') || app.currentSlice?.()?.capability?.architecture || 'unknown'
  ).toLowerCase();
  const adapter = () => architectureAdapter(architecture());
  const rowOf = (addr) => adapter().rowForAddress(region(), BigInt(addr));
  const addressOfRow = (row) => adapter().addressForRow(region(), row);
`,
`  const region = () => app.codeRegion();
  const regionForAddress = (addr) => {
    const a = BigInt(addr);
    const direct = app.executableRegionFor?.(a);
    if (direct) return direct;
    return (app.store.get('regions') || []).find((r) => r?.exec === true && a >= r.vmAddr && a < r.vmAddr + r.size) || null;
  };
  const architecture = () => String(
    app.store.get('architecture') || app.currentSlice?.()?.capability?.architecture || 'unknown'
  ).toLowerCase();
  const adapter = () => architectureAdapter(architecture());
  const rowOf = (addr, owner = regionForAddress(addr)) => owner ? adapter().rowForAddress(owner, BigInt(addr)) : null;
  const addressOfRow = (row, owner) => owner ? adapter().addressForRow(owner, row) : null;
`);
replaceOnce('js/script.js',
`    async disasm(addr, count = 16) {
      const r = region();
      if (!r) return [];
      const a = BigInt(addr);
`,
`    async disasm(addr, count = 16) {
      const a = BigInt(addr);
      const r = regionForAddress(a);
      if (!r) return { supported:false, reason:'address-not-in-executable-region', address:a };
`);
replaceOnce('js/script.js', `        let row = rowOf(a);`, `        let row = rowOf(a, r);`);
replaceOnce('js/script.js', `          const instructionAddress = addressOfRow(row);`, `          const instructionAddress = addressOfRow(row, r);`);
replaceOnce('js/script.js',
`    async decompile(addr) {
      const arch = architecture();
      const archAdapter = adapter();
`,
`    async decompile(addr) {
      const target = BigInt(addr);
      const arch = architecture();
      const archAdapter = adapter();
      const r = regionForAddress(target);
      if (!r) return { supported:false, reason:'address-not-in-executable-region', address:target, architecture:arch };
`);
replaceOnce('js/script.js', `      const res = await app.analyzeFunctionAt(BigInt(addr));`, `      const res = await app.analyzeFunctionAt(target);`);
replaceOnce('js/script.js',
`      const r = region();
      const map = archAdapter.fixedInstructionSize != null ? {
        rowOfAddress: (a) => rowOf(a),
        addrOfRow: (row) => addressOfRow(row),
`,
`      const map = archAdapter.fixedInstructionSize != null ? {
        rowOfAddress: (a) => rowOf(a, r),
        addrOfRow: (row) => addressOfRow(row, r),
`);
replaceOnce('js/script.js',
`    async patch(addr, textOrHex) {
      const a = BigInt(addr);
      const r = region();
      if (!r) return { error: 'セクションが選ばれていません。' };
`,
`    async patch(addr, textOrHex) {
      const a = BigInt(addr);
      const r = regionForAddress(a);
      if (!r) return { error:'address-not-in-executable-region', supported:false, reason:'address-not-in-executable-region' };
`);

// #2612 — make verified-evidence reads O(limit), without changing EvidenceStore authority/order.
write('js/ai/evidence-status-index.js', `/* Incremental status index for EvidenceStore without changing its semantic authority. */
const STATE = new WeakMap();
const WRAPPED = Symbol('hex-evidence-status-index-wrapped');
function recordStatus(record) { return String(record?.status || 'unknown'); }
function build(store) { const byStatus=new Map(), statusById=new Map(); for (const [id,record] of store?.records || []) { const status=recordStatus(record); let ids=byStatus.get(status); if(!ids) byStatus.set(status,ids=[]); ids.push(String(id)); statusById.set(String(id),status); } return {byStatus,statusById}; }
function rebuild(store,state){const next=build(store);state.byStatus=next.byStatus;state.statusById=next.statusById;}
function appendNew(state,id,status){let ids=state.byStatus.get(status);if(!ids)state.byStatus.set(status,ids=[]);ids.push(id);state.statusById.set(id,status);}
function syncRecord(store,state,record){if(!record?.id)return;const id=String(record.id),nextStatus=recordStatus(record),previousStatus=state.statusById.get(id);if(previousStatus==null){appendNew(state,id,nextStatus);return;}if(previousStatus===nextStatus)return;rebuild(store,state);}
function wrapAdds(store,state){if(!store||store[WRAPPED]||typeof store.add!=='function')return;const original=store.add;Object.defineProperty(store,WRAPPED,{value:true,configurable:false});Object.defineProperty(store,'add',{configurable:true,writable:true,value:function indexedAdd(...args){const record=original.apply(this,args);syncRecord(this,state,record);return record;}});}
export function ensureEvidenceStatusIndex(store){if(!store)return null;let state=STATE.get(store);if(!state){state=build(store);STATE.set(store,state);wrapAdds(store,state);}return state;}
export function evidenceByStatus(store,status){const state=ensureEvidenceStatusIndex(store);if(!state)return[];const ids=state.byStatus.get(String(status))||[],out=new Array(ids.length);let used=0;for(const id of ids){const record=store.get?.(id)??store.records?.get?.(id)??null;if(record&&recordStatus(record)===String(status))out[used++]=record;}out.length=used;return out;}
export function recentEvidenceByStatus(store,status,limit=32){const state=ensureEvidenceStatusIndex(store);if(!state)return[];const ids=state.byStatus.get(String(status))||[],cap=Math.max(0,Math.floor(Number(limit)||0));if(!cap)return[];const start=Math.max(0,ids.length-cap),out=[];for(let i=start;i<ids.length;i++){const record=store.get?.(ids[i])??store.records?.get?.(ids[i])??null;if(record&&recordStatus(record)===String(status))out.push(record);}return out;}
`);
write('js/ai/context/indexed-broker.js', `import { ContextBroker as BaseContextBroker, UNTRUSTED_NOTICE } from './broker.js';
import { recentEvidenceByStatus } from '../evidence-status-index.js';
export { UNTRUSTED_NOTICE };
export class ContextBroker extends BaseContextBroker {
  buildModelContext(options = {}) {
    const store=options.evidenceStore;
    if(!store)return super.buildModelContext(options);
    const recentVerified=recentEvidenceByStatus(store,'verified',32);
    const evidenceStore={all:()=>recentVerified,pinned:(ids)=>typeof store.pinned==='function'?store.pinned(ids):(ids||[]).map((id)=>store.get?.(id)).filter(Boolean)};
    return super.buildModelContext({...options,evidenceStore});
  }
}
`);
replaceOnce('js/ai/context/index.js', `export { ContextBroker, UNTRUSTED_NOTICE } from './broker.js';`, `export { ContextBroker, UNTRUSTED_NOTICE } from './indexed-broker.js';`);
replaceOnce('js/ai/control/turn-executor.js',
`import { createHexToolRegistry } from '../tools/index.js';\n`,
`import { createHexToolRegistry } from '../tools/index.js';\nimport { evidenceByStatus } from '../evidence-status-index.js';\n`);
replaceOnce('js/ai/control/turn-executor.js', `confirmedFindings: this.evidenceStore.all().filter((item) => item.status === 'verified')`, `confirmedFindings: evidenceByStatus(this.evidenceStore, 'verified')`);

write('tests/ai-evidence-status-index.test.mjs', `import test from 'node:test';
import assert from 'node:assert/strict';
import { ContextBroker } from '../js/ai/context/index.js';
import { evidenceByStatus, recentEvidenceByStatus } from '../js/ai/evidence-status-index.js';
class FakeEvidenceStore { constructor(records=[]){this.records=new Map(records.map((x)=>[x.id,{...x}]));this.allCalls=0;} get(id){return this.records.get(String(id))||null;} all(){this.allCalls++;return Array.from(this.records.values());} pinned(ids){return(ids||[]).map((id)=>this.get(id)).filter(Boolean);} add(record){const previous=this.records.get(record.id),next={...previous,...record};this.records.set(record.id,next);return next;} }
const record=(id,status)=>({id,kind:'test',status,title:id,sourceTool:'test'});
test('broker reads only recent verified index',()=>{const rows=[];for(let i=0;i<100;i++)rows.push(record('s'+i,'supported'));for(let i=0;i<40;i++)rows.push(record('v'+i,'verified'));const store=new FakeEvidenceStore(rows),expected=Array.from({length:32},(_,i)=>'v'+(i+8));assert.deepEqual(recentEvidenceByStatus(store,'verified',32).map((x)=>x.id),expected);const broker=new ContextBroker({}, {maxBytes:128*1024});const built=broker.buildModelContext({request:{scope:'binary'},session:{},evidenceStore:store});assert.equal(store.allCalls,0);assert.deepEqual(built.context.verifiedEvidence.map((x)=>x.id),expected);});
test('index tracks additions and full verified persistence',()=>{const store=new FakeEvidenceStore([record('v0','verified'),record('s0','supported')]);recentEvidenceByStatus(store,'verified',32);store.add(record('v1','verified'));store.add(record('s1','supported'));assert.deepEqual(recentEvidenceByStatus(store,'verified',32).map((x)=>x.id),['v0','v1']);assert.deepEqual(evidenceByStatus(store,'verified').map((x)=>x.id),['v0','v1']);});
test('status transition preserves Map order',()=>{const store=new FakeEvidenceStore([record('a','supported'),record('b','verified'),record('c','verified')]);recentEvidenceByStatus(store,'verified',32);store.add(record('a','verified'));assert.deepEqual(evidenceByStatus(store,'verified').map((x)=>x.id),['a','b','c']);});
`);

write('tests/unlinked-top10-regression.test.mjs', `import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentTools } from '../js/agent/tools.js';
import { createApi } from '../js/script.js';
function rows(values,meta={}){const out=[...values];for(const [key,value] of Object.entries(meta))Object.defineProperty(out,key,{value,configurable:true});return out;}
test('#2674 callers/callees preserve upstream incompleteness', async()=>{const capped=()=>rows([{addr:0x1100n,site:0x1110n,count:1}],{complete:false,capped:true,incompleteReason:'calls-source-capped'});const program={callersOf:capped,functionRange:()=>({start:0x1000n,end:0x1080n}),calleesOf:capped};const tools=createAgentTools({program});for(const name of ['get_callers','get_callees']){const result=await tools[name](0x1000n,{limit:100});assert.equal(result.complete,false);assert.equal(result.truncated,true);assert.equal(result.reason,'calls-source-capped');assert.equal(result.capped,true);}});
test('#2674 xrefs preserve source/query incompleteness and complete pages stay complete', async()=>{const refs=rows([{site:0x1010n,target:0x2000n}],{complete:false,queryLimited:true,incompleteReason:'query-limit'});const funcs=rows([{addr:0x1000n}],{complete:true});const tools=createAgentTools({program:{refSitesTo:()=>refs,functionsReferencing:()=>funcs}});const result=await tools.get_xrefs(0x2000n,{limit:100});assert.equal(result.complete,false);assert.equal(result.reason,'query-limit');assert.equal(result.queryLimited,true);const completeTools=createAgentTools({program:{callersOf:()=>rows([{addr:1n}],{complete:true})}});assert.equal((await completeTools.get_callers(2n,{limit:100})).complete,true);});
test('#2561 disasm/patch use address-owning executable region and unmapped fails closed', async()=>{const A={id:'A',vmAddr:0x1000n,size:0x1000n,exec:true,fileOffset:0n},B={id:'B',vmAddr:0x5000n,size:0x1000n,exec:true,fileOffset:0x1000n};const mn=new Array(1024),ops=new Array(1024);mn[64]='nop';ops[64]='';const fetches=[];const patches=[];const app={codeRegion:()=>A,executableRegionFor:(a)=>a>=B.vmAddr&&a<B.vmAddr+B.size?B:a>=A.vmAddr&&a<A.vmAddr+A.size?A:null,store:{get:(k)=>k==='architecture'?'arm64':k==='regions'?[A,B]:k==='file'?{size:0x3000}:null},currentSlice:()=>({capability:{architecture:'arm64'}}),symbols:{},notes:{},viewer:{},backend:{fetchChunk:async(id)=>{fetches.push(id);return{mn,ops};},readAt:async()=>({found:true,bytes:new Uint8Array([0,0,0,0])})},patches:{add:(...args)=>patches.push(args)}};const {api}=createApi(app,()=>{});const decoded=await api.disasm(0x5100n,1);assert.equal(decoded[0].addr,0x5100n);assert.deepEqual(fetches,['B']);const patched=await api.patch(0x5100n,'1F 20 03 D5');assert.equal(patched.ok,true);assert.equal(patches.length,1);const invalid=await api.disasm(0x9000n,1);assert.equal(invalid.supported,false);assert.equal(invalid.reason,'address-not-in-executable-region');});
`);

console.log('guarded fixes applied');
