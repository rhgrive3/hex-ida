from pathlib import Path

def read(path): return Path(path).read_text()
def write(path, text): Path(path).write_text(text)
def rep(path, old, new, count=1):
    s=read(path)
    if s.count(old) < count: raise SystemExit(f'expected source fragment missing in {path}: {old[:120]!r}')
    write(path, s.replace(old,new,count))

def replace_span(path,start_marker,end_marker,new_text):
    s=read(path); a=s.find(start_marker)
    if a<0: raise SystemExit(f'start marker missing in {path}')
    b=s.find(end_marker,a)
    if b<0: raise SystemExit(f'end marker missing in {path}')
    write(path,s[:a]+new_text+s[b:])

# #2424: only string payloads are legal for BigInt wire tags.
rep('js/debug/remote-protocol.js',
    "Object.keys(value).some((k) => ![WIRE_TAG, 'value'].includes(k)) || !/^-?\\d+$/.test(String(value.value || ''))",
    "Object.keys(value).some((k) => ![WIRE_TAG, 'value'].includes(k)) || typeof value.value !== 'string' || !/^-?\\d+$/.test(value.value)")

# #2377/#2378/#2382/#2397: one Swift runtime truth for identity, projection and completeness.
SWIFT_BLOCK = r'''function scanCompleteness({present=true,declared=0,scanned=0,parsed=0,capped=false,unreadableSlots=0,invalidEntries=0,unsupported=0,invalidTargets=0}={}) {
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

'''
replace_span('js/swift.js','async function relativePointerSection','export function swiftCallingConvention',SWIFT_BLOCK)
rep('js/app.js','const model=await buildSwiftMetadataModel(read,regions,{budget:20000});','const model=await buildSwiftMetadataModel(read,regions,{budget:20000,isExecutableAddress:(addr)=>!!this.executableRegionFor(addr)});')
rep('js/ai/ui/hex-context-legacy.js',"complete:result?.complete!==false && app.swiftModel?.complete!==false","complete:result?.complete===true && app.swiftModel?.complete===true")

# #2393: concrete ObjC IMPs need executable-mapping proof on the production path.
rep('js/objc-legacy.js','unreadableSlots: 0, invalidEntries: 0, invalidIvars: 0, incompleteMethodLists: 0,','unreadableSlots: 0, invalidEntries: 0, invalidIvars: 0, invalidImps: 0, incompleteMethodLists: 0,')
rep('js/objc-legacy.js','async function readMethods(get, listAddr, out, className, prefix, budget, completeness = null) {',"async function validateMethodImp(get, imp) {\n  if (imp == null || typeof get.isExecutableAddress !== 'function') return { known:false, valid:imp != null };\n  try { return { known:true, valid:!!(await get.isExecutableAddress(BigInt(imp))) }; } catch { return { known:true, valid:false }; }\n}\n\nasync function readMethods(get, listAddr, out, className, prefix, budget, completeness = null) {")
rep('js/objc-legacy.js',"""    if (imp == null) { markLegacyPartial(completeness, 'method-imp-unresolved', 'incompleteMethodLists'); continue; }
    const sel = await cstring(get, nameAddr);
    if (!sel) { markLegacyPartial(completeness, 'method-selector-invalid', 'incompleteMethodLists'); continue; }
    out.push({
      addr: imp,
      name: prefix + '[' + className + ' ' + sel + ']',
      sel, kind: prefix, className,
    });""","""    if (imp == null) { markLegacyPartial(completeness, 'method-imp-unresolved', 'incompleteMethodLists'); continue; }
    const rawImp = imp, impProof = await validateMethodImp(get, imp);
    if (impProof.known && !impProof.valid) { markLegacyPartial(completeness, 'method-imp-not-executable', 'invalidImps'); imp = null; }
    const sel = await cstring(get, nameAddr);
    if (!sel) { markLegacyPartial(completeness, 'method-selector-invalid', 'incompleteMethodLists'); continue; }
    out.push({
      addr: imp, rawImp, implementationVerified:impProof.known ? impProof.valid : undefined,
      name: prefix + '[' + className + ' ' + sel + ']',
      sel, kind: prefix, className,
    });""")
