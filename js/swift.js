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

async function relativePointerSection(read,range,budget,parser){const items=[];if(!range)return{items,completeness:{present:false,declared:0,scanned:0,parsed:0,capped:false,unreadableEntries:0,invalidEntries:0,misalignedBytes:0,complete:true}};const size=range.size,misalignedBytes=Number(size%4n),declared=Number(size/4n),count=Math.min(declared,budget);let scanned=0,unreadableEntries=0,invalidEntries=0;for(let i=0;i<count;i++){const field=range.addr+BigInt(i*4),b=await exact(read,field,4);if(!b){unreadableEntries++;break;}scanned++;const target=rel(field,i32(b,0));if(target==null){invalidEntries++;continue;}try{const value=await parser(read,target);if(value)items.push(value);else invalidEntries++;}catch{invalidEntries++;}}const capped=declared>budget,complete=misalignedBytes===0&&!capped&&unreadableEntries===0&&invalidEntries===0&&scanned===declared&&items.length===declared;return{items,completeness:{present:true,declared,scanned,parsed:items.length,capped,unreadableEntries,invalidEntries,misalignedBytes,complete}};}

export async function buildSwiftMetadataModel(read,sections,opts={}){
  const budget=normalizeBudget(opts.budget,DEFAULT_BUDGET,100000), typeSec=sectionRange(sections,['__swift5_types']), protoSec=sectionRange(sections,['__swift5_protos']), confSec=sectionRange(sections,['__swift5_proto']);
  const typeScan=await relativePointerSection(read,typeSec,budget,parseSwiftNominalDescriptor), protoScan=await relativePointerSection(read,protoSec,budget,parseSwiftProtocolDescriptor), confScan=await relativePointerSection(read,confSec,budget,(r,a)=>parseSwiftConformanceDescriptor(r,a,opts));
  const types=typeScan.items,protocols=protoScan.items,conformances=confScan.items;
  for(const t of types)if(t.fieldDescriptor!=null){try{t.fields=await parseSwiftFieldDescriptor(read,t.fieldDescriptor,Math.min(budget,4096));}catch{t.fields=[];typeScan.completeness.complete=false;typeScan.completeness.invalidEntries++;}}
  const vtables=[];let vtablesComplete=true;for(const v of opts.vtables||[]){const methods=await parseSwiftVTable(read,v.address,v.count,budget),expected=Math.min(normalizeBudget(v.count,0,100000),budget),x={...v,methods};if(methods.length!==expected||Number(v.count)>budget)vtablesComplete=false;vtables.push(x);const owner=types.find((t)=>t.address.toString()===String(v.typeAddress));if(owner){owner.vtable=methods;owner.methods=methods;}}
  const witnessTables=[];let witnessTablesComplete=true;for(const w of opts.witnessTables||[]){const entries=await parseSwiftWitnessTable(read,w.address,w.count,budget,opts),expected=Math.min(normalizeBudget(w.count,0,100000),budget);if(entries.length!==expected||Number(w.count)>budget||entries.some((x)=>x.resolved!==true))witnessTablesComplete=false;witnessTables.push({...w,entries});}
  const completeness={types:typeScan.completeness,protocols:protoScan.completeness,conformances:confScan.completeness,vtables:{complete:vtablesComplete},witnessTables:{complete:witnessTablesComplete}};
  completeness.complete=Object.values(completeness).every((x)=>x?.complete===true);
  return{runtime:'swift',types,protocols,conformances,vtables,witnessTables,completeness,complete:completeness.complete,warnings:[]};
}

