// Optional interactive suggestion. It cannot replace the local result or issue
// binary facts. Only the active binary's branded anonymous C++ fields are sent.
import { adviseWithJev, rerankWithJev } from '../../pinpoint.js';
import { cxxSemanticViews, cxxSemanticScores, cxxObjectSemanticScores, compareCxxSemanticScores } from './cxx-semantic-preference.js';
import { cxxQueryTokens, cxxRecoveryTokens } from '../cxx/query-recovery.js';
import { demangleCxx } from '../../rtti.js';

const INSTRUCTION = 'Select only an existing candidate. Identify the main object and requested value in the phrase separately from actions and related helper objects. Prefer evidence for that object and value over an unrelated class with a matching word. Machine use roles and method names are context, not proof of a source field name. A shared method may access several different members. This is a weak ranking preference, never binary proof. Prefer a method that retrieves or changes the requested value over a method that only mentions an action in the question. Constructor and shared-method accesses do not distinguish individual unnamed members. Treat identical context as ambiguous; do not infer a source member name from an offset.';
const bounded = value => String(value).slice(0, 240);
const argumentBitsFor = context => (context.writtenArgumentBits??[]).slice(0,8)
  .filter(value=>typeof value==='string'&&/^x[0-7]:(?:[0-9]|[1-5][0-9]|6[0-3])$/.test(value));

// This pure projection accepts an already validated view; unknown properties
// (including descriptions, source labels, and oracle objects) are ignored.
export function jevAdvisoryRequest(query, views) {
  const tokens = new Set(cxxQueryTokens(query));
  const criteria = Object.fromEntries(views.map((c, index) => {
    const owner = cxxQueryTokens(c.className);
    const contexts = (c.functionContexts ?? []).slice(0, 64).map((ctx, position) => {
      const method = ctx.name ? (demangleCxx(ctx.name) ?? ctx.name).split('(')[0].split('::').at(-1) : '';
      const hits = cxxQueryTokens(method).filter(t => tokens.has(t) && !owner.includes(t)).length;
      return { ctx, position, priority: hits * (ctx.accessRoles?.includes('return-input') ? 2 : 1) };
    }).sort((a, b) => b.priority - a.priority || a.ctx.address.localeCompare(b.ctx.address) || a.position - b.position).slice(0, 8);
    const parts = [`class: ${bounded(c.className)}`, `member: offset 0x${c.offset.toString(16)}`,
      `size: ${Number.isSafeInteger(c.size) && c.size > 0 ? c.size : 'unknown'}`,
      `recovered category: ${bounded(c.recoveredType?.category ?? c.type?.kind ?? 'unknown')}`,
      `type proven: ${c.recoveredType?.proven === true}`, `reads: ${c.readCount ?? 'unknown'}`, `writes: ${c.writeCount ?? 'unknown'}`];
    for (const { ctx } of contexts) parts.push(`release method: ${bounded(ctx.name ? (demangleCxx(ctx.name) ?? ctx.name) : `0x${BigInt(ctx.address).toString(16)}`)}; proven receiver: ${ctx.receiverProven === true}; uses: ${(ctx.accessRoles ?? []).filter(r => ['return-input', 'comparison-input', 'arithmetic-input', 'address-base'].includes(r)).join(', ') || 'unclassified'}`);
    return [`c${index}`, parts.join(' | ')];
  }));
  return { model: 'openjev', state: { userPhrase: query, queryKind: 'partial', candidateDescriptionsAreBinaryDerived: true },
    questions: { pick: { type: 'choice', instructions: INSTRUCTION, criteria },
      unique: { type: 'noul', instructions: 'Does the user phrase uniquely identify one of these candidates without additional context?',
        criteria: { true: 'The phrase distinguishes one field', false: 'Several fields plausibly fit' } } } };
}