rep('js/objc-legacy.js',"""  const before = out.length;
  await readMethods(get, cleanPointer(get, u64(ro, RO_METHODS)), out, name,
    meta ? '+' : '-', MAX_METHODS, completeness);
  const methods = out.slice(before);""","""  const parsedMethods = [];
  await readMethods(get, cleanPointer(get, u64(ro, RO_METHODS)), parsedMethods, name,
    meta ? '+' : '-', MAX_METHODS, completeness);
  out.push(...parsedMethods.filter((method) => method.addr != null));
  const methods = parsedMethods;""")
rep('js/objc-legacy.js','export async function buildObjcModel(read, classList, onProgress, imageBase, pointerFormat) {','export async function buildObjcModel(read, classList, onProgress, imageBase, pointerFormat, opts = {}) {')
rep('js/objc-legacy.js','  get.pointerFormat = pointerFormat ?? classList.pointerFormat ?? classList.pointer_format ?? null;\n  const total = Math.min(declared, MAX_CLASSES);','  get.pointerFormat = pointerFormat ?? classList.pointerFormat ?? classList.pointer_format ?? null;\n  get.isExecutableAddress = opts.isExecutableAddress || null;\n  const total = Math.min(declared, MAX_CLASSES);')
rep('js/objc-legacy.js','export async function buildObjcNames(read, classList, onProgress, imageBase, pointerFormat) {\n  const model = await buildObjcModel(read, classList, onProgress, imageBase, pointerFormat);','export async function buildObjcNames(read, classList, onProgress, imageBase, pointerFormat, opts = {}) {\n  const model = await buildObjcModel(read, classList, onProgress, imageBase, pointerFormat, opts);')

rep('js/apple/objc-metadata.js','async function methodList(get, listAddr, owner, classMethod, source) {',"async function validateMethodImp(get, imp) {\n  if (imp == null || typeof get.isExecutableAddress !== 'function') return { known:false, valid:imp != null };\n  try { return { known:true, valid:!!(await get.isExecutableAddress(BigInt(imp))) }; } catch { return { known:true, valid:false }; }\n}\n\nasync function methodList(get, listAddr, owner, classMethod, source) {")
rep('js/apple/objc-metadata.js',"""    const sel = await cstring(get, nameAddr);
    if (!sel) { invalidEntries++; continue; }
    items.push({ sel, selector: sel, types: await cstring(get, typeAddr), addr: imp, imp, className: owner || null, classMethod: !!classMethod, source, kind: classMethod ? '+' : '-', name: owner ? `${classMethod ? '+' : '-'}[${owner} ${sel}]` : sel });""","""    const rawImp = imp;
    const impProof = source.startsWith('protocol') ? { known:true, valid:false } : await validateMethodImp(get, imp);
    if (!source.startsWith('protocol') && impProof.known && !impProof.valid) { invalidEntries++; imp = null; }
    const sel = await cstring(get, nameAddr);
    if (!sel) { invalidEntries++; continue; }
    items.push({ sel, selector: sel, types: await cstring(get, typeAddr), addr: imp, imp, rawImp, implementationVerified:source.startsWith('protocol')?false:(impProof.known?impProof.valid:undefined), className: owner || null, classMethod: !!classMethod, source, kind: classMethod ? '+' : '-', name: owner ? `${classMethod ? '+' : '-'}[${owner} ${sel}]` : sel });""")
rep('js/apple/objc-metadata.js','  get.resolvePointer = opts.resolvePointer || opts.binaryImage?.resolvePointer || opts.binaryImage?.decodePointer || null;\n  const classByAddress','  get.resolvePointer = opts.resolvePointer || opts.binaryImage?.resolvePointer || opts.binaryImage?.decodePointer || null;\n  get.isExecutableAddress = opts.isExecutableAddress || null;\n  const classByAddress')
rep('js/objc.js','  const base = await buildLegacyObjcModel(read, classList, onProgress, imageBase, effectivePointerFormat);',"  const isExecutableAddress = typeof runtimeSections?.isExecutableAddress === 'function' ? runtimeSections.isExecutableAddress : null;\n  const base = await buildLegacyObjcModel(read, classList, onProgress, imageBase, effectivePointerFormat, { isExecutableAddress });")
rep('js/objc.js','    resolvePointer,\n  });','    resolvePointer,\n    isExecutableAddress,\n  });')
rep('js/app.js','const model = await buildObjcRuntimeModel(read, list, { protocolList, categoryList }, null, imageBase);','const model = await buildObjcRuntimeModel(read, list, { protocolList, categoryList, isExecutableAddress:(addr)=>!!this.executableRegionFor(addr) }, null, imageBase);')

