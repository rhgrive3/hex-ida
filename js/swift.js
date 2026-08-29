/* Swift ABI metadata intelligence. */
const MAX_NAME = 512;
const DEFAULT_BUDGET = 20000;

function u16(b, o = 0) { return b[o] | (b[o + 1] << 8); }
function u32(b, o = 0) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
function i32(b, o = 0) { return u32(b, o) | 0; }
function u64(b, o = 0) { let v = 0n; for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[o + i]); return v; }
function rel(fieldAddress, raw) { return raw ? BigInt(fieldAddress) + BigInt(raw) : null; }

async function exact(read, addr, len) { if (addr == null || len <= 0) return null; const b = await read(BigInt(addr), len); return b && b.length >= len ? b.subarray(0, len) : null; }
async function cstring(read, addr, max = MAX_NAME) {
  if (addr == null) return null;
  const b = await read(BigInt(addr), max); if (!b || !b.length) return null;
  let end = 0;
  for (; end < b.length && b[end]; end++) if (b[end] < 0x20 || b[end] === 0x7f) return null;
  if (!end || end === b.length) return null;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(b.subarray(0, end)); } catch { return null; }
}
function contextKind(flags) { switch (flags & 0x1f) { case 0:return 'module'; case 1:return 'extension'; case 2:return 'anonymous'; case 3:return 'protocol'; case 16:return 'class'; case 17:return 'struct'; case 18:return 'enum'; default:return 'unknown'; } }
function sectionRange(sections, wanted) {
  const list = Array.isArray(sections) ? sections : Object.values(sections || {});
  for (const s of list) { const name = s.section || s.name || s.sectname; if (!wanted.includes(name)) continue; const addr = s.vmAddr ?? s.addr ?? s.address, size = s.size ?? s.declaredSize ?? 0; if (addr != null && size != null) return { addr: BigInt(addr), size: BigInt(size), raw: s }; }
  return null;
}
function normalizeBudget(value, fallback = DEFAULT_BUDGET, max = 100000) { const n = Number(value); return Number.isFinite(Number(n)) && n > 0 ? Math.max(1, Math.min(Math.floor(n), max)) : fallback; }

export function demangleSwiftSymbol(symbol) {
  const original = String(symbol || ''), s = original.replace(/^_/, '');
  if (!s.startsWith('$s') && !s.startsWith('$S')) return { original, demangled: original, parsed: false, partial: null, unsupported: false, components: [] };
  let i = 2; const components = []; let malformed = false;
  while (i < s.length && components.length < 12) {
    const m = s.slice(i).match(/^(\d+)/); if (!m) break;
    const n = Number(m[1]); i += m[1].length;
    if (!(n > 0) || n > 512 || i + n > s.length) { malformed = true; break; }
    components.push(s.slice(i, i + n)); i += n;
  }
  const suffix = s.slice(i), suffixInfo = parseSupportedSwiftSuffix(suffix);
  const supported = !malformed && components.length > 0 && suffixInfo.supported;
  const partial = components.length ? components.join('.') + (suffixInfo.async ? ' async' : '') + (suffixInfo.throws ? ' throws' : '') : null;
  return {
    original,
    demangled: supported ? partial : original,
    parsed: supported,
    partial: supported ? null : partial,
    unsupported: components.length > 0 && !supported,
    components,
    suffix,
    async: supported && suffixInfo.async,
    throws: supported && suffixInfo.throws,
    accessor: supported ? suffixInfo.accessor : null,
  };
}

function parseSupportedSwiftSuffix(suffix) {
  if (!suffix) return { supported: true, async: false, throws: false, accessor: null };
  let rest = suffix, async = false, sawThrows = false, sawFunction = false, accessor = null;
  const atoms = ['Ya', 'Ma', 'Mf', 'ML', 'Mn', 'vg', 'vs', 'fC', 'fD', 'K', 'F', 'y'];
  while (rest) {
    const atom = atoms.find((value) => rest.startsWith(value));
    const throws = sawThrows && sawFunction;
    if (!atom) return { supported: false, async, throws, accessor };
    rest = rest.slice(atom.length);
    if (atom === 'Ya') async = true;
    else if (atom === 'K') sawThrows = true;
    else if (atom === 'F') sawFunction = true;
    else if (atom === 'Ma' || atom === 'Mf' || atom === 'ML' || atom === 'Mn') accessor = 'metadata';
  }
  return { supported: true, async, throws: sawThrows && sawFunction, accessor };
}