// Prospective V3 representation. Preserve the V2 projector for historical
// replay; these extra roles come only from the canonical machine IR producer.
export function jevValueFlowRequest(query, views) {
  const body=jevAdvisoryRequest(query,views);
  body.questions.pick.instructions+=' Machine store roles distinguish caller-derived input from exact 0 or 1 assignments. Recovered categories describe machine use, not declared source types: a one-byte zero write can be a string terminator or padding, not a boolean field. Construction-only writes do not establish runtime state or completion. For a current-state question prefer matching runtime reads or updates over construction-only initialization. A 1 assigned during a relevant runtime operation can mark that operation having occurred; this is contextual support, not proof of its purpose. Indistinguishable use contexts remain ambiguous.';
  for(let index=0;index<views.length;index++) {
    const flows=(views[index].functionContexts??[]).slice(0,64).flatMap(context=>{
      const roles=(context.accessRoles??[]).filter(role=>['constant-written','argument-written','zero-written','one-written'].includes(role));
      if(!roles.length)return [];
      const method=context.name?(demangleCxx(context.name)??context.name):`0x${BigInt(context.address).toString(16)}`;
      return [`release method: ${bounded(method)}; store roles: ${roles.join(', ')}`];
    }).slice(0,8);
    if(flows.length)body.questions.pick.criteria[`c${index}`]+=' | '+flows.join(' | ');
    const contexts=(views[index].functionContexts??[]).slice(0,64);
    if(contexts.length&&contexts.every(context=>{
      const name=context.name?demangleCxx(context.name):null;
      if(!name)return false;
      const parts=name.split('(')[0].split('::'),owner=parts.at(-2)?.split('<')[0],method=parts.at(-1);
      return method===owner||method===`~${owner}`;
    }))body.questions.pick.criteria[`c${index}`]+=' | observed access context: construction/destruction only; runtime use unavailable';
  }
  return body;
}

// Prospective V4: a bounded observation of an input register copied into the
// member. The release ABI symbol is already present above. Never substitute a
// parameter name or an oracle-declared field type for this machine observation.
export function jevArgumentFlowRequest(query, views) {
  const body=jevValueFlowRequest(query,views);
  body.questions.pick.instructions=body.questions.pick.instructions.replace(
    'Constructor and shared-method accesses do not distinguish individual unnamed members.',
    'A shared method name alone does not distinguish individual unnamed members; separately tracked input sources and machine use roles may distinguish its accesses.');
  body.questions.pick.instructions+=' Input register writes identify machine-copy sources, possibly truncated to the member width. Use the release function signature and proven receiver ABI role as context. These observations do not recover a source parameter name or declare a field type. Separate a value supplied by a caller from literal default initialization. Caller-supplied properties may be initialized only once; the absence of an observed runtime write does not exclude them. Match the requested owning object before action words in helper classes.';
  body.questions.pick.instructions+=' A single-bit input write records the indicated bit of an entry argument, not a guessed field type. For a question about a configurable setting, prefer the caller-supplied setting stored by a matching setter over a neighbouring literal 1 that may indicate the setter ran. For a question about whether an operation finished, a completion marker may instead be relevant. Distinguish the requested setting from the operation that changes it.';
  for(let index=0;index<views.length;index++) {
    const inputs=(views[index].functionContexts??[]).slice(0,64).flatMap(context=>{
      const registers=(context.writtenArgumentRegisters??[]).slice(0,8).filter(value=>typeof value==='string'&&/^x[0-7]$/.test(value));
      const bits=argumentBitsFor(context);
      if(!registers.length&&!bits.length)return [];
      const role=['this','typed-argument'].includes(context.receiverRole)?context.receiverRole:'unknown';
      const method=context.name?(demangleCxx(context.name)??context.name):`0x${BigInt(context.address).toString(16)}`;
      const sources=registers.length?`entry-register write: ${[...new Set(registers)].sort().join(', ')}`:'';
      const bitSources=bits.length?`entry-argument bit write: ${[...new Set(bits)].sort().map(value=>value.replace(':','[')+']').join(', ')}`:'';
      return [[sources,bitSources,context.writtenArgumentBitsTruncated===true?'input-bit context truncated; additional sources unavailable':'',
        `receiver ABI role: ${role}`,`release method: ${bounded(method)}`].filter(Boolean).join('; ')];
    }).slice(0,8);
    if(inputs.length)body.questions.pick.criteria[`c${index}`]+=` | ${inputs.join(' | ')}`;
  }
  return body;
}