# #2388: bounded, range-checked compact unwind; partial input cannot publish exact function evidence.
MACHO = r'''function parseCompactUnwind(r, image, metadataBudget = null) {
  const sec = image.sections.find((s) => s.name === '__unwind_info' || s.name === '__TEXT,__unwind_info');
  if (!sec || sec.fileOffset == null || sec.fileSize == null || sec.fileSize < 28n) return;
  const budget = ensureMachOMetadataBudget(image, metadataBudget);
  const status = image.metadata.compactUnwind = { present:true, complete:true, recovered:0, partialReasons:[] };
  const partial = (reason, warning = null) => {
    status.complete = false;
    if (!status.partialReasons.includes(reason)) status.partialReasons.push(reason);
    markMachOMetadataPartial(image, `compact-unwind:${reason}`);
    if (warning) image.warnings.push(warning);
  };
  const fileOff = Number(sec.fileOffset), fileSize = Number(sec.fileSize);
  if (!Number.isSafeInteger(fileOff) || !Number.isSafeInteger(fileSize) || fileOff < 0 || fileSize < 28 || fileOff > r.length || fileSize > r.length - fileOff) { partial('section-range'); return; }
  const version = r.u32(fileOff);
  if (version !== 1) { partial('unsupported-version'); return; }
  const indexOff = r.u32(fileOff + 20), indexCount = r.u32(fileOff + 24);
  if (indexCount < 2 || indexOff > fileSize || indexCount > Math.floor((fileSize - indexOff) / 12)) { partial('index-range'); return; }
  const textSeg = image.segments.find((s) => s.name === '__TEXT');
  const imageBase = textSeg ? textSeg.address : (image.segments[0] ? image.segments[0].address : 0n);
  const alignment = (image.arch === 'arm64' || image.arch === 'arm64e' || image.arch === 'arm64_32') ? 4n : image.arch === 'arm' ? 2n : 1n;
  const functionAddresses = new Set();
  for (let i = 0; i + 1 < indexCount; i++) {
    if (!budget.take({ records:1, operations:2, estimatedHeapBytes:64 }, 'compact-unwind-page')) { partial('metadata-budget'); break; }
    const e = fileOff + indexOff + i * 12, next = e + 12;
    const rangeStart = r.u32(e), rangeEnd = r.u32(next), pageOff = r.u32(e + 4);
    if (rangeEnd <= rangeStart) { partial('first-level-range'); continue; }
    if (!pageOff || pageOff > fileSize - 8) { partial('page-range'); continue; }
    const pageAbs = fileOff + pageOff, kind = r.u32(pageAbs), entryOff = r.u16(pageAbs + 4), count = r.u16(pageAbs + 6);
    const entrySize = kind === 2 ? 8 : kind === 3 ? 4 : 0;
    if (!entrySize) { partial('page-kind'); continue; }
    if (entryOff < 8 || entryOff > fileSize - pageOff || count > Math.floor((fileSize - pageOff - entryOff) / entrySize)) { partial('entry-range'); continue; }
    for (let k = 0; k < count; k++) {
      if (!budget.take({ inputBytes:entrySize, records:1, operations:2, estimatedHeapBytes:48 }, 'compact-unwind-entry')) { partial('metadata-budget'); break; }
      const p = pageAbs + entryOff + k * entrySize;
      const funcOff = kind === 2 ? r.u32(p) : rangeStart + (r.u32(p) & 0x00ffffff);
      if (funcOff < rangeStart || funcOff >= rangeEnd) { partial('function-outside-first-level-range'); continue; }
      const addr = imageBase + BigInt(funcOff), seg = image.segmentAt(addr);
      if (!seg?.perms?.execute || (alignment > 1n && addr % alignment !== 0n)) { partial('function-not-executable'); continue; }
      functionAddresses.add(addr);
    }
    if (!status.complete && status.partialReasons.includes('metadata-budget')) break;
  }
  if (!status.complete) return;
  const sortedAddresses=[...functionAddresses].sort((a,b)=>(a<b?-1:a>b?1:0));
  for(let i=0;i<sortedAddresses.length;i++){
    const start=sortedAddresses[i],end=sortedAddresses[i+1]??null,sizeBytes=end!=null?Number(end-start):null;
    image.unwindEntries.push({start,end,sizeBytes,primary:true,source:'compact-unwind'});
    image.functions.push(functionSeed(start,{source:'unwind',confidence:0.95}));
    status.recovered++;
  }
}
'''
s=read('js/binary/macho-core.js'); marker='function parseCompactUnwind(r, image, metadataBudget = null) {'; a=s.find(marker)
if a<0: raise SystemExit('compact unwind marker missing')
write('js/binary/macho-core.js',s[:a]+MACHO)