function preferredTypeName(t){return t.qualifiedName||t.fullName||(t.moduleName&&t.name?`${t.moduleName}.${t.name}`:t.name)||null;}
function preferredProtocolName(p){return p.qualifiedName||p.fullName||(p.moduleName&&p.name?`${p.moduleName}.${p.name}`:p.name)||null;}
function canonicalTypeKey(t){return t?.address!=null?`type@${t.address.toString()}`:null;}
function canonicalProtocolKey(p){return p?.address!=null?`protocol@${p.address.toString()}`:null;}
function addNameCandidate(map,name,value){if(!name)return;let items=map.get(name);if(!items)map.set(name,items=[]);if(!items.includes(value))items.push(value);}
function finalizeUniqueNames(candidates,out){for(const [name,items] of candidates)if(items.length===1)out.set(name,items[0]);}
function resolveTypeIdentity(index,value){if(value==null)return null;const raw=String(value);if(raw.startsWith('type@')&&index.typesByAddress.has(raw.slice(5)))return raw;const byAddress=index.typesByAddress.get(raw);if(byAddress)return canonicalTypeKey(byAddress);const byName=index.typesByName.get(raw);return byName?canonicalTypeKey(byName):null;}
function resolveProtocolIdentity(index,value){if(value==null)return null;const raw=String(value);if(raw.startsWith('protocol@')&&index.protocolsByAddress.has(raw.slice(9)))return raw;const byAddress=index.protocolsByAddress.get(raw);if(byAddress)return canonicalProtocolKey(byAddress);const byName=index.protocolsByName.get(raw);return byName?canonicalProtocolKey(byName):null;}

export function buildSwiftRuntimeIndex(model={}){
  const typesByAddress=new Map(),typesByName=new Map(),typesBySimpleName=new Map(),protocolsByAddress=new Map(),protocolsByName=new Map(),protocolsBySimpleName=new Map();
  const typeNameCandidates=new Map(),protocolNameCandidates=new Map(),conformancesByType=new Map(),vtablesByType=new Map(),witnessesByPair=new Map();
  for(const t of model.types||[]){if(t.address!=null)typesByAddress.set(t.address.toString(),t);if(t.name){let a=typesBySimpleName.get(t.name);if(!a)typesBySimpleName.set(t.name,a=[]);a.push(t);addNameCandidate(typeNameCandidates,t.name,t);addNameCandidate(typeNameCandidates,preferredTypeName(t),t);}}
  finalizeUniqueNames(typeNameCandidates,typesByName);
  for(const p of model.protocols||[]){if(p.address!=null)protocolsByAddress.set(p.address.toString(),p);if(p.name){let a=protocolsBySimpleName.get(p.name);if(!a)protocolsBySimpleName.set(p.name,a=[]);a.push(p);addNameCandidate(protocolNameCandidates,p.name,p);addNameCandidate(protocolNameCandidates,preferredProtocolName(p),p);}}
  finalizeUniqueNames(protocolNameCandidates,protocolsByName);
  for(const c of model.conformances||[]){const type=c.typeReferenceKind<=1&&c.typeRef!=null?typesByAddress.get(c.typeRef.toString())||null:null,proto=protocolsByAddress.get(c.protocol?.toString())||null,typeKey=canonicalTypeKey(type),protoKey=canonicalProtocolKey(proto);if(typeKey){let a=conformancesByType.get(typeKey);if(!a){a=[];conformancesByType.set(typeKey,a);}a.push({...c,typeName:preferredTypeName(type),typeIdentity:typeKey,protocolName:preferredProtocolName(proto||{}),protocolIdentity:protoKey});if(protoKey)witnessesByPair.set(`${typeKey}:${protoKey}`,c);}}
  for(const v of model.vtables||[]){const owner=typesByAddress.get(String(v.typeAddress))||(v.typeName?typesByName.get(v.typeName):null),key=canonicalTypeKey(owner);if(key)vtablesByType.set(key,v.methods||[]);}for(const t of model.types||[]){const key=canonicalTypeKey(t);if(key&&t.vtable?.length)vtablesByType.set(key,t.vtable);}
  return{runtime:'swift',model,typesByAddress,typesByName,typesBySimpleName,protocolsByAddress,protocolsByName,protocolsBySimpleName,conformancesByType,vtablesByType,witnessesByPair};
}