async function relativeString(read, fieldAddr, raw) { const target = rel(fieldAddr, raw); return target == null ? null : cstring(read, target); }

export async function parseSwiftNominalDescriptor(read, address) {
  const addr = BigInt(address);
  const prefix = await exact(read, addr, 20); if (!prefix) return null;
  const flags = u32(prefix, 0), kind = contextKind(flags); if (!['class','struct','enum'].includes(kind)) return null;
  const name = await relativeString(read, addr + 8n, i32(prefix, 8)); if (!name) return null;
  const out = { runtime:'swift', kind, address:addr, flags, name, parent:rel(addr+4n,i32(prefix,4)), metadataAccessor:rel(addr+12n,i32(prefix,12)), fieldDescriptor:rel(addr+16n,i32(prefix,16)), generic:!!(flags&0x80), unique:!!(flags&0x40), fields:[], methods:[], vtable:[], warnings:[] };
  if (kind === 'class') {
    const tail = await exact(read, addr + 20n, 24); if (!tail) return null;
    out.superclassType = rel(addr + 20n, i32(tail, 0)); out.metadataNegativeSizeInWords = u32(tail,4); out.metadataPositiveSizeInWords=u32(tail,8); out.numImmediateMembers=u32(tail,12); out.numFields=u32(tail,16); out.fieldOffsetVectorOffset=u32(tail,20);
  } else {
    const tail = await exact(read, addr + 20n, 8); if (!tail) return null;
    out.numFields=u32(tail,0); out.fieldOffsetVectorOffset=u32(tail,4);
  }
  return out;
}

export async function parseSwiftFieldDescriptor(read, address, budget = 4096) {
  if (address == null) return []; const addr=BigInt(address), h=await exact(read,addr,16); if(!h)return[];
  const recordSize=u16(h,10), count=u32(h,12), limit=normalizeBudget(budget,4096,100000); if(recordSize<12||count>limit)return[];
  const out=[]; for(let i=0;i<count;i++){const at=addr+16n+BigInt(i*recordSize),r=await exact(read,at,12);if(!r)break;const flags=u32(r,0),type=await relativeString(read,at+4n,i32(r,4)),name=await relativeString(read,at+8n,i32(r,8));out.push({index:i,flags,name:name||`field_${i}`,mangledType:type,indirect:!!(flags&1),var:!!(flags&2)});} return out;
}

export async function parseSwiftProtocolDescriptor(read,address){const addr=BigInt(address),b=await exact(read,addr,24);if(!b)return null;const flags=u32(b,0);if(contextKind(flags)!=='protocol')return null;const name=await relativeString(read,addr+8n,i32(b,8));if(!name)return null;return{runtime:'swift',kind:'protocol',address:addr,flags,name,parent:rel(addr+4n,i32(b,4)),numRequirementsInSignature:u32(b,12),numRequirements:u32(b,16),associatedTypeNames:rel(addr+20n,i32(b,20)),requirements:[]};}

async function resolveAbsolutePointer(read,address,options={}) {
  const b=await exact(read,address,8); if(!b)return null; const raw=u64(b);
  const resolver=options.resolvePointer||options.binaryImage?.resolvePointer||options.binaryImage?.decodePointer;
  if(typeof resolver==='function'){try{const v=await resolver(raw,{address:BigInt(address)});return v==null?null:BigInt(v);}catch{return null;}}
  return options.allowRawPointers===true ? (raw||null) : null;
}

async function resolveRelativeIndirectablePointer(read,fieldAddress,raw,options={}) {
  if(!raw)return null;
  const indirect=(raw&1)!==0;
  const offset=indirect?(raw&~1):raw;
  const target=BigInt(fieldAddress)+BigInt(offset);
  return indirect?resolveAbsolutePointer(read,target,options):target;
}