// Prospective automatic routing, kept explicitly disabled by its caller until
// an independent evaluation authorizes activation. Serialized views are useful
// for evaluation; the live wrapper below obtains them from branded evidence.
export function jevSemanticRoute(query,views,{verdict='none',topKey=null,policy='legacy'}={}) {
  const skip=reason=>Object.freeze({call:false,reason});
  if(['confirmed','likely'].includes(verdict))return skip('strong-local-result');
  if(!['legacy','object-context-v4'].includes(policy))return skip('unsupported-routing-policy');
  if(!Array.isArray(views)||views.length>400
    ||views.some(view=>view?.source!=='cxx'||view.anonymous!==true))return skip('unsupported-lattice');
  views=views.filter(view=>!view.conflict);
  if(views.length<2)return skip('insufficient-eligible-candidates');
  const tokens=new Set(cxxQueryTokens(query));
  const scores=(policy==='object-context-v4'?cxxObjectSemanticScores:cxxSemanticScores)(query,views)
    .sort(compareCxxSemanticScores);
  const best=scores[0],owner=cxxQueryTokens(views[best.index].className);
  const ownerScore=2*owner.filter(token=>tokens.has(token)).length;
  if(policy==='object-context-v4'&&best.key===topKey&&best.score>ownerScore) {
    const related=context=>{
      const method=context.name?(demangleCxx(context.name)??context.name).split('(')[0].split('::').at(-1):'';
      return cxxQueryTokens(method).some(token=>tokens.has(token)&&!owner.includes(token));
    };
    const callerInput=context=>context.receiverProven===true
      &&((context.writtenArgumentRegisters??[]).some(register=>typeof register==='string'&&/^x[0-7]$/.test(register))
        ||argumentBitsFor(context).length>0);
    const localView=views[best.index],localInputs=localView.functionContexts.filter(context=>related(context)&&callerInput(context));
    const peers=views.filter(view=>view.key!==topKey&&view.className===localView.className
      &&view.functionContexts.some(related));
    if(localInputs.length&&peers.length&&peers.every(peer=>peer.functionContexts.filter(related).every(context=>
      localInputs.some(input=>input.address===context.address)&&!callerInput(context)
      &&context.accessRoles?.some(role=>role==='zero-written'||role==='one-written'))))
      return skip('local-caller-input-versus-literal-markers');
  }
  const unique=policy==='object-context-v4'
    ?best.objectMatches>scores[1].objectMatches||best.objectMatches===scores[1].objectMatches&&best.score>scores[1].score
    :best.score>scores[1].score;
  if(best.key===topKey&&best.score>ownerScore&&unique
    &&views[best.index].functionContexts.some(context=>context.accessRoles?.includes('return-input')))
    return skip('unique-local-accessor');
  const runtime=views.some(view=>(view.functionContexts??[]).some(context=>{
    const name=context.name?demangleCxx(context.name):null;
    if(!name)return false;
    const parts=name.split('(')[0].split('::'),owner=parts.at(-2)?.split('<')[0],method=parts.at(-1);
    return method!==owner&&method!==`~${owner}`;
  }));
  if(runtime)return Object.freeze({call:true,reason:'anonymous-runtime-context'});
  if(policy==='object-context-v4') {
    const queryTokens=new Set(cxxRecoveryTokens(query));
    const callerInput=views.some(view=>cxxRecoveryTokens(view.className.split('::').at(-1)).some(token=>queryTokens.has(token))
      &&(view.functionContexts??[]).some(context=>context.receiverProven===true
        &&(context.writtenArgumentRegisters?.some(register=>typeof register==='string'&&/^x[0-7]$/.test(register))
          ||argumentBitsFor(context).length)));
    if(callerInput)return Object.freeze({call:true,reason:'anonymous-caller-input-context'});
  }
  return skip('insufficient-runtime-context');
}

export function jevMemberContextSignature(view) {
  const byAddress=new Map();
  for(const context of (view?.functionContexts??[]).slice(0,64)) {
    const roles=byAddress.get(context.address)??new Set();
    for(const role of context.accessRoles??[])roles.add(role);
    byAddress.set(context.address,roles);
  }
  return JSON.stringify([view?.className,[...byAddress].map(([address,roles])=>[address,[...roles].sort()])
    .sort((a,b)=>String(a[0]).localeCompare(String(b[0])))]);
}