export function resolveSwiftDispatch(index,call={}){
  if(!call)return{resolved:null,candidates:[],confidence:0,complete:false};
  if(call.target!=null)return{kind:'direct',resolved:{target:call.target,name:call.name||null},candidates:[],confidence:call.name?0.99:0.9,complete:true};
  if(!index)return{kind:call.kind||'indirect',resolved:null,candidates:[],confidence:0,complete:false};
  const universeComplete=index.model?.complete===true;
  if(call.kind==='vtable'&&(call.typeAddress!=null||call.typeName!=null)&&call.slot!=null){const typeKey=resolveTypeIdentity(index,call.typeAddress??call.typeName);if(!typeKey)return{kind:'vtable',resolved:null,candidates:[],confidence:0.2,complete:universeComplete};const methods=index.vtablesByType.get(typeKey)||[],m=methods.find((x)=>x.index===Number(call.slot));return m?{kind:'vtable',resolved:m,candidates:[m],confidence:0.9,complete:true}:{kind:'vtable',resolved:null,candidates:[],confidence:0.2,complete:universeComplete};}
  if((call.kind==='witness'||call.kind==='existential')&&(call.typeAddress!=null||call.typeName)&&(call.protocolAddress!=null||call.protocolName)&&call.slot!=null){const typeKey=resolveTypeIdentity(index,call.typeAddress??call.typeName),protoKey=resolveProtocolIdentity(index,call.protocolAddress??call.protocolName);if(!typeKey||!protoKey)return{kind:call.kind,resolved:null,candidates:[],confidence:0.2,conformance:null,complete:universeComplete};const conf=index.witnessesByPair.get(`${typeKey}:${protoKey}`),table=(index.model.witnessTables||[]).find((w)=>{if(conf?.witnessTable!=null&&String(w.address)===conf.witnessTable.toString())return true;const wType=resolveTypeIdentity(index,w.typeAddress??w.typeName),wProto=resolveProtocolIdentity(index,w.protocolAddress??w.protocolName);return wType===typeKey&&wProto===protoKey;}),entry=table?.entries?.find((x)=>x.index===Number(call.slot));if(entry)return{kind:call.kind,resolved:entry,candidates:[entry],confidence:0.86,conformance:conf||null,complete:true};return{kind:call.kind,resolved:null,candidates:[],confidence:conf?0.55:0.2,conformance:conf||null,complete:universeComplete};}
  return{kind:call.kind||'indirect',resolved:null,candidates:[],confidence:0.15,complete:universeComplete};
}

export function swiftCallingConvention({name='',mangled='',metadata=null,attributes=null}={}){const sym=demangleSwiftSymbol(mangled||name),a=attributes||{},async=a.async!=null?!!a.async:!!sym.async,throws=a.throws!=null?!!a.throws:!!sym.throws;return{runtime:'swift',swiftself:a.swiftself!==false,swiftasync:async,swiftthrows:throws,indirectResult:!!a.indirectResult,context:a.context!==false,errorResult:throws||!!a.errorResult,metadataArguments:Number(a.metadataArguments||(metadata?.generic?1:0)),representation:async&&throws?'await-throwing':async?'await':throws?'throwing':'normal'};}
const SWIFT_NOISE=[/^_?swift_(retain|release|bridgeObjectRetain|bridgeObjectRelease|unknownObjectRetain|unknownObjectRelease|beginAccess|endAccess|copyPOD|destroyPOD)\b/,/^_?swift_get(TypeByMangledName|SingletonMetadata|GenericMetadata|WitnessTable|AssociatedTypeWitness)\b/,/metadata accessor/i,/(copy|destroy) value witness/i];
export function classifySwiftRuntimeCall(name){const n=String(name||'');if(SWIFT_NOISE.some((r)=>r.test(n)))return{runtime:'swift',noise:true,category:/metadata|TypeBy|Metadata/.test(n)?'metadata':'ownership',name:n};if(/^_?swift_/.test(n)||/^_?\$s/.test(n))return{runtime:'swift',noise:false,category:'runtime',name:n};return null;}
export function formatSwiftCall(name,args=[],convention={}){const cc=convention.representation?convention:swiftCallingConvention({name,attributes:convention}),readable=demangleSwiftSymbol(name).demangled||name||'unknown_call',prefix=cc.swiftasync?'await ':'',throwing=cc.swiftthrows?'try ':'';return`${throwing}${prefix}${readable}(${args.join(', ')})`;}