export async function parseSwiftConformanceDescriptor(read,address,options={}){
  const addr=BigInt(address),b=await exact(read,addr,16);if(!b)return null;
  const protocol=await resolveRelativeIndirectablePointer(read,addr,i32(b,0),options), rawTypeRef=rel(addr+4n,i32(b,4)), witnessTable=rel(addr+8n,i32(b,8)), flags=u32(b,12), typeReferenceKind=(flags>>>3)&7;
  if(protocol==null||rawTypeRef==null)return null;
  let typeRef=null, objcClassName=null, objcClassReference=null;
  if(typeReferenceKind===0) typeRef=rawTypeRef;
  else if(typeReferenceKind===1) typeRef=await resolveAbsolutePointer(read,rawTypeRef,options);
  else if(typeReferenceKind===2) objcClassName=await cstring(read,rawTypeRef);
  else if(typeReferenceKind===3) objcClassReference=rawTypeRef;
  return{runtime:'swift',kind:'conformance',address:addr,protocol,typeRef,rawTypeRef,objcClassName,objcClassReference,witnessTable,flags,typeReferenceKind,conditionalRequirements:(flags>>>8)&0xff,resilientWitnesses:!!(flags&(1<<16))};
}

export async function parseSwiftVTable(read,address,count,budget=4096){const n=Math.min(normalizeBudget(count,0,100000),normalizeBudget(budget,4096,100000)),out=[];let at=BigInt(address);for(let i=0;i<n;i++,at+=8n){const b=await exact(read,at,8);if(!b)break;const flags=u32(b,0),impl=rel(at+4n,i32(b,4));out.push({index:i,flags,impl,kind:flags&0x0f,instance:!!(flags&0x10),dynamic:!!(flags&0x20),async:!!(flags&0x40)});}return out;}

export async function parseSwiftWitnessTable(read,address,count,budget=4096,options={}){
  if (budget && typeof budget === 'object') { options=budget; budget=4096; }
  const n=Math.min(normalizeBudget(count,0,100000),normalizeBudget(budget,4096,100000)),out=[];let at=BigInt(address);
  const resolver=options.resolvePointer||options.binaryImage?.resolvePointer||options.binaryImage?.decodePointer;
  for(let i=0;i<n;i++,at+=8n){const b=await exact(read,at,8);if(!b)break;const raw=u64(b);let target=null;
    if(raw){if(typeof resolver==='function'){try{const v=await resolver(raw,{address:at});target=v==null?null:BigInt(v);}catch{target=null;}}else if(options.allowRawPointers===true)target=raw;}
    out.push({index:i,target,rawTarget:raw||null,resolved:target!=null});
  }return out;
}

function scanCompleteness({present=true,declared=0,scanned=0,parsed=0,capped=false,unreadableSlots=0,invalidEntries=0,unsupported=0,invalidTargets=0}={}) {
  return {present,declared,scanned,parsed,capped,unreadableSlots,invalidEntries,unsupported,invalidTargets,complete:!capped&&!unreadableSlots&&!invalidEntries&&!unsupported&&!invalidTargets};
}

async function relativePointerSection(read,range,budget,parser){
  const items=[];
  if(!range)return{items,status:scanCompleteness({present:false})};
  const declared64=range.size/4n;
  if(declared64>BigInt(Number.MAX_SAFE_INTEGER))return{items,status:scanCompleteness({declared:Number.MAX_SAFE_INTEGER,capped:true})};
  const declared=Number(declared64),count=Math.min(declared,budget);let scanned=0,unreadableSlots=0,invalidEntries=0;
  for(let i=0;i<count;i++){
    const field=range.addr+BigInt(i*4),b=await exact(read,field,4);
    if(!b){unreadableSlots++;continue;}
    scanned++;
    const target=rel(field,i32(b,0));
    if(target==null){invalidEntries++;continue;}
    try{const value=await parser(read,target);if(value)items.push(value);else invalidEntries++;}catch{invalidEntries++;}
  }
  return{items,status:scanCompleteness({declared,scanned,parsed:items.length,capped:declared>budget,unreadableSlots,invalidEntries})};
}