export function jevArgumentContextSignature(view) {
  const byAddress=new Map();
  for(const context of (view?.functionContexts??[]).slice(0,64)) {
    const entry=byAddress.get(context.address)??{roles:new Set(),registers:new Set(),bits:new Set(),receiverRoles:new Set(),truncated:false};
    for(const role of context.accessRoles??[])entry.roles.add(role);
    for(const register of context.writtenArgumentRegisters??[])if(typeof register==='string'&&/^x[0-7]$/.test(register))entry.registers.add(register);
    for(const bit of argumentBitsFor(context))entry.bits.add(bit);
    if(context.writtenArgumentBitsTruncated===true)entry.truncated=true;
    if(['this','typed-argument'].includes(context.receiverRole))entry.receiverRoles.add(context.receiverRole);
    byAddress.set(context.address,entry);
  }
  return JSON.stringify([view?.className,[...byAddress].map(([address,entry])=>
    [address,[...entry.roles].sort(),[...entry.registers].sort(),[...entry.bits].sort(),[...entry.receiverRoles].sort(),entry.truncated])
    .sort((a,b)=>String(a[0]).localeCompare(String(b[0])))]);
}

// The ambiguity veto may use only context actually shown to the remote model.
// Hidden/truncated provenance, layout and unnamed code addresses cannot make
// two otherwise identical descriptions semantically distinguishable.
export function jevVisibleArgumentContextSignature(query,view) {
  const description=jevArgumentFlowRequest(query,[view]).questions.pick.criteria.c0;
  const prefix=jevArgumentFlowRequest(query,[{...view,functionContexts:[]}]).questions.pick.criteria.c0;
  const context=[...new Set(description.slice(prefix.length).split(' | ')
    .map(part=>part.replace(/release method: 0x[0-9a-f]+/g,'release method: unnamed')).filter(Boolean))].sort();
  return JSON.stringify([bounded(view?.className),context]);
}

export function createJevMemberClient({apiKey,symbols,fetchImpl=fetch,representation='value-flow-v3'}={}) {
  if(typeof apiKey!=='string'||!apiKey.trim()||apiKey.length>4096)return null;
  if(!['value-flow-v3','argument-flow-v4'].includes(representation))return null;
  return Object.freeze({async call({query,candidates,signal}) {
    if(!Array.isArray(candidates)||candidates.length<2||candidates.length>255)return null;
    const contexts=cxxSemanticViews(candidates,symbols);
    if(!contexts||contexts.some(context=>!context))return null;
    const views=contexts.map((context,index)=>({...context,offset:candidates[index].offset,
      size:candidates[index].size,recoveredType:candidates[index].recoveredType,
      readCount:candidates[index].field.readCount,writeCount:candidates[index].field.writeCount}));
    const response=await fetchImpl('https://api.openjev.sh/v1/systemone',{
      method:'POST',headers:{authorization:`Bearer ${apiKey.trim()}`,'content-type':'application/json'},
      body:JSON.stringify((representation==='argument-flow-v4'?jevArgumentFlowRequest:jevValueFlowRequest)(query,views)),signal});
    if(!response.ok)return null;
    const payload=await response.json(),pick=payload?.answers?.pick,unique=payload?.answers?.unique;
    const unit=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=1;
    if(payload?.model!=='openjev'||pick?.type!=='choice'||!/^c(?:0|[1-9]\d*)$/.test(pick.choice??'')
      ||!unit(pick.confidence)||!pick.probabilities||typeof pick.probabilities!=='object'
      ||Array.isArray(pick.probabilities)||Object.keys(pick.probabilities).length>candidates.length
      ||!unit(pick.probabilities[pick.choice])||unique?.type!=='noul'||!unit(unique.noul))return null;
    const index=Number(pick.choice.slice(1));
    if(!Number.isSafeInteger(index)||index>=candidates.length||candidates[index].field.conflict)return null;
    for(const [key,probability] of Object.entries(pick.probabilities))
      if(!/^c(?:0|[1-9]\d*)$/.test(key)||Number(key.slice(1))>=candidates.length||!unit(probability))return null;
    return {selectedKey:candidates[index].key,choiceIndex:index};
  }});
}

