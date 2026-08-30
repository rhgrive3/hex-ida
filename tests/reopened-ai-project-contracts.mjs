import assert from 'node:assert/strict';
import { EvidenceStore } from '../js/ai/evidence.js';
import { ContextBroker } from '../js/ai/context/broker.js';
import { AIRuntime } from '../js/ai/runtime.js';
import { InvestigationSessionStore, createProjectSessionPersistence } from '../js/ai/session-core/index.js';
import { createHexProject, parseHexProject, serializeHexProject, HEX_PROJECT_VERSION } from '../js/project/index.js';
import { NoteStore } from '../js/names.js';
import { AiSession } from '../js/ai/ui/session.js';
import fs from 'node:fs';

// #2612: recent verified extraction must not require EvidenceStore.all().
const evidence = new EvidenceStore();
evidence.restorePersistedConfirmed(Array.from({ length: 80 }, (_, i) => ({ id:`v${i}`, kind:'test', status:'verified', title:`E${i}` })));
const originalAll = evidence.all.bind(evidence);
evidence.all = () => { throw new Error('full-store-scan'); };
const broker = new ContextBroker({}, { maxBytes: 128 * 1024 });
const built = broker.buildModelContext({ request:{ mode:'chat', style:'analyst', scope:'function' }, session:{ messages:[] }, evidenceStore:evidence });
assert.deepEqual(built.context.verifiedEvidence.map((x) => x.id), Array.from({ length:32 }, (_,i)=>`v${48+i}`));
evidence.all = originalAll;

// #2600: original trim priority is preserved: transcript is removed before
// compacting the current function projection.
const bigSession = { messages:Array.from({ length:8 }, (_,i)=>({ role:i%2?'assistant':'user', content:'m'.repeat(3000) })), investigationMemory:{ goal:'x' } };
const trimBroker = new ContextBroker({ currentFunction:{ address:'0x1000', instructions:Array.from({length:40},(_,i)=>({address:`0x${(0x1000+i*4).toString(16)}`,mnemonic:'mov',operands:'x0, x1'})) } }, { maxBytes:4096 });
const trimmed = trimBroker.buildModelContext({ request:{mode:'chat',style:'analyst',scope:'function'}, session:bigSession, evidenceStore:new EvidenceStore() });
assert.ok((trimmed.context.recentMessages?.length || 0) < 8);
assert.ok(Array.isArray(trimmed.context.current?.function?.instructions), 'function detail must survive while lower-priority history can satisfy the budget');

// #2568: legacy v1 absence is distinct from an explicitly empty v2 vars set.
assert.equal(HEX_PROJECT_VERSION, 2);
const legacy = { format:'hexproj', version:1, createdAt:new Date(0).toISOString(), updatedAt:new Date(0).toISOString(), binary:{hash:'h',metadata:{},embedded:false}, user:{names:[],comments:[],types:[],structs:[],bookmarks:[],patches:[]}, findings:{confirmed:[],agentAnswers:[],evidence:[],investigationSessions:[]}, analysis:{settings:{},cacheReferences:[]}, navigation:{} };
const migrated = parseHexProject(JSON.stringify(legacy));
assert.equal(migrated.user.varsPresent, false);
const current = parseHexProject(serializeHexProject(createHexProject({ binary:{hash:'h',metadata:{}}, vars:[] })));
assert.equal(current.user.varsPresent, true);

// #2613/#2615: release memory independently from durable project deletion.
const project = createHexProject({ binary:{hash:'bin',metadata:{}}, investigationSessions:[] });
const persistence = createProjectSessionPersistence(project);
const store = new InvestigationSessionStore({ persistence });
const session = await store.create({ id:'s1', binaryId:'bin', conversationId:'c1', goal:'g' });
const runtime = new AIRuntime({ context:{ binaryId:'bin' }, sessionStore:store, planner:false });
runtime.storesFor(session, 'bin');
assert.equal(runtime.storeNamespaces.size, 1);
await runtime.releaseSession('s1', { deletePersisted:false });
assert.equal(runtime.storeNamespaces.size, 0);
assert.equal(store.sessions.has('s1'), false);
assert.equal(project.findings.investigationSessions.some((x)=>x.id==='s1'), true);
await store.get('s1');
await runtime.releaseSession('s1', { deletePersisted:true });
assert.equal(project.findings.investigationSessions.some((x)=>x.id==='s1'), false);

// #2613 UI retention and explicit delete use different lifecycle reasons.
const releases=[];
const ui = new AiSession({ engine:{ run:async()=>({answer:'ok'}), deleteSession:(id,opts)=>{ releases.push([id,opts?.reason]); } }, storage:null });
for (let i=0;i<24;i++) { ui.current.turns.push({role:'user',text:'x'}); ui.newConversation(); }
await new Promise((r)=>setTimeout(r,0));
assert.ok(releases.some(([,reason])=>reason==='retention-eviction'));
const victim = ui.list().find((x)=>x!==ui.current && !x.busy);
assert.ok(victim && ui.deleteConversation(victim.id));
await new Promise((r)=>setTimeout(r,0));
assert.ok(releases.some(([id,reason])=>id===victim.id && reason==='user-delete'));

// #2564: after one bulk snapshot, an ordinary mutation writes a tiny delta,
// not the whole NoteStore, and a fresh instance observes it immediately.
class MemoryStorage {
  constructor(){ this.map=new Map(); this.writes=[]; }
  get length(){ return this.map.size; }
  key(i){ return Array.from(this.map.keys())[i] ?? null; }
  getItem(k){ return this.map.has(k)?this.map.get(k):null; }
  setItem(k,v){ this.map.set(k,String(v)); this.writes.push([k,String(v)]); }
  removeItem(k){ this.map.delete(k); }
}
globalThis.localStorage = new MemoryStorage();
const notes = new NoteStore('delta-test');
notes.transaction(()=>{ for(let i=0;i<2000;i++) notes.setName(BigInt(0x1000+i*4), `name_${i}`); });
const rootBytes = globalThis.localStorage.getItem('hex.notes.delta-test').length;
globalThis.localStorage.writes.length=0;
assert.equal(notes.setName(0x1000n,'renamed'), true);
assert.equal(globalThis.localStorage.writes.length,1);
assert.ok(globalThis.localStorage.writes[0][0].includes('.delta.'));
assert.ok(globalThis.localStorage.writes[0][1].length < rootBytes / 20);
const restored = new NoteStore('delta-test');
assert.equal(restored.nameOf(0x1000n),'renamed');

// Production wiring must pass project persistence to the core and expose it
// to ProductWorkspace; source assertions guard the lazy bridge seam.
const bridgeSource = fs.readFileSync(new URL('../js/ai/ui/bridge.js', import.meta.url),'utf8');
const assistantSource = fs.readFileSync(new URL('../js/ai/ui/assistant.js', import.meta.url),'utf8');
assert.match(bridgeSource, /createAIRuntime\(\{ context: localContext, provider, persistence \}\)/);
assert.match(assistantSource, /app\.aiRuntime = engine/);

console.log('reopened AI/project contracts: ok');