async function swiftContextIdentity(read,address,maxDepth=16){
  if(address==null)return{complete:false,moduleName:null,qualifiedName:null,components:[],reason:'missing-address'};
  let current=BigInt(address);const components=[],seen=new Set();
  for(let depth=0;depth<maxDepth;depth++){
    const key=current.toString();if(seen.has(key))return{complete:false,moduleName:null,qualifiedName:null,components,reason:'context-cycle'};seen.add(key);
    const b=await exact(read,current,12);if(!b)return{complete:false,moduleName:null,qualifiedName:null,components,reason:'context-unreadable'};
    const flags=u32(b,0),kind=contextKind(flags);
    if(!['module','class','struct','enum','protocol'].includes(kind))return{complete:false,moduleName:null,qualifiedName:null,components,reason:`unsupported-context-${kind}`};
    const name=await relativeString(read,current+8n,i32(b,8));if(!name)return{complete:false,moduleName:null,qualifiedName:null,components,reason:'context-name-unreadable'};
    components.unshift(name);
    if(kind==='module')return{complete:true,moduleName:name,qualifiedName:components.join('.'),components,reason:null};
    const parent=rel(current+4n,i32(b,4));if(parent==null)return{complete:false,moduleName:null,qualifiedName:null,components,reason:'context-parent-missing'};
    current=parent;
  }
  return{complete:false,moduleName:null,qualifiedName:null,components,reason:'context-depth-budget'};
}

function preferredTypeName(t){return t?.qualifiedName||t?.fullName||(t?.moduleName&&t?.name?`${t.moduleName}.${t.name}`:(t?.identityComplete===false?null:t?.name))||null;}
function addressKey(prefix,value){return value==null?null:`${prefix}@${BigInt(value).toString(16)}`;}
async function executableTarget(options,address){
  if(address==null)return{target:null,verified:false};
  const verify=options?.isExecutableAddress;
  if(typeof verify!=='function')return{target:null,verified:false};
  try{return await verify(BigInt(address))?{target:BigInt(address),verified:true}:{target:null,verified:false};}catch{return{target:null,verified:false};}
}
function vtableShape(type){
  if(type?.kind!=='class')return{present:false,eligible:false};
  const specific=(type.flags>>>16)&0xffff,hasVTable=!!(specific&(1<<15));
  if(!hasVTable)return{present:false,eligible:false};
  return{present:true,eligible:!type.generic&&!(specific&(1<<13))&&(specific&3)===0,specific};
}