export async function rerankAnonymousCxx(query,local,options={}) {
  const fallback=()=>rerankWithJev(query,local);
  if(options.enabled!==true||typeof options.isCurrent!=='function'
    ||options.mode!=null&&options.mode!=='partial'||typeof options.client?.call!=='function')return fallback();
  if(options.representation!=null&&!['value-flow-v3','argument-flow-v4'].includes(options.representation))return fallback();
  try {
    if(options.isCurrent()!==true||local?.candidates?.some(candidate=>candidate.askedByName))return fallback();
    const contexts=cxxSemanticViews(local?.candidates,options.symbols);
    if(!contexts||contexts.some(context=>!context))return fallback();
    const views=contexts.map((context,index)=>({...context,anonymous:local.candidates[index].anonymous}));
    if(!jevSemanticRoute(query,views,{verdict:local.verdict,topKey:local.top?.key,
      policy:options.routingPolicy??'legacy'}).call)return fallback();
    const client={call:async input=>{
      const response=await options.client.call(input);
      if(!response)return null;
      const selected=typeof response.selectedKey==='string'?views.find(view=>view.key===response.selectedKey)
        :Number.isInteger(response.choiceIndex)?views.find(view=>view.key===input.candidates[response.choiceIndex]?.key):null;
      if(!selected)return null;
      if(selected.functionContexts.some(context=>context.writtenArgumentBitsTruncated===true))return null;
      const signatureFor=options.representation==='argument-flow-v4'
        ?view=>jevVisibleArgumentContextSignature(query,view):jevMemberContextSignature;
      const signature=signatureFor(selected);
      // Offsets, widths and read/write totals alone cannot distinguish meaning.
      if(selected.conflict||views.some(view=>!view.conflict&&view.key!==selected.key&&signatureFor(view)===signature))return null;
      return response;
    }};
    const eligible={...local,candidates:local.candidates.filter(candidate=>!candidate.field.conflict)};
    const result=await rerankWithJev(query,eligible,{...options,enabled:true,mode:'partial',client,maxChoices:255});
    return result.source==='jev'?{...result,hexResult:local}:fallback();
  }catch{return fallback();}
}

export async function requestJevAlternative(query, local, options = {}) {
  const fallback = () => adviseWithJev(query, local);
  try {
  if (options.enabled !== true || options.mode != null && options.mode !== 'partial'
    || typeof options.isCurrent !== 'function' || options.isCurrent() !== true
    || typeof options.apiKey !== 'string' || !options.apiKey.trim() || options.apiKey.length > 4096
    || typeof query !== 'string' || query.length > 2048 || !Array.isArray(local?.candidates)
    || local.candidates.some(c => c.source !== 'cxx' || c.anonymous !== true || c.askedByName)) return fallback();
  } catch (_) { return fallback(); }
  const client = { async call({ query: phrase, candidates, signal }) {
    const contexts = cxxSemanticViews(candidates, options.symbols);
    if (!contexts || contexts.some(c => !c)) return null;
    const views = candidates.map((c, i) => ({ ...contexts[i], offset: c.offset, size: c.size,
      recoveredType: c.recoveredType, type: c.type ?? c.field.type,
      readCount: c.field.readCount, writeCount: c.field.writeCount }));
    const response = await (options.fetchImpl ?? fetch)('https://api.openjev.sh/v1/systemone', {
      method: 'POST', headers: { authorization: `Bearer ${options.apiKey.trim()}`, 'content-type': 'application/json' },
      body: JSON.stringify(jevAdvisoryRequest(phrase, views)), signal,
    });
    if (!response.ok) return null;
    const payload = await response.json(), pick = payload?.answers?.pick, unique = payload?.answers?.unique;
    const unit = n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
    if (payload?.model !== 'openjev' || pick?.type !== 'choice' || !/^c(?:0|[1-9]\d*)$/.test(pick.choice ?? '')
      || !unit(pick.confidence) || !unit(pick.probabilities?.[pick.choice]) || unique?.type !== 'noul' || !unit(unique.noul)) return null;
    const index = Number(pick.choice.slice(1));
    if (!Number.isSafeInteger(index) || index >= candidates.length || candidates[index].field.conflict) return null;
    for (const [key, probability] of Object.entries(pick.probabilities))
      if (!/^c(?:0|[1-9]\d*)$/.test(key) || Number(key.slice(1)) >= candidates.length || !unit(probability)) return null;
    return { selectedKey: candidates[index].key, choiceIndex: index };
  } };
  return adviseWithJev(query, local, { enabled: true, mode: 'partial', maxChoices: 255,
    timeoutMs: 15000, signal: options.signal, isCurrent: options.isCurrent, client });
}