# Regression tests.
Path('tests/unlinked-swift-runtime.test.mjs').write_text(r'''import assert from 'node:assert/strict';
import { buildSwiftMetadataModel, buildSwiftRuntimeIndex, resolveSwiftDispatch } from '../js/swift.js';
const mem=new Uint8Array(0x5000),dv=new DataView(mem.buffer);const u32=(a,v)=>dv.setUint32(a,Number(v)>>>0,true),i32=(a,v)=>dv.setInt32(a,Number(v),true),u64=(a,v)=>dv.setBigUint64(a,BigInt(v),true);const str=(a,s)=>{for(let i=0;i<s.length;i++)mem[a+i]=s.charCodeAt(i);mem[a+s.length]=0;};const rel=(f,t)=>i32(f,t-f);const read=async(addr,len)=>{const a=Number(addr);return a>=0&&a<mem.length?mem.subarray(a,Math.min(mem.length,a+len)):null;};
u32(0x500,0);rel(0x508,0x580);str(0x580,'ModA');u32(0x600,0);rel(0x608,0x680);str(0x680,'ModB');
function cls(at,parent,nameAt,vt){u32(at,16|(vt?0x80000000:0));rel(at+4,parent);rel(at+8,nameAt);i32(at+12,0);i32(at+16,0);for(let o=20;o<44;o+=4)u32(at+o,0);}cls(0x1000,0x500,0x1800,true);str(0x1800,'Worker');cls(0x1200,0x600,0x1820,false);str(0x1820,'Worker');u32(0x102c,0);u32(0x1030,1);u32(0x1034,0x11);rel(0x1038,0x3000);
u32(0x1400,3);rel(0x1404,0x500);rel(0x1408,0x1840);u32(0x140c,0);u32(0x1410,1);i32(0x1414,0);str(0x1840,'Damageable');rel(0x1600,0x1400);rel(0x1604,0x1000);rel(0x1608,0x3400);u32(0x160c,0);u64(0x3400,0x3100n);rel(0x100,0x1000);rel(0x104,0x1200);rel(0x108,0x1400);rel(0x10c,0x1600);
const sections=[{section:'__swift5_types',vmAddr:0x100n,size:8n},{section:'__swift5_protos',vmAddr:0x108n,size:4n},{section:'__swift5_proto',vmAddr:0x10cn,size:4n}],opts={budget:100,allowRawPointers:true,isExecutableAddress:(a)=>a>=0x3000n&&a<0x3200n};
const model=await buildSwiftMetadataModel(read,sections,opts);assert.equal(model.complete,true);assert.equal(model.types[0].qualifiedName,'ModA.Worker');assert.equal(model.types[1].qualifiedName,'ModB.Worker');assert.equal(model.vtables[0].methods[0].impl,0x3000n);assert.equal(model.witnessTables[0].entries[0].target,0x3100n);const index=buildSwiftRuntimeIndex(model);assert.equal(resolveSwiftDispatch(index,{kind:'vtable',typeName:'Worker',slot:0}).resolved,null);assert.equal(resolveSwiftDispatch(index,{kind:'vtable',typeName:'ModA.Worker',slot:0}).resolved?.impl,0x3000n);assert.equal(resolveSwiftDispatch(index,{kind:'witness',typeName:'ModA.Worker',protocolName:'ModA.Damageable',slot:0}).resolved?.target,0x3100n);const partial=await buildSwiftMetadataModel(read,sections,{...opts,budget:1});assert.equal(partial.complete,false);assert.equal(resolveSwiftDispatch(buildSwiftRuntimeIndex(partial),{kind:'vtable',typeName:'ModA.Worker',slot:99}).complete,false);
''')
Path('tests/unlinked-runtime-hardening.test.mjs').write_text(r'''import assert from 'node:assert/strict';
import { WIRE_TAG, BIGINT_TAG, decodeWireValue } from '../js/debug/remote-protocol.js';
import { parseObjcExtendedMetadata } from '../js/objc.js';
assert.equal(decodeWireValue({[WIRE_TAG]:BIGINT_TAG,value:'123'}),123n);assert.throws(()=>decodeWireValue({[WIRE_TAG]:BIGINT_TAG,value:123}),/invalid bigint wire value/);
const mem=new Uint8Array(0x4000),dv=new DataView(mem.buffer),p64=(a,v)=>dv.setBigUint64(a,BigInt(v),true),p32=(a,v)=>dv.setUint32(a,Number(v)>>>0,true),str=(a,s)=>{for(let i=0;i<s.length;i++)mem[a+i]=s.charCodeAt(i);mem[a+s.length]=0;};const read=async(addr,len)=>{const a=Number(addr);return a>=0&&a<mem.length?mem.subarray(a,Math.min(mem.length,a+len)):null;};p64(0x200,0x1200);p64(0x1200,0x1860);p64(0x1208,0x2000);p64(0x1210,0x1300);str(0x1860,'Debug');p32(0x1300,24);p32(0x1304,1);p64(0x1308,0x1880);p64(0x1310,0x18a0);p64(0x1318,0x3000);str(0x1880,'debugName');str(0x18a0,'@16@0:8');const parsed=await parseObjcExtendedMetadata(read,{categoryList:{vmAddr:0x200n,size:8n}},{classes:[{name:'PlayerData',addr:0x2000n}],isExecutableAddress:(a)=>a!==0x3000n});assert.equal(parsed.categories[0].methods[0].imp,null);assert.equal(parsed.categories[0].methods[0].rawImp,0x3000n);assert.equal(parsed.categories[0].methods[0].implementationVerified,false);assert.equal(parsed.completeness.complete,false);
''')
Path('tests/unlinked-macho-compact-unwind.test.mjs').write_text(r'''import assert from 'node:assert/strict';import { parseMachO } from '../js/binary/macho.js';
function fixture(func=0x400){const buf=new Uint8Array(1024),dv=new DataView(buf.buffer);dv.setUint32(0,0xfeedfacf,true);dv.setUint32(4,0x0100000c,true);dv.setUint32(12,2,true);dv.setUint32(16,1,true);dv.setUint32(20,152,true);dv.setUint32(32,0x19,true);dv.setUint32(36,152,true);for(let i=0;i<6;i++)dv.setUint8(40+i,'__TEXT'.charCodeAt(i));dv.setBigUint64(56,0x100000000n,true);dv.setBigUint64(64,0x1000n,true);dv.setBigUint64(72,0n,true);dv.setBigUint64(80,1024n,true);dv.setUint32(88,5,true);dv.setUint32(92,5,true);dv.setUint32(96,1,true);for(let i=0;i<13;i++)dv.setUint8(104+i,'__unwind_info'.charCodeAt(i));for(let i=0;i<6;i++)dv.setUint8(120+i,'__TEXT'.charCodeAt(i));dv.setBigUint64(136,0x100000200n,true);dv.setBigUint64(144,128n,true);dv.setUint32(152,0x200,true);dv.setUint32(156,2,true);const u=512;dv.setUint32(u,1,true);dv.setUint32(u+20,32,true);dv.setUint32(u+24,2,true);dv.setUint32(u+32,0x400,true);dv.setUint32(u+36,64,true);dv.setUint32(u+44,0x500,true);const p=u+64;dv.setUint32(p,2,true);dv.setUint16(p+4,8,true);dv.setUint16(p+6,1,true);dv.setUint32(p+8,func,true);return buf;}
const good=parseMachO(fixture());assert.equal(good.metadata.compactUnwind.complete,true);assert.equal(good.unwindEntries.length,1);assert.equal(good.functions.some((f)=>f.source==='unwind'),true);const bad=parseMachO(fixture(0x600));assert.equal(bad.metadata.compactUnwind.complete,false);assert.equal(bad.unwindEntries.length,0);assert.equal(bad.functions.some((f)=>f.source==='unwind'),false);
''')