export async function buildSwiftMetadataModel(read,sections,opts={}){
  const budget=normalizeBudget(opts.budget,DEFAULT_BUDGET,100000), typeSec=sectionRange(sections,['__swift5_types']), protoSec=sectionRange(sections,['__swift5_protos']), confSec=sectionRange(sections,['__swift5_proto']);
  const typeScan=await relativePointerSection(read,typeSec,budget,parseSwiftNominalDescriptor),protoScan=await relativePointerSection(read,protoSec,budget,parseSwiftProtocolDescriptor),confScan=await relativePointerSection(read,confSec,budget,(r,a)=>parseSwiftConformanceDescriptor(r,a,opts));
  const types=typeScan.items,protocols=protoScan.items,conformances=confScan.items,warnings=[];
  let identityResolved=0;
  for(const item of [...types,...protocols]){
    const identity=await swiftContextIdentity(read,item.address);
    item.identityComplete=identity.complete;item.contextIdentity=identity;
    if(identity.complete){item.moduleName=identity.moduleName;item.qualifiedName=identity.qualifiedName;identityResolved++;}
    else warnings.push(`Swift ${item.kind||'context'} ${item.name||item.address}: ${identity.reason}`);
  }
  const identityStatus=scanCompleteness({declared:types.length+protocols.length,scanned:types.length+protocols.length,parsed:identityResolved,invalidEntries:types.length+protocols.length-identityResolved});
  for(const t of types)if(t.fieldDescriptor!=null){try{t.fields=await parseSwiftFieldDescriptor(read,t.fieldDescriptor,Math.min(budget,4096));}catch{t.fields=[];warnings.push(`Swift fields unreadable for ${t.name||t.address}`);typeScan.status.complete=false;typeScan.status.invalidEntries=(typeScan.status.invalidEntries||0)+1;}}

  const vtables=[];let vtableDeclared=0,vtableUnsupported=0,vtableUnreadable=0,vtableInvalidTargets=0,vtableParsed=0;
  for(const t of types){
    const shape=vtableShape(t);if(!shape.present)continue;vtableDeclared++;
    if(!shape.eligible){vtableUnsupported++;warnings.push(`Swift vtable layout unsupported for ${t.name||t.address}`);continue;}
    const h=await exact(read,t.address+44n,8);if(!h){vtableUnreadable++;continue;}
    const offset=u32(h,0),count=u32(h,4),limit=Math.min(budget,4096);
    if(count>limit){vtableUnsupported++;warnings.push(`Swift vtable count exceeds budget for ${t.name||t.address}`);continue;}
    const methods=await parseSwiftVTable(read,t.address+52n,count,limit);if(methods.length!==count)vtableUnreadable++;
    const checked=[];
    for(const method of methods){const proof=await executableTarget(opts,method.impl);if(method.impl!=null&&!proof.verified)vtableInvalidTargets++;checked.push({...method,index:offset+method.index,rawImpl:method.impl,impl:proof.target,implementationVerified:proof.verified});}
    const table={typeAddress:t.address,typeName:preferredTypeName(t),address:t.address+52n,count,offset,source:'class-descriptor',methods:checked};vtables.push(table);t.vtable=checked;t.methods=checked;vtableParsed++;
  }
  for(const v of opts.vtables||[]){
    const methods=await parseSwiftVTable(read,v.address,v.count,budget),checked=[];
    for(const method of methods){const proof=await executableTarget(opts,method.impl);if(method.impl!=null&&!proof.verified)vtableInvalidTargets++;checked.push({...method,rawImpl:method.impl,impl:proof.target,implementationVerified:proof.verified});}
    const x={...v,methods:checked,source:v.source||'explicit'};vtables.push(x);const owner=types.find((t)=>t.address.toString()===String(v.typeAddress));if(owner){owner.vtable=checked;owner.methods=checked;}
  }
  const vtableStatus=scanCompleteness({present:vtableDeclared>0||vtables.length>0,declared:vtableDeclared+(opts.vtables||[]).length,scanned:vtableDeclared+(opts.vtables||[]).length,parsed:vtableParsed+(opts.vtables||[]).length,unsupported:vtableUnsupported,unreadableSlots:vtableUnreadable,invalidTargets:vtableInvalidTargets});

  const typesByAddress=new Map(types.filter((t)=>t.address!=null).map((t)=>[t.address.toString(),t])),protocolsByAddress=new Map(protocols.filter((p)=>p.address!=null).map((p)=>[p.address.toString(),p]));
  const witnessTables=[];let witnessDeclared=0,witnessUnsupported=0,witnessUnreadable=0,witnessInvalidTargets=0,witnessParsed=0;const seenWitness=new Set();
  const addWitness=async(seed)=>{
    const key=String(seed.address);if(seenWitness.has(key))return;seenWitness.add(key);witnessDeclared++;
    const count=Number(seed.count);if(!Number.isSafeInteger(count)||count<0||count>Math.min(budget,4096)){witnessUnsupported++;return;}
    const entries=await parseSwiftWitnessTable(read,seed.address,count,budget,opts);if(entries.length!==count)witnessUnreadable++;
    const checked=[];for(const entry of entries){const proof=await executableTarget(opts,entry.target);if(entry.rawTarget!=null&&!proof.verified)witnessInvalidTargets++;checked.push({...entry,rawResolvedTarget:entry.target,target:proof.target,resolved:proof.verified});}
    witnessTables.push({...seed,entries:checked});witnessParsed++;
  };
  for(const c of conformances){
    if(c.witnessTable==null)continue;
    const type=c.typeReferenceKind<=1&&c.typeRef!=null?typesByAddress.get(c.typeRef.toString()):null,proto=protocolsByAddress.get(c.protocol?.toString());
    if(!type||!proto||c.conditionalRequirements!==0||c.resilientWitnesses||proto.numRequirementsInSignature!==0){witnessDeclared++;witnessUnsupported++;continue;}
    await addWitness({address:c.witnessTable,typeAddress:type.address,protocolAddress:proto.address,typeName:preferredTypeName(type),protocolName:preferredTypeName(proto)||proto.name,count:proto.numRequirements,source:'conformance-descriptor'});
  }
  for(const w of opts.witnessTables||[])await addWitness({...w,source:w.source||'explicit'});
  const witnessStatus=scanCompleteness({present:witnessDeclared>0,declared:witnessDeclared,scanned:witnessDeclared,parsed:witnessParsed,unsupported:witnessUnsupported,unreadableSlots:witnessUnreadable,invalidTargets:witnessInvalidTargets});
  const completeness={types:typeScan.status,protocols:protoScan.status,conformances:confScan.status,identity:identityStatus,vtables:vtableStatus,witnessTables:witnessStatus};
  completeness.complete=Object.values(completeness).every((x)=>x&&x.complete===true);
  if(!completeness.complete)warnings.push('Swift runtime metadata is partial; negative dispatch results are not exhaustive');
  return{runtime:'swift',types,protocols,conformances,vtables,witnessTables,warnings,completeness,complete:completeness.complete,truncated:!completeness.complete};
}

export function buildSwiftRuntimeIndex(model={}){
  const typesByAddress=new Map(),typesByName=new Map(),typesBySimpleName=new Map(),protocolsByAddress=new Map(),protocolsByName=new Map(),protocolsBySimpleName=new Map();
  const conformancesByType=new Map(),conformancesByTypeId=new Map(),vtablesByType=new Map(),vtablesByTypeId=new Map(),witnessesByPair=new Map(),witnessesByPairId=new Map();
  for(const t of model.types||[]){if(t.address!=null)typesByAddress.set(t.address.toString(),t);if(t.name){let a=typesBySimpleName.get(t.name);if(!a)typesBySimpleName.set(t.name,a=[]);a.push(t);const q=preferredTypeName(t);if(q&&q!==t.name)typesByName.set(q,t);else if(q&&t.identityComplete!==false)typesByName.set(q,t);}}
  for(const [name,items] of typesBySimpleName)if(items.length===1&&items[0].identityComplete!==false)typesByName.set(name,items[0]);
  for(const p of model.protocols||[]){if(p.address!=null)protocolsByAddress.set(p.address.toString(),p);if(p.name){let a=protocolsBySimpleName.get(p.name);if(!a)protocolsBySimpleName.set(p.name,a=[]);a.push(p);const q=preferredTypeName(p);if(q&&q!==p.name)protocolsByName.set(q,p);else if(q&&p.identityComplete!==false)protocolsByName.set(q,p);}}
  for(const [name,items] of protocolsBySimpleName)if(items.length===1&&items[0].identityComplete!==false)protocolsByName.set(name,items[0]);
  for(const c of model.conformances||[]){const type=c.typeReferenceKind<=1&&c.typeRef!=null?typesByAddress.get(c.typeRef.toString())||null:null,proto=protocolsByAddress.get(c.protocol?.toString())||null;if(type){const id=addressKey('type',type.address),entry={...c,typeName:preferredTypeName(type),protocolName:preferredTypeName(proto)||proto?.name||null};let byId=conformancesByTypeId.get(id);if(!byId)conformancesByTypeId.set(id,byId=[]);byId.push(entry);const key=preferredTypeName(type);if(key){let a=conformancesByType.get(key);if(!a)conformancesByType.set(key,a=[]);a.push(entry);}if(proto){const pair=`${id}:${addressKey('protocol',proto.address)}`;witnessesByPairId.set(pair,c);const pName=preferredTypeName(proto);if(key&&pName)witnessesByPair.set(`${key}:${pName}`,c);}}}
  for(const v of model.vtables||[]){const owner=v.typeAddress!=null?typesByAddress.get(String(v.typeAddress)):null,id=addressKey('type',owner?.address??v.typeAddress),key=v.typeName||preferredTypeName(owner||{});if(id)vtablesByTypeId.set(id,v.methods||[]);if(key)vtablesByType.set(key,v.methods||[]);}
  for(const t of model.types||[]){const id=addressKey('type',t.address),key=preferredTypeName(t);if(id&&t.vtable?.length)vtablesByTypeId.set(id,t.vtable);if(key&&t.vtable?.length)vtablesByType.set(key,t.vtable);}
  return{runtime:'swift',model,completeness:model.completeness||null,typesByAddress,typesByName,typesBySimpleName,protocolsByAddress,protocolsByName,protocolsBySimpleName,conformancesByType,conformancesByTypeId,vtablesByType,vtablesByTypeId,witnessesByPair,witnessesByPairId};
}
function dispatchType(index,call){if(call.typeAddress!=null)return index.typesByAddress.get(String(call.typeAddress))||null;if(call.typeName!=null)return index.typesByName.get(String(call.typeName))||null;return null;}
function dispatchProtocol(index,call){if(call.protocolAddress!=null)return index.protocolsByAddress.get(String(call.protocolAddress))||null;if(call.protocolName!=null)return index.protocolsByName.get(String(call.protocolName))||null;return null;}
function dispatchComplete(index,kind){const c=index?.model?.completeness;return index?.model?.complete===true&&c?.[kind]?.complete===true;}

export function resolveSwiftDispatch(index,call={}){
  if(!call)return{resolved:null,candidates:[],confidence:0,complete:false};if(call.target!=null)return{kind:'direct',resolved:{target:call.target,name:call.name||null},candidates:[],confidence:call.name?0.99:0.9,complete:true};if(!index)return{kind:call.kind||'indirect',resolved:null,candidates:[],confidence:0,complete:false};
  if(call.kind==='vtable'&&call.slot!=null){const type=dispatchType(index,call),id=addressKey('type',type?.address),methods=(id&&index.vtablesByTypeId.get(id))||(call.typeName!=null?index.vtablesByType.get(call.typeName):null)||[],m=methods.find((x)=>x.index===Number(call.slot));const positive=!!m&&m.impl!=null;const complete=dispatchComplete(index,'vtables');return positive?{kind:'vtable',resolved:m,candidates:[m],confidence:0.9,complete:true}:{kind:'vtable',resolved:null,candidates:m?[m]:[],confidence:0.2,complete,partial:!complete,reason:type?'vtable slot unresolved':'Swift type identity is ambiguous or unavailable'};}
  if((call.kind==='witness'||call.kind==='existential')&&call.slot!=null){const type=dispatchType(index,call),proto=dispatchProtocol(index,call),pair=type&&proto?`${addressKey('type',type.address)}:${addressKey('protocol',proto.address)}`:null,conf=(pair&&index.witnessesByPairId.get(pair))||(call.typeName&&call.protocolName?index.witnessesByPair.get(`${call.typeName}:${call.protocolName}`):null),table=(index.model.witnessTables||[]).find((w)=>(conf?.witnessTable!=null&&String(w.address)===conf.witnessTable.toString())||(type&&proto&&String(w.typeAddress)===String(type.address)&&String(w.protocolAddress)===String(proto.address))),entry=table?.entries?.find((x)=>x.index===Number(call.slot));const positive=!!entry&&entry.target!=null,complete=dispatchComplete(index,'witnessTables');return positive?{kind:call.kind,resolved:entry,candidates:[entry],confidence:0.86,conformance:conf||null,complete:true}:{kind:call.kind,resolved:null,candidates:entry?[entry]:[],confidence:conf?0.55:0.2,conformance:conf||null,complete,partial:!complete,reason:type&&proto?'witness slot unresolved':'Swift type/protocol identity is ambiguous or unavailable'};}
  return{kind:call.kind||'indirect',resolved:null,candidates:[],confidence:0.15,complete:false};
}

export function swiftCallingConvention({name='',mangled='',metadata=null,attributes=null}={}){const sym=demangleSwiftSymbol(mangled||name),a=attributes||{},async=a.async!=null?!!a.async:!!sym.async,throws=a.throws!=null?!!a.throws:!!sym.throws;return{runtime:'swift',swiftself:a.swiftself!==false,swiftasync:async,swiftthrows:throws,indirectResult:!!a.indirectResult,context:a.context!==false,errorResult:throws||!!a.errorResult,metadataArguments:Number(a.metadataArguments||(metadata?.generic?1:0)),representation:async&&throws?'await-throwing':async?'await':throws?'throwing':'normal'};}
const SWIFT_NOISE=[/^_?swift_(retain|release|bridgeObjectRetain|bridgeObjectRelease|unknownObjectRetain|unknownObjectRelease|beginAccess|endAccess|copyPOD|destroyPOD)\b/,/^_?swift_get(TypeByMangledName|SingletonMetadata|GenericMetadata|WitnessTable|AssociatedTypeWitness)\b/,/metadata accessor/i,/(copy|destroy) value witness/i];
export function classifySwiftRuntimeCall(name){const n=String(name||'');if(SWIFT_NOISE.some((r)=>r.test(n)))return{runtime:'swift',noise:true,category:/metadata|TypeBy|Metadata/.test(n)?'metadata':'ownership',name:n};if(/^_?swift_/.test(n)||/^_?\$s/.test(n))return{runtime:'swift',noise:false,category:'runtime',name:n};return null;}
export function formatSwiftCall(name,args=[],convention={}){const cc=convention.representation?convention:swiftCallingConvention({name,attributes:convention}),readable=demangleSwiftSymbol(name).demangled||name||'unknown_call',prefix=cc.swiftasync?'await ':'',throwing=cc.swiftthrows?'try ':'';return`${throwing}${prefix}${readable}(${args.join(', ')})`;}